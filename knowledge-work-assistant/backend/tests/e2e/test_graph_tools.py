"""``app.services.tools.graph_tools`` 单元测试（Task 7 + 本土化扩展）。

覆盖 21 个图谱工具的 handler 行为与模式白名单：

- 14 个新工具 handler（节点行为 / 学习闭环 / 智能推荐 / 工作对象 / 观察记录）
  每个覆盖：参数校验失败 / happy path / 底层异常兜底
- ``HIGH_RISK_TOOLS`` 集合包含 ``graph_confirm_work_objects``
- ``ALL_GRAPH_TOOLS`` / ``READONLY_GRAPH_TOOLS`` 计数正确
- ``get_tools_for_mode`` 4 种场景过滤正确
- ``register_graph_tools`` 向注册表注册 21 个工具

测试隔离
--------

- **不依赖 tmp_db**：工具 handler 内部通过 lazy import 调用
  ``graph_store`` / ``graph_agent``，本测试组直接 monkeypatch 模块级单例
  ``app.services.graph_store.graph_store`` 与
  ``app.services.graph_agent.graph_agent``，不发 SQL / LLM。
- **不依赖 mock_llm**：本测试组不触发真实 LLM 调用（费曼判分分支通过
  monkeypatch ``graph_agent.grade_feynman`` 替代）。
- **不依赖 async_client**：直接 await handler 函数，不走 HTTP。
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.tools.graph_tools import (
    ALL_GRAPH_TOOLS,
    HIGH_RISK_TOOLS,
    READONLY_GRAPH_TOOLS,
    _GRAPH_TOOL_DEFS,
    get_tools_for_mode,
    graph_add_user_fill,
    graph_answer_quiz,
    graph_clear_reminder,
    graph_confirm_work_objects,
    graph_extend_node,
    graph_extract_work_objects,
    graph_get_quiz_detail,
    graph_get_recommendations,
    graph_list_observations,
    graph_list_quiz_history,
    graph_set_reminder,
    graph_star_node,
    graph_touch_node,
    graph_unstar_node,
    register_graph_tools,
)


# ============================================================================
# 常量 / 断言
# ============================================================================


def test_total_tool_count_is_21() -> None:
    """_GRAPH_TOOL_DEFS 应包含 21 个工具定义。"""
    assert len(_GRAPH_TOOL_DEFS) == 21, (
        f"expected 21 graph tool defs, got {len(_GRAPH_TOOL_DEFS)}"
    )
    assert len(ALL_GRAPH_TOOLS) == 21
    # 只读工具 11 个：21 总数 - 10 个 build-only 写入/高风险工具
    # （graph_extend_node / graph_touch_node / graph_star_node / graph_unstar_node /
    #   graph_set_reminder / graph_clear_reminder / graph_answer_quiz /
    #   graph_add_user_fill / graph_extract_from_observation / graph_confirm_work_objects）
    assert len(READONLY_GRAPH_TOOLS) == 11


def test_high_risk_tools_set() -> None:
    """HIGH_RISK_TOOLS 应含 graph_extract_from_observation 与 graph_confirm_work_objects。"""
    assert HIGH_RISK_TOOLS == {
        "graph_extract_from_observation",
        "graph_confirm_work_objects",
    }


def test_get_tools_for_mode_study_returns_all() -> None:
    """Study 模式（plan/build）应暴露全部 21 个工具。"""
    assert len(get_tools_for_mode("study", True)) == 21
    assert len(get_tools_for_mode("study", False)) == 21


def test_get_tools_for_mode_work_build_returns_all() -> None:
    """Work Build 模式应暴露全部 21 个工具。"""
    assert len(get_tools_for_mode("work", False)) == 21


def test_get_tools_for_mode_work_plan_returns_readonly() -> None:
    """Work Plan 模式应仅暴露 11 个只读工具。"""
    tools = get_tools_for_mode("work", True)
    assert len(tools) == 11
    # 写入工具不在 Plan 白名单
    assert "graph_star_node" not in tools
    assert "graph_set_reminder" not in tools
    assert "graph_answer_quiz" not in tools
    assert "graph_confirm_work_objects" not in tools
    assert "graph_extract_from_observation" not in tools


def test_get_tools_for_mode_invalid_scenario_defaults_to_work() -> None:
    """无效 scenario_mode 应按 work 处理。"""
    assert get_tools_for_mode("invalid", False) == get_tools_for_mode("work", False)
    assert get_tools_for_mode("invalid", True) == get_tools_for_mode("work", True)


def test_register_graph_tools_registers_21() -> None:
    """register_graph_tools 应向 registry 注册 21 个工具。"""
    registry = MagicMock()
    register_graph_tools(registry)
    assert registry.register.call_count == 21


# ============================================================================
# 节点行为工具（6 个）
# ============================================================================


@pytest.mark.asyncio
async def test_graph_touch_node_missing_node_id() -> None:
    """缺 node_id 应返回 error。"""
    result = await graph_touch_node({})
    assert result["status"] == "error"
    assert "node_id is required" in result["message"]


@pytest.mark.asyncio
async def test_graph_touch_node_not_found(monkeypatch: pytest.MonkeyPatch) -> None:
    """底层返回 None 应映射为 not_found。"""
    mock_store = MagicMock()
    mock_store.touch_node = AsyncMock(return_value=None)
    monkeypatch.setattr(
        "app.services.graph_store.graph_store", mock_store, raising=False
    )
    # 同时 monkeypatch handler 内部的 lazy import 路径
    import app.services.tools.graph_tools as gt_mod

    monkeypatch.setattr(
        "app.services.graph_store.graph_store", mock_store
    )

    result = await graph_touch_node({"node_id": "node-1"})
    assert result["status"] == "not_found"
    assert result["node_id"] == "node-1"


@pytest.mark.asyncio
async def test_graph_touch_node_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    """happy path：返回 ok + node。"""
    mock_store = MagicMock()
    mock_store.touch_node = AsyncMock(
        return_value={"id": "node-1", "title": "React", "review_count": 2}
    )
    monkeypatch.setattr("app.services.graph_store.graph_store", mock_store)

    result = await graph_touch_node({"node_id": "node-1"})
    assert result["status"] == "ok"
    assert result["node"]["id"] == "node-1"
    assert result["node"]["review_count"] == 2


@pytest.mark.asyncio
async def test_graph_touch_node_exception(monkeypatch: pytest.MonkeyPatch) -> None:
    """底层异常应被捕获，返回 error 而非抛出。"""
    mock_store = MagicMock()
    mock_store.touch_node = AsyncMock(side_effect=RuntimeError("db down"))
    monkeypatch.setattr("app.services.graph_store.graph_store", mock_store)

    result = await graph_touch_node({"node_id": "node-1"})
    assert result["status"] == "error"
    assert "db down" in result["message"]


@pytest.mark.asyncio
async def test_graph_star_node_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    """graph_star_node happy path。"""
    mock_store = MagicMock()
    mock_store.set_star = AsyncMock(
        return_value={"id": "n1", "is_starred": True}
    )
    monkeypatch.setattr("app.services.graph_store.graph_store", mock_store)

    result = await graph_star_node({"node_id": "n1"})
    assert result["status"] == "ok"
    assert result["is_starred"] is True
    mock_store.set_star.assert_awaited_once_with("n1", True)


@pytest.mark.asyncio
async def test_graph_unstar_node_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    """graph_unstar_node happy path。"""
    mock_store = MagicMock()
    mock_store.set_star = AsyncMock(
        return_value={"id": "n1", "is_starred": False}
    )
    monkeypatch.setattr("app.services.graph_store.graph_store", mock_store)

    result = await graph_unstar_node({"node_id": "n1"})
    assert result["status"] == "ok"
    assert result["is_starred"] is False
    mock_store.set_star.assert_awaited_once_with("n1", False)


@pytest.mark.asyncio
async def test_graph_set_reminder_invalid_date(monkeypatch: pytest.MonkeyPatch) -> None:
    """非法日期格式应返回 error。"""
    result = await graph_set_reminder(
        {"node_id": "n1", "remind_at": "not-a-date"}
    )
    assert result["status"] == "error"
    assert "remind_at 格式无效" in result["message"]


@pytest.mark.asyncio
async def test_graph_set_reminder_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    """graph_set_reminder happy path。"""
    mock_store = MagicMock()
    mock_store.set_remind = AsyncMock(
        return_value={"id": "n1", "remind_at": "2026-08-01T10:00:00"}
    )
    monkeypatch.setattr("app.services.graph_store.graph_store", mock_store)

    result = await graph_set_reminder(
        {"node_id": "n1", "remind_at": "2026-08-01T10:00:00"}
    )
    assert result["status"] == "ok"
    assert result["node"]["remind_at"] == "2026-08-01T10:00:00"


@pytest.mark.asyncio
async def test_graph_clear_reminder_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    """graph_clear_reminder happy path。"""
    mock_store = MagicMock()
    mock_store.clear_remind = AsyncMock(
        return_value={"id": "n1", "remind_at": None}
    )
    monkeypatch.setattr("app.services.graph_store.graph_store", mock_store)

    result = await graph_clear_reminder({"node_id": "n1"})
    assert result["status"] == "ok"
    assert result["node"]["remind_at"] is None


@pytest.mark.asyncio
async def test_graph_extend_node_missing_args() -> None:
    """缺 graph_id / node_id 应返回 error。"""
    result = await graph_extend_node({"graph_id": ""})
    assert result["status"] == "error"
    assert "graph_id 与 node_id 均必填" in result["message"]


@pytest.mark.asyncio
async def test_graph_extend_node_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    """graph_extend_node happy path：候选落库 + existing_hit 命中。"""
    # mock graph_agent.generate_extensions
    mock_agent = MagicMock()
    mock_agent.generate_extensions = AsyncMock(
        return_value=[
            {"title": "Redux", "summary": "状态管理库", "type": "concept"},
            {"title": "Existing", "summary": "", "type": "concept"},
        ]
    )
    monkeypatch.setattr("app.services.graph_agent.graph_agent", mock_agent)

    # mock graph_store
    mock_store = MagicMock()
    mock_store.list_nodes = AsyncMock(
        return_value=[{"id": "ex-1", "title": "Existing"}]
    )
    mock_store.create_node = AsyncMock(
        return_value={"id": "new-1", "title": "Redux"}
    )
    mock_store.create_edge = AsyncMock(return_value={"id": "edge-1"})
    monkeypatch.setattr("app.services.graph_store.graph_store", mock_store)

    result = await graph_extend_node(
        {"graph_id": "g1", "node_id": "n1", "mode": "all"}
    )
    assert result["status"] == "ok"
    assert result["count"] == 1  # 只创建了 1 个（另一个命中 existing）
    assert len(result["existing_hit"]) == 1
    assert result["existing_hit"][0]["title"] == "Existing"


# ============================================================================
# 学习闭环工具（4 个）
# ============================================================================


@pytest.mark.asyncio
async def test_graph_answer_quiz_missing_args() -> None:
    """缺 quiz_id / answer 应返回 error。"""
    assert (await graph_answer_quiz({}))["status"] == "error"
    assert (await graph_answer_quiz({"quiz_id": "q1"}))["status"] == "error"


@pytest.mark.asyncio
async def test_graph_answer_quiz_not_found(monkeypatch: pytest.MonkeyPatch) -> None:
    """quiz 不存在返回 not_found。"""
    mock_store = MagicMock()
    mock_store.get_quiz = AsyncMock(return_value=None)
    monkeypatch.setattr("app.services.graph_store.graph_store", mock_store)

    result = await graph_answer_quiz({"quiz_id": "nope", "answer": ["A"]})
    assert result["status"] == "not_found"


@pytest.mark.asyncio
async def test_graph_answer_quiz_already_answered(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """已答测验不可重复作答。"""
    mock_store = MagicMock()
    mock_store.get_quiz = AsyncMock(
        return_value={"id": "q1", "answered": True, "type": "single_choice"}
    )
    monkeypatch.setattr("app.services.graph_store.graph_store", mock_store)

    result = await graph_answer_quiz({"quiz_id": "q1", "answer": ["A"]})
    assert result["status"] == "error"
    assert "不可重复作答" in result["message"]


@pytest.mark.asyncio
async def test_graph_answer_quiz_single_choice_correct(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """单选题正确作答：本地判分 + 落库。"""
    mock_store = MagicMock()
    mock_store.get_quiz = AsyncMock(
        return_value={
            "id": "q1",
            "answered": False,
            "type": "single_choice",
            "payload": {
                "correct_answers": ["A"],
                "explanation": "A 是正确的",
                "options": ["A", "B", "C"],
            },
        }
    )
    mock_store.update_quiz_result = AsyncMock(
        return_value={"id": "q1", "answered": True}
    )
    monkeypatch.setattr("app.services.graph_store.graph_store", mock_store)

    result = await graph_answer_quiz({"quiz_id": "q1", "answer": ["A"]})
    assert result["status"] == "ok"
    assert result["correct"] is True
    assert result["correct_answers"] == ["A"]
    assert result["explanation"] == "A 是正确的"


@pytest.mark.asyncio
async def test_graph_answer_quiz_multi_choice_wrong(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """多选题部分对算错。"""
    mock_store = MagicMock()
    mock_store.get_quiz = AsyncMock(
        return_value={
            "id": "q2",
            "answered": False,
            "type": "multi_choice",
            "payload": {
                "correct_answers": ["A", "C"],
                "explanation": "",
                "options": ["A", "B", "C", "D"],
            },
        }
    )
    mock_store.update_quiz_result = AsyncMock(
        return_value={"id": "q2", "answered": True}
    )
    monkeypatch.setattr("app.services.graph_store.graph_store", mock_store)

    result = await graph_answer_quiz({"quiz_id": "q2", "answer": ["A"]})
    assert result["status"] == "ok"
    assert result["correct"] is False  # 多选部分对算错


@pytest.mark.asyncio
async def test_graph_answer_quiz_feynman(monkeypatch: pytest.MonkeyPatch) -> None:
    """费曼题作答：调 grade_feynman 语义判分。"""
    mock_store = MagicMock()
    mock_store.get_quiz = AsyncMock(
        return_value={
            "id": "q3",
            "answered": False,
            "type": "feynman",
            "payload": {
                "prompt": "请解释闭包",
                "reference_points": ["函数捕获外部变量", "形成闭包"],
            },
        }
    )
    mock_store.update_quiz_result = AsyncMock(
        return_value={"id": "q3", "answered": True}
    )
    monkeypatch.setattr("app.services.graph_store.graph_store", mock_store)

    mock_agent = MagicMock()
    mock_agent.grade_feynman = AsyncMock(
        return_value={
            "score": 80,
            "understanding_level": "good",
            "feedback": "抓住了核心但缺少示例",
            "missed_points": ["缺少代码示例"],
        }
    )
    monkeypatch.setattr("app.services.graph_agent.graph_agent", mock_agent)

    result = await graph_answer_quiz(
        {"quiz_id": "q3", "answer": "闭包是函数捕获外部变量的机制"}
    )
    assert result["status"] == "ok"
    assert result["score"] == 80
    assert result["understanding_level"] == "good"


@pytest.mark.asyncio
async def test_graph_list_quiz_history_ok(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """graph_list_quiz_history happy path + 答案剥离。"""
    mock_store = MagicMock()
    mock_store.list_quizzes = AsyncMock(
        return_value=[
            {
                "id": "q1",
                "type": "single_choice",
                "answered": False,
                "payload": {
                    "question": "Q1",
                    "correct_answers": ["A"],
                    "options": ["A", "B"],
                },
                "answer": '["A"]',
            }
        ]
    )
    monkeypatch.setattr("app.services.graph_store.graph_store", mock_store)

    result = await graph_list_quiz_history({"graph_id": "g1"})
    assert result["status"] == "ok"
    assert result["count"] == 1
    # 答案字段应被剥离（避免泄题）
    quiz = result["quizzes"][0]
    assert "correct_answers" not in quiz["payload"]
    assert quiz["answer"] == ""


@pytest.mark.asyncio
async def test_graph_get_quiz_detail_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    """graph_get_quiz_detail happy path + 答案剥离。"""
    mock_store = MagicMock()
    mock_store.get_quiz = AsyncMock(
        return_value={
            "id": "q1",
            "type": "feynman",
            "answered": False,
            "payload": {
                "prompt": "请解释闭包",
                "reference_points": ["函数捕获外部变量"],
            },
        }
    )
    monkeypatch.setattr("app.services.graph_store.graph_store", mock_store)

    result = await graph_get_quiz_detail({"quiz_id": "q1"})
    assert result["status"] == "ok"
    # 费曼题 reference_points 应被剥离
    assert "reference_points" not in result["quiz"]["payload"]


@pytest.mark.asyncio
async def test_graph_add_user_fill_invalid_type() -> None:
    """非法 fill_type 应返回 error。"""
    result = await graph_add_user_fill(
        {"node_id": "n1", "fill_type": "invalid", "content": "test"}
    )
    assert result["status"] == "error"


@pytest.mark.asyncio
async def test_graph_add_user_fill_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    """graph_add_user_fill happy path。"""
    mock_store = MagicMock()
    mock_store.append_user_fill = AsyncMock(
        return_value={"id": "n1", "user_fill": {"doubt": ["a question"]}}
    )
    monkeypatch.setattr("app.services.graph_store.graph_store", mock_store)

    result = await graph_add_user_fill(
        {"node_id": "n1", "fill_type": "doubt", "content": "a question"}
    )
    assert result["status"] == "ok"
    mock_store.append_user_fill.assert_awaited_once_with(
        "n1", "doubt", "a question"
    )


# ============================================================================
# 智能推荐工具（1 个）
# ============================================================================


@pytest.mark.asyncio
async def test_graph_get_recommendations_invalid_mode() -> None:
    """非法 mode 应返回 error。"""
    result = await graph_get_recommendations(
        {"graph_id": "g1", "mode": "invalid"}
    )
    assert result["status"] == "error"
    assert "无效 mode" in result["message"]


@pytest.mark.asyncio
async def test_graph_get_recommendations_study_ok(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """study 模式推荐：按遗忘分 + 热度 + 错误率排序。"""
    mock_store = MagicMock()
    mock_store.get_graph = AsyncMock(return_value={"id": "g1", "mode": "study"})
    mock_store.list_nodes = AsyncMock(
        return_value=[
            {
                "id": "n1",
                "title": "React",
                "last_reviewed_at": None,
                "review_count": 0,
                "mention_count": 0,
            }
        ]
    )
    mock_store.list_quizzes = AsyncMock(return_value=[])
    monkeypatch.setattr("app.services.graph_store.graph_store", mock_store)

    result = await graph_get_recommendations(
        {"graph_id": "g1", "mode": "study"}
    )
    assert result["status"] == "ok"
    assert result["count"] == 1
    rec = result["recommendations"][0]
    assert "score" in rec
    assert "reason" in rec
    assert rec["score"] > 0  # 从未复习的节点遗忘分应为 40


@pytest.mark.asyncio
async def test_graph_get_recommendations_work_ok(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """work 模式推荐：到期优先 + 星标加权。"""
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    overdue = (now - timedelta(days=1)).isoformat()

    mock_store = MagicMock()
    mock_store.get_graph = AsyncMock(return_value={"id": "g1", "mode": "work"})
    mock_store.list_nodes = AsyncMock(
        return_value=[
            {
                "id": "n1",
                "title": "到期承诺",
                "remind_at": overdue,
                "is_starred": True,
                "type": "commitment",
            }
        ]
    )
    monkeypatch.setattr("app.services.graph_store.graph_store", mock_store)

    result = await graph_get_recommendations({"graph_id": "g1", "mode": "work"})
    assert result["status"] == "ok"
    rec = result["recommendations"][0]
    assert rec["is_overdue"] is True
    assert rec["is_starred"] is True
    assert rec["score"] >= 100  # 到期 100 + 星标 20


@pytest.mark.asyncio
async def test_graph_get_recommendations_graph_not_found(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """图谱不存在返回 not_found。"""
    mock_store = MagicMock()
    mock_store.get_graph = AsyncMock(return_value=None)
    monkeypatch.setattr("app.services.graph_store.graph_store", mock_store)

    result = await graph_get_recommendations(
        {"graph_id": "g1", "mode": "study"}
    )
    assert result["status"] == "not_found"


# ============================================================================
# 工作对象工具（2 个）
# ============================================================================


@pytest.mark.asyncio
async def test_graph_extract_work_objects_missing_text() -> None:
    """缺 text 应返回 error。"""
    result = await graph_extract_work_objects({"graph_id": "g1"})
    assert result["status"] == "error"


@pytest.mark.asyncio
async def test_graph_extract_work_objects_ok(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """graph_extract_work_objects happy path：返回候选不入图。"""
    mock_agent = MagicMock()
    mock_agent.extract_work_objects = AsyncMock(
        return_value=[
            {
                "title": "张三",
                "summary": "后端负责人",
                "type": "key_person",
                "relations": [],
            }
        ]
    )
    monkeypatch.setattr("app.services.graph_agent.graph_agent", mock_agent)

    result = await graph_extract_work_objects(
        {"graph_id": "g1", "text": "张三是后端负责人"}
    )
    assert result["status"] == "ok"
    assert result["count"] == 1
    assert result["objects"][0]["title"] == "张三"


@pytest.mark.asyncio
async def test_graph_confirm_work_objects_empty_objects() -> None:
    """空 objects 数组应返回 error。"""
    result = await graph_confirm_work_objects({"graph_id": "g1", "objects": []})
    assert result["status"] == "error"
    assert "objects 必须是非空数组" in result["message"]


@pytest.mark.asyncio
async def test_graph_confirm_work_objects_ok(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """graph_confirm_work_objects happy path：批量建节点 + 边。"""
    mock_store = MagicMock()
    mock_store.list_nodes = AsyncMock(return_value=[])  # 无已存在节点
    mock_store.create_node = AsyncMock(
        side_effect=[
            {"id": "n1", "title": "张三"},
            {"id": "n2", "title": "支付项目"},
        ]
    )
    mock_store.create_edge = AsyncMock(return_value={"id": "e1"})
    monkeypatch.setattr("app.services.graph_store.graph_store", mock_store)

    objects = [
        {
            "title": "张三",
            "summary": "后端",
            "type": "key_person",
            "relations": [{"to_title": "支付项目", "relation": "involves"}],
        },
        {
            "title": "支付项目",
            "summary": "Q3 重点",
            "type": "event",
            "relations": [],
        },
    ]
    result = await graph_confirm_work_objects(
        {"graph_id": "g1", "objects": objects}
    )
    assert result["status"] == "ok"
    assert result["created_count"] == 2
    assert result["edge_count"] == 1  # 张三 -> 支付项目


# ============================================================================
# 观察记录工具（1 个）
# ============================================================================


@pytest.mark.asyncio
async def test_graph_list_observations_ok(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """graph_list_observations happy path。"""
    mock_store = MagicMock()
    mock_store.list_observations = AsyncMock(
        return_value=[
            {
                "id": "obs-1",
                "source": "plugin",
                "processed": False,
                "graph_id": "g1",
            }
        ]
    )
    monkeypatch.setattr("app.services.graph_store.graph_store", mock_store)

    result = await graph_list_observations({"graph_id": "g1"})
    assert result["status"] == "ok"
    assert result["count"] == 1
    mock_store.list_observations.assert_awaited_once()
    # 默认 processed=False（仅未处理）
    call_kwargs = mock_store.list_observations.call_args.kwargs
    assert call_kwargs["processed"] is False


@pytest.mark.asyncio
async def test_graph_list_observations_exception(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """底层异常应被捕获，返回 error。"""
    mock_store = MagicMock()
    mock_store.list_observations = AsyncMock(
        side_effect=RuntimeError("db connection lost")
    )
    monkeypatch.setattr("app.services.graph_store.graph_store", mock_store)

    result = await graph_list_observations({})
    assert result["status"] == "error"
    assert "db connection lost" in result["message"]
