"""LLM 会话标题生成回归测试。

覆盖以下行为：

1. ``test_first_message_falls_back_to_truncated_then_llm_title``：首条用户消息
   先用截断文本作兜底标题，后台 LLM 生成精炼标题（≤20 字）后覆盖。
2. ``test_llm_title_failure_keeps_truncated_fallback``：LLM 调用失败时静默降级，
   保留截断兜底标题。
3. ``test_second_message_does_not_touch_title``：非首条消息不触发标题更新。
"""

from __future__ import annotations

import asyncio
import importlib
from unittest.mock import AsyncMock, MagicMock

from app.models.db_models import Message as MessageRow
from app.models.db_models import Session as SessionRow
from app.services.main_agent import MainAgent


def _db_session():
    """动态获取 AsyncSessionLocal（tmp_db 会 monkeypatch app.db 模块属性）。

    注意：不能在模块顶部 ``from app.db import AsyncSessionLocal`` 绑定名字，
    否则拿到的是 monkeypatch 前的真实 DB 工厂。
    """
    db_module = importlib.import_module("app.db")
    return db_module.AsyncSessionLocal()


def _make_llm_client(
    content: str | None = None, *, raise_error: bool = False
) -> MagicMock:
    client = MagicMock(name="MockLLMClient")
    client.model = "mock-model"
    client.default_temperature = 0.7
    client.max_output_tokens = 4096
    if raise_error:
        client.chat = AsyncMock(side_effect=RuntimeError("LLM down"))
    else:
        client.chat = AsyncMock(return_value={"content": content})
    return client


def _make_agent(client: MagicMock, session_id: str = "title-session") -> MainAgent:
    return MainAgent(session_id=session_id, llm_client=client)


async def _create_session(session_id: str, title: str = "work 对话 时间") -> None:
    async with _db_session() as db:
        db.add(SessionRow(id=session_id, title=title, mode="work"))
        await db.commit()


async def _get_title(session_id: str) -> str:
    async with _db_session() as db:
        row = await db.get(SessionRow, session_id)
        return row.title if row else ""


async def _drain_title_tasks(agent: MainAgent) -> None:
    """等待后台标题生成任务完成（不依赖 done_callback 移除集合）。"""
    tasks = list(agent._title_tasks)
    if tasks:
        await asyncio.gather(*tasks)


async def test_first_message_falls_back_to_truncated_then_llm_title(
    tmp_db,
) -> None:
    """首条消息：先落兜底截断标题，后台 LLM 生成后覆盖为精炼标题。"""
    client = _make_llm_client(content="「知识图谱入门」")
    agent = _make_agent(client)
    await _create_session(agent.session_id)

    first_text = (
        "什么是知识图谱？请用通俗的语言解释一下图谱的构建原理和应用场景，"
        "以及它和 RAG 检索增强生成的关系，最好再举一个具体的例子。"
    )
    saved = await agent._save_user_message(first_text, None)
    assert saved is True

    # 兜底标题：截断 40 字符 + 省略号
    truncated = first_text.strip().replace("\n", " ")[:40]
    assert await _get_title(agent.session_id) == truncated + "…"

    # 后台 LLM 标题生成完成（去引号、≤20 字）
    await _drain_title_tasks(agent)
    assert await _get_title(agent.session_id) == "知识图谱入门"


async def test_llm_title_failure_keeps_truncated_fallback(tmp_db) -> None:
    """LLM 不可用时标题生成静默降级，保留截断兜底标题。"""
    client = _make_llm_client(raise_error=True)
    agent = _make_agent(client)
    await _create_session(agent.session_id)

    first_text = "帮我分析一下这个项目"
    await agent._save_user_message(first_text, None)
    await _drain_title_tasks(agent)

    assert await _get_title(agent.session_id) == first_text


async def test_llm_empty_output_keeps_fallback(tmp_db) -> None:
    """LLM 返回空标题时保留兜底截断标题。"""
    client = _make_llm_client(content="  \n  ")
    agent = _make_agent(client)
    await _create_session(agent.session_id)

    first_text = "一句话测试"
    await agent._save_user_message(first_text, None)
    await _drain_title_tasks(agent)

    assert await _get_title(agent.session_id) == first_text


async def test_second_message_does_not_touch_title(tmp_db) -> None:
    """非首条消息不触发标题更新，保留已有标题。"""
    client = _make_llm_client(content="不应使用的标题")
    agent = _make_agent(client)
    await _create_session(agent.session_id, title="已有标题")

    # 预置一条 user 消息（模拟已存在对话历史）
    async with _db_session() as db:
        db.add(
            MessageRow(
                id="m1",
                session_id=agent.session_id,
                role="user",
                content="先前内容",
            )
        )
        await db.commit()

    await agent._save_user_message("新的提问", None)
    # 非首条消息不应创建标题生成任务
    assert agent._title_tasks == set()
    assert await _get_title(agent.session_id) == "已有标题"
