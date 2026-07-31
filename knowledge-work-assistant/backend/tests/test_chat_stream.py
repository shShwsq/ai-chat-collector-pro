from __future__ import annotations

from types import SimpleNamespace

from app.routers import chat
from app.services.llm_request_registry import llm_request_registry


class _ErrorThenDoneAgent:
    llm_client = SimpleNamespace(api_key="test-key", base_url="https://llm.test")

    async def chat_stream(self, *args, **kwargs):
        yield {"type": "error", "message": "LLM 调用失败"}
        yield {"type": "done"}


async def test_llm_error_followed_by_done_keeps_request_failed(monkeypatch) -> None:
    """MainAgent 用 done 结束错误事件流时，不得把 failed 覆盖为 completed。"""
    await llm_request_registry.clear()
    request_id = await llm_request_registry.register("chat")
    pushed_events: list[dict[str, object]] = []

    async def capture_event(_session_id: str, event: dict[str, object]) -> None:
        pushed_events.append(event)

    monkeypatch.setattr(chat, "_push_ws", capture_event)

    await chat._run_chat_stream(
        agent=_ErrorThenDoneAgent(),
        session_id="chat-session",
        ws_session_id="ws-session",
        request_id=request_id,
        user_message="测试错误状态",
        plan_mode=False,
        graph_id=None,
        mode="work",
    )

    request = await llm_request_registry.get(request_id)
    assert request is not None
    assert request.status == "failed"
    assert request.error == "LLM 调用失败"
    assert [event["type"] for event in pushed_events] == [
        "graph_agent_error",
        "graph_agent_done",
    ]

    await llm_request_registry.clear()
