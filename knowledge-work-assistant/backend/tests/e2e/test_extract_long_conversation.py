"""端到端验证 Issue #9 修复：长对话分块抽取 + 合并去重。

通过 mock store + LLM 客户端，模拟一条 12000 字符的长对话，让 LLM 在
两个分块里分别返回有重叠的同义节点（"乘法" vs "乘法运算"），验证：
1. 触发分块（truncated=True, segment_count>1）
2. 同义节点跨块去重（merge 后只剩一个）
3. 已有节点标题被注入 prompt（同义归一提示出现）
4. 短对话走原路径（truncated=False, segment_count=1）
5. LLM 不可用降级返回空 nodes 且字段完整
6. 观察不存在降级
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services import graph_agent as ga_module
from app.services.graph_agent import GraphAgent


@pytest.mark.asyncio
async def test_long_conversation_chunked_and_merged(monkeypatch: pytest.MonkeyPatch) -> None:
    """长对话分块抽取，跨块同义节点去重，已有节点标题注入 prompt。"""
    agent = GraphAgent(store=MagicMock())

    # 12000 字符的长对话，超过 _CONVERSATION_CHUNK_SIZE(6000)
    long_conv = "用户：讲讲乘法\n" + "x" * 11900
    agent.store.get_observation = AsyncMock(
        return_value={
            "id": "obs1",
            "conversation_markdown": long_conv,
            "graph_id": "g1",
        }
    )
    agent.store.list_nodes = AsyncMock(
        return_value=[{"title": "已有节点A"}, {"title": "已有节点B"}]
    )

    # 拦截 _get_llm_client 返回哨兵 client
    sentinel_client = MagicMock(name="LLMClient")
    monkeypatch.setattr(
        agent, "_get_llm_client", AsyncMock(return_value=sentinel_client)
    )

    # 拦截 _call_llm_json：记录每次调用的 prompt，分块返回不同节点
    call_log: list[str] = []

    async def fake_call_llm_json(client, system_prompt, user_prompt, **kwargs):
        call_log.append(system_prompt + "\n---\n" + user_prompt)
        # 第 1 块返回 "乘法" + "加法"；第 2 块返回 "乘法运算"（同义）+ "减法"
        if len(call_log) == 1:
            return {
                "nodes": [
                    {"title": "乘法", "summary": "s1", "type": "general",
                     "detail_payload": {}, "confidence": 0.9, "source_reason": "r"},
                    {"title": "加法", "summary": "s2", "type": "general",
                     "detail_payload": {}, "confidence": 0.8, "source_reason": "r"},
                ]
            }
        return {
            "nodes": [
                {"title": "乘法运算", "summary": "s3", "type": "general",
                 "detail_payload": {}, "confidence": 0.85, "source_reason": "r"},
                {"title": "减法", "summary": "s4", "type": "general",
                 "detail_payload": {}, "confidence": 0.7, "source_reason": "r"},
            ]
        }

    monkeypatch.setattr(agent, "_call_llm_json", fake_call_llm_json)

    # 拦截 llm_request_registry.register（避免真实 DB）
    monkeypatch.setattr(
        ga_module.llm_request_registry,
        "register",
        AsyncMock(return_value="req-id"),
    )

    result = await agent.extract_nodes_from_observation("obs1", "study")

    # 1. 返回结构完整
    assert isinstance(result, dict)
    assert set(result.keys()) == {
        "nodes", "count", "truncated", "segment_count", "original_length"
    }

    # 2. 长对话触发分块
    assert result["truncated"] is True
    assert result["segment_count"] >= 2
    assert result["original_length"] == len(long_conv)

    # 3. 同义节点去重："乘法" 与 "乘法运算" 应合并为 1 个
    titles = [n["title"] for n in result["nodes"]]
    assert "乘法" in titles
    assert "乘法运算" not in titles  # 后块的同义版本被丢弃
    assert "加法" in titles
    assert "减法" in titles
    assert result["count"] == 3

    # 4. 已有节点标题被注入 prompt（同义归一提示出现）
    assert any("已有节点A" in p for p in call_log), "已有节点标题未注入 prompt"

    # 5. 分块上下文提示出现（第 2 块的 prompt 应含"第 2/"字样）
    assert any("第 2/" in p for p in call_log), "分块上下文提示未注入"


@pytest.mark.asyncio
async def test_short_conversation_single_chunk(monkeypatch: pytest.MonkeyPatch) -> None:
    """短对话走原路径：单块、truncated=False、segment_count=1。"""
    agent = GraphAgent(store=MagicMock())
    short_conv = "用户：讲讲乘法\n助手：乘法是基础运算。"
    agent.store.get_observation = AsyncMock(
        return_value={
            "id": "obs2",
            "conversation_markdown": short_conv,
            "graph_id": "g2",
        }
    )
    agent.store.list_nodes = AsyncMock(return_value=[])

    sentinel_client = MagicMock(name="LLMClient")
    monkeypatch.setattr(
        agent, "_get_llm_client", AsyncMock(return_value=sentinel_client)
    )

    call_count = 0

    async def fake_call_llm_json(client, system_prompt, user_prompt, **kwargs):
        nonlocal call_count
        call_count += 1
        return {"nodes": [{"title": "乘法", "type": "general"}]}

    monkeypatch.setattr(agent, "_call_llm_json", fake_call_llm_json)
    monkeypatch.setattr(
        ga_module.llm_request_registry,
        "register",
        AsyncMock(return_value="req-id"),
    )

    result = await agent.extract_nodes_from_observation("obs2", "study")

    assert result["truncated"] is False
    assert result["segment_count"] == 1
    assert result["count"] == 1
    assert call_count == 1  # 只调用一次 LLM


@pytest.mark.asyncio
async def test_llm_unavailable_degrades_gracefully(monkeypatch: pytest.MonkeyPatch) -> None:
    """LLM 不可用时降级返回空 nodes，字段完整。"""
    agent = GraphAgent(store=MagicMock())
    agent.store.get_observation = AsyncMock(
        return_value={
            "id": "obs3",
            "conversation_markdown": "x" * 100,
            "graph_id": "g3",
        }
    )
    agent.store.list_nodes = AsyncMock(return_value=[])
    monkeypatch.setattr(agent, "_get_llm_client", AsyncMock(return_value=None))

    result = await agent.extract_nodes_from_observation("obs3", "study")

    assert result["nodes"] == []
    assert result["count"] == 0
    assert result["truncated"] is False
    assert result["segment_count"] == 0
    assert result["original_length"] == 100


@pytest.mark.asyncio
async def test_observation_not_found_degrades() -> None:
    """观察记录不存在时降级返回空结构。"""
    agent = GraphAgent(store=MagicMock())
    agent.store.get_observation = AsyncMock(return_value=None)

    result = await agent.extract_nodes_from_observation("missing", "study")

    assert result == {
        "nodes": [],
        "count": 0,
        "truncated": False,
        "segment_count": 0,
        "original_length": 0,
    }


@pytest.mark.asyncio
async def test_empty_conversation_degrades() -> None:
    """对话内容为空时降级。"""
    agent = GraphAgent(store=MagicMock())
    agent.store.get_observation = AsyncMock(
        return_value={"id": "obs4", "conversation_markdown": "  \n  ", "graph_id": "g4"}
    )

    result = await agent.extract_nodes_from_observation("obs4", "study")

    assert result["nodes"] == []
    assert result["count"] == 0
    assert result["original_length"] == 5  # "  \n  " 的长度


@pytest.mark.asyncio
async def test_list_nodes_failure_does_not_break_extraction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """store.list_nodes 抛异常时不影响主流程（existing_titles 降级为空）。"""
    agent = GraphAgent(store=MagicMock())
    agent.store.get_observation = AsyncMock(
        return_value={
            "id": "obs5",
            "conversation_markdown": "x" * 100,
            "graph_id": "g5",
        }
    )
    agent.store.list_nodes = AsyncMock(side_effect=RuntimeError("db down"))

    sentinel_client = MagicMock(name="LLMClient")
    monkeypatch.setattr(
        agent, "_get_llm_client", AsyncMock(return_value=sentinel_client)
    )
    monkeypatch.setattr(
        agent,
        "_call_llm_json",
        AsyncMock(return_value={"nodes": [{"title": "N", "type": "general"}]}),
    )
    monkeypatch.setattr(
        ga_module.llm_request_registry,
        "register",
        AsyncMock(return_value="req-id"),
    )

    result = await agent.extract_nodes_from_observation("obs5", "study")

    # list_nodes 失败但抽取仍完成
    assert result["count"] == 1
    assert result["nodes"][0]["title"] == "N"
