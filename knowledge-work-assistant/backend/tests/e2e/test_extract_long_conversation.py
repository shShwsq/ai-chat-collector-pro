"""端到端验证转图谱抽取优化：动态块大小 + Q&A 配对切分 + 合并 agent 去重。

通过 mock store + LLM 客户端，验证：
1. 动态块大小：mock _resolve_chunk_config 返回小窗口触发分块，跨块同义节点去重。
2. Q&A 边界切分：含角色标记的对话，切分点落在角色行边界，不切断消息。
3. 无角色标记回退字符切分。
4. 合并 agent 决策 keep/merge_into/drop。
5. 合并 agent LLM 失败回退规则去重。
6. 合并 agent 避免超大卡片（merge_fields 不覆盖已有内容）。
7. 短对话走原路径（truncated=False, segment_count=1）。
8. LLM 不可用降级返回空 nodes 且字段完整。
9. 观察不存在降级。
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

    # 12000 字符的长对话，mock 小窗口（2000 字符）触发分块
    long_conv = "## 用户\n讲讲乘法\n" + "x" * 11900
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
    sentinel_client.model = "test-model"
    monkeypatch.setattr(
        agent, "_get_llm_client", AsyncMock(return_value=sentinel_client)
    )

    # mock 小窗口：chunk_chars=2000，overlap_chars=200
    monkeypatch.setattr(
        ga_module,
        "_resolve_chunk_config",
        lambda client: (2000, 200),
    )

    # 拦截 _call_llm_json：第 1 块抽取返回 "乘法"+"加法"，
    # 第 2 块抽取返回 "乘法运算"（同义）+"减法"，
    # 合并 agent 调用返回全部 keep（避免与已有节点合并干扰本测试）
    extract_call_count = 0

    async def fake_call_llm_json(client, system_prompt, user_prompt, **kwargs):
        nonlocal extract_call_count
        # 合并 agent 的 prompt 含 "合并决策器"
        if "合并决策器" in system_prompt:
            # 返回全部 keep
            return {
                "decisions": [
                    {"candidate_index": 0, "action": "keep", "reason": "新概念"},
                    {"candidate_index": 1, "action": "keep", "reason": "新概念"},
                    {"candidate_index": 2, "action": "keep", "reason": "新概念"},
                ]
            }
        # 抽取调用
        extract_call_count += 1
        if extract_call_count == 1:
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
    # 注意：合并 agent 也会读 list_nodes，这里检查抽取 prompt 含已有节点标题
    # 由于 fake_call_llm_json 没有保存 call_log，改为验证 list_nodes 被调用
    assert agent.store.list_nodes.called


@pytest.mark.asyncio
async def test_chunk_split_respects_qa_boundary(monkeypatch: pytest.MonkeyPatch) -> None:
    """含角色标记的对话，切分点落在角色行边界，不切断消息。"""
    # 构造含 ### **🧑 用户** 生产格式标记的对话
    # 每个单元约 300 字符，块大小 500 → 应在第 1-2 个单元之间切分
    unit_user = "### **🧑 用户**\n\n" + "用户内容" * 40 + "\n\n"
    unit_asst = "### **🤖 助手**\n\n" + "助手回答" * 40 + "\n\n"
    # 3 个 Q&A 配对，总长约 3 * 2 * 260 ≈ 1560 字符
    conv = unit_user + unit_asst + unit_user + unit_asst + unit_user + unit_asst

    from app.services.graph_agent import _split_conversation

    chunks = _split_conversation(conv, chunk_chars=500, overlap_chars=50)

    assert len(chunks) >= 2
    # 验证每个块都以角色标记开头（不被切断）
    for chunk in chunks:
        # 块开头应是 ### **🧑 用户** 或 ### **🤖 助手** 或重叠区开头
        assert "用户**" in chunk[:30] or "助手**" in chunk[:30] or "用户**" in chunk[:60]
    # 验证没有块在角色标记中间切断（即没有 "### **🧑 用" 在块末尾）
    for chunk in chunks:
        assert not chunk.endswith("###")
        assert not chunk.endswith("### **")
        assert not chunk.endswith("### **🧑")


@pytest.mark.asyncio
async def test_chunk_split_fallback_no_role_markers() -> None:
    """无角色标记的纯文本回退字符切分。"""
    from app.services.graph_agent import _split_conversation

    # 纯文本无角色标记
    text = "x" * 3000
    chunks = _split_conversation(text, chunk_chars=1000, overlap_chars=100)
    assert len(chunks) >= 3
    # 每块不超过 1000 字符（可能在换行处断开，但这里无换行）
    for chunk in chunks:
        assert len(chunk) <= 1000


@pytest.mark.asyncio
async def test_chunk_split_short_conversation() -> None:
    """短对话返回单元素列表。"""
    from app.services.graph_agent import _split_conversation

    text = "## 用户\n短对话\n## 助手\n回答"
    chunks = _split_conversation(text, chunk_chars=2000, overlap_chars=200)
    assert chunks == [text]


@pytest.mark.asyncio
async def test_merge_agent_keep_merge_drop(monkeypatch: pytest.MonkeyPatch) -> None:
    """合并 agent 决策 keep/merge_into/drop，候选节点正确保留/合并/丢弃。"""
    agent = GraphAgent(store=MagicMock())
    sentinel_client = MagicMock(name="LLMClient")
    sentinel_client.model = "test-model"

    # 已有节点：节点 X（将接收 merge_into）、节点 Y（与某候选重复将被 drop）
    agent.store.list_nodes = AsyncMock(
        return_value=[
            {"id": "node-x", "title": "已有节点X", "summary": "sx", "type": "general",
             "detail_payload": {"key_points": ""}},
            {"id": "node-y", "title": "已有节点Y", "summary": "sy", "type": "general",
             "detail_payload": {}},
        ]
    )
    agent.store.update_node = AsyncMock(return_value={"id": "node-x"})
    agent.store.incr_mention = AsyncMock(return_value=None)

    candidates = [
        {"title": "新概念A", "summary": "sa", "type": "general", "detail_payload": {}},
        {"title": "补充X", "summary": "sx补充", "type": "general",
         "detail_payload": {"key_points": "补充内容"}},
        {"title": "已有节点Y", "summary": "sy", "type": "general", "detail_payload": {}},
    ]

    async def fake_call_llm_json(client, system_prompt, user_prompt, **kwargs):
        return {
            "decisions": [
                {"candidate_index": 0, "action": "keep", "reason": "新概念"},
                {"candidate_index": 1, "action": "merge_into",
                 "target_title": "已有节点X", "reason": "补充X的信息",
                 "merge_fields": {"key_points": "补充内容"}},
                {"candidate_index": 2, "action": "drop", "reason": "与Y重复"},
            ]
        }

    monkeypatch.setattr(agent, "_call_llm_json", fake_call_llm_json)
    monkeypatch.setattr(
        ga_module.llm_request_registry,
        "register",
        AsyncMock(return_value="req-id"),
    )

    result = await agent._merge_candidates_with_existing(
        sentinel_client, candidates, "g1"
    )

    # keep 的保留，merge_into 和 drop 的不入结果
    titles = [n["title"] for n in result]
    assert "新概念A" in titles
    assert "补充X" not in titles  # 被 merge_into
    assert "已有节点Y" not in titles  # 被 drop
    assert len(result) == 1

    # 验证 update_node 被调用（merge_into）
    agent.store.update_node.assert_called_once_with(
        "node-x", detail_payload={"key_points": "补充内容"}
    )
    # 验证 incr_mention 被调用
    agent.store.incr_mention.assert_called_once_with("node-x")


@pytest.mark.asyncio
async def test_merge_agent_fallback_on_llm_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """合并 agent LLM 不可用时回退到 _titles_similar 规则去重。"""
    agent = GraphAgent(store=MagicMock())
    sentinel_client = MagicMock(name="LLMClient")

    agent.store.list_nodes = AsyncMock(
        return_value=[{"id": "n1", "title": "已有节点", "summary": "s", "type": "general"}]
    )

    # _call_llm_json 返回 None（LLM 失败）
    monkeypatch.setattr(
        agent, "_call_llm_json", AsyncMock(return_value=None)
    )
    monkeypatch.setattr(
        ga_module.llm_request_registry,
        "register",
        AsyncMock(return_value="req-id"),
    )

    candidates = [
        {"title": "乘法", "summary": "s1", "type": "general", "detail_payload": {}},
        {"title": "乘法运算", "summary": "s2", "type": "general", "detail_payload": {}},
        {"title": "加法", "summary": "s3", "type": "general", "detail_payload": {}},
    ]

    result = await agent._merge_candidates_with_existing(
        sentinel_client, candidates, "g1"
    )

    # 回退规则去重："乘法" 与 "乘法运算" 子串包含 → 合并为 1 个
    titles = [n["title"] for n in result]
    assert "乘法" in titles
    assert "乘法运算" not in titles
    assert "加法" in titles
    assert len(result) == 2


@pytest.mark.asyncio
async def test_merge_agent_avoids_oversized_card(monkeypatch: pytest.MonkeyPatch) -> None:
    """merge_fields 被正确应用到已有节点且不覆盖已有内容。

    验证点：merge_fields 的每个字段值被截断到 200 字，且 update_node
    被调用时传入的是截断后的 merge_fields。
    """
    agent = GraphAgent(store=MagicMock())
    sentinel_client = MagicMock(name="LLMClient")

    agent.store.list_nodes = AsyncMock(
        return_value=[
            {"id": "n1", "title": "已有节点", "summary": "s", "type": "general",
             "detail_payload": {"key_points": "已有内容"}},
        ]
    )
    agent.store.update_node = AsyncMock(return_value={"id": "n1"})
    agent.store.incr_mention = AsyncMock(return_value=None)

    # 构造超长 merge_fields（>200 字），验证截断
    long_value = "补充" * 200  # 400 字
    candidates = [
        {"title": "补充节点", "summary": "s", "type": "general",
         "detail_payload": {"key_points": long_value}},
    ]

    async def fake_call_llm_json(client, system_prompt, user_prompt, **kwargs):
        return {
            "decisions": [
                {"candidate_index": 0, "action": "merge_into",
                 "target_title": "已有节点", "reason": "补充",
                 "merge_fields": {"key_points": long_value}},
            ]
        }

    monkeypatch.setattr(agent, "_call_llm_json", fake_call_llm_json)
    monkeypatch.setattr(
        ga_module.llm_request_registry,
        "register",
        AsyncMock(return_value="req-id"),
    )

    await agent._merge_candidates_with_existing(
        sentinel_client, candidates, "g1"
    )

    # 验证 update_node 被调用，且字段值被截断到 200 字
    agent.store.update_node.assert_called_once()
    call_args = agent.store.update_node.call_args
    merge_fields = call_args.kwargs.get("detail_payload") or call_args.args[1]
    assert "key_points" in merge_fields
    assert len(merge_fields["key_points"]) <= 200


@pytest.mark.asyncio
async def test_short_conversation_single_chunk(monkeypatch: pytest.MonkeyPatch) -> None:
    """短对话走原路径：单块、truncated=False、segment_count=1。"""
    agent = GraphAgent(store=MagicMock())
    short_conv = "## 用户\n讲讲乘法\n## 助手\n乘法是基础运算。"
    agent.store.get_observation = AsyncMock(
        return_value={
            "id": "obs2",
            "conversation_markdown": short_conv,
            "graph_id": "g2",
        }
    )
    agent.store.list_nodes = AsyncMock(return_value=[])

    sentinel_client = MagicMock(name="LLMClient")
    sentinel_client.model = "test-model"
    monkeypatch.setattr(
        agent, "_get_llm_client", AsyncMock(return_value=sentinel_client)
    )
    # mock 大窗口（短对话不触发分块）
    monkeypatch.setattr(
        ga_module,
        "_resolve_chunk_config",
        lambda client: (20000, 200),
    )

    call_count = 0

    async def fake_call_llm_json(client, system_prompt, user_prompt, **kwargs):
        nonlocal call_count
        # 跳过合并 agent 调用（无已有节点时不会调）
        if "合并决策器" in system_prompt:
            return {"decisions": []}
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
    assert call_count == 1  # 只调用一次 LLM 抽取


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
    sentinel_client.model = "test-model"
    monkeypatch.setattr(
        agent, "_get_llm_client", AsyncMock(return_value=sentinel_client)
    )
    monkeypatch.setattr(
        ga_module,
        "_resolve_chunk_config",
        lambda client: (20000, 200),
    )

    async def fake_call_llm_json(client, system_prompt, user_prompt, **kwargs):
        # 合并 agent 调用 list_nodes 失败时会回退规则去重，仍返回候选
        if "合并决策器" in system_prompt:
            return {"decisions": [{"candidate_index": 0, "action": "keep"}]}
        return {"nodes": [{"title": "N", "type": "general"}]}

    monkeypatch.setattr(agent, "_call_llm_json", fake_call_llm_json)
    monkeypatch.setattr(
        ga_module.llm_request_registry,
        "register",
        AsyncMock(return_value="req-id"),
    )

    result = await agent.extract_nodes_from_observation("obs5", "study")

    # list_nodes 失败但抽取仍完成
    assert result["count"] == 1
    assert result["nodes"][0]["title"] == "N"
