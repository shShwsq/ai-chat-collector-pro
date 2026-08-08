"""``app.services.tool_registry`` 默认工具注册裁剪测试（KWA 本土化适配）。

验证 ``register_default_tools`` 在 KWA 场景下的工具裁剪行为：

1. **步影通用桌面工具不注册**：``file_read / file_write / file_list /
   command_exec / open_app / open_url / system_notification / screenshot /
   clipboard_read / clipboard_write / append_note`` 共 11 个工具被
   ``_KWA_SKIP_TOOLS`` 跳过，注册后 ``has_tool`` 返回 False。
2. **KWA 业务工具保留注册**：``knowledge_search`` + 4 个 ``task_*`` +
   2 个 ``skill_*`` + 21 个 ``graph_*`` 工具。
3. **总数正确**：build 模式 28 个（7 通用 + 21 图谱），plan 模式 18 个
   （7 通用 + 11 只读图谱）。
4. **高风险工具在 plan 模式不可见**：``graph_extract_from_observation`` 与
   ``graph_confirm_work_objects`` 在 plan 模式下不可见。

测试隔离
--------

- **不依赖 tmp_db / mock_llm**：本测试组仅验证工具注册（schema 与 handler 绑定），
  不执行 handler 内部的 SQL / LLM 调用。
- **不依赖 async_client**：直接操作 ``ToolRegistry`` 实例。
"""

from __future__ import annotations

import pytest

from app.services.tool_registry import ToolRegistry, register_default_tools
from app.services.tools.graph_tools import (
    ALL_GRAPH_TOOLS,
    HIGH_RISK_TOOLS,
    READONLY_GRAPH_TOOLS,
)


# ============================================================================
# 裁剪后的工具集
# ============================================================================

#: 步影通用桌面工具：应被 _KWA_SKIP_TOOLS 跳过，不注册到 main_agent
_SKIPPED_DESKTOP_TOOLS: tuple[str, ...] = (
    "file_read",
    "file_write",
    "file_list",
    "command_exec",
    "open_app",
    "open_url",
    "system_notification",
    "screenshot",
    "clipboard_read",
    "clipboard_write",
    "append_note",
)

#: KWA 保留的通用工具（非图谱）：knowledge_search + task_* + skill_*
_KWA_KEPT_GENERAL_TOOLS: tuple[str, ...] = (
    "knowledge_search",
    "task_create",
    "task_list",
    "task_update",
    "task_delete",
    "skill_list",
    "skill_activate",
)


@pytest.fixture
def registry() -> ToolRegistry:
    """新建 ToolRegistry 并注册默认工具（含图谱工具）。

    不依赖 tmp_db / mock_llm：register_default_tools 仅注册 schema 与 handler
    绑定，不执行 handler 内部逻辑。
    """
    reg = ToolRegistry()
    register_default_tools(reg)
    return reg


# ============================================================================
# 步影桌面工具裁剪
# ============================================================================


@pytest.mark.parametrize("tool_name", _SKIPPED_DESKTOP_TOOLS)
def test_desktop_tools_skipped(registry: ToolRegistry, tool_name: str) -> None:
    """步影通用桌面工具应被 _KWA_SKIP_TOOLS 跳过，未注册到 registry。"""
    assert not registry.has_tool(tool_name), (
        f"{tool_name} 应被跳过，但 registry.has_tool 返回 True"
    )


# ============================================================================
# KWA 保留的通用工具
# ============================================================================


@pytest.mark.parametrize("tool_name", _KWA_KEPT_GENERAL_TOOLS)
def test_general_tools_registered(registry: ToolRegistry, tool_name: str) -> None:
    """KWA 保留的通用工具应被注册。"""
    assert registry.has_tool(tool_name), (
        f"{tool_name} 应被注册，但 registry.has_tool 返回 False"
    )


# ============================================================================
# 21 个图谱工具注册
# ============================================================================


@pytest.mark.parametrize("tool_name", ALL_GRAPH_TOOLS)
def test_graph_tools_registered(registry: ToolRegistry, tool_name: str) -> None:
    """21 个图谱工具应被注册。"""
    assert registry.has_tool(tool_name), (
        f"{tool_name} 应被注册，但 registry.has_tool 返回 False"
    )


def test_graph_tool_count(registry: ToolRegistry) -> None:
    """注册的 graph_* 工具应有 21 个。"""
    graph_tools = [
        name for name in ALL_GRAPH_TOOLS if registry.has_tool(name)
    ]
    assert len(graph_tools) == 21


# ============================================================================
# 总工具数
# ============================================================================


def test_total_tool_count_build_mode(registry: ToolRegistry) -> None:
    """build 模式应有 28 个工具（7 通用 + 21 图谱）。"""
    build_tools = registry.get_tool_names("build")
    assert len(build_tools) == 28, (
        f"expected 28 build-mode tools, got {len(build_tools)}: {sorted(build_tools)}"
    )


def test_total_tool_count_plan_mode(registry: ToolRegistry) -> None:
    """plan 模式应有 18 个工具（7 通用 + 11 只读图谱）。"""
    plan_tools = registry.get_tool_names("plan")
    assert len(plan_tools) == 18, (
        f"expected 18 plan-mode tools, got {len(plan_tools)}: {sorted(plan_tools)}"
    )


# ============================================================================
# 高风险工具在 plan 模式不可见
# ============================================================================


@pytest.mark.parametrize("tool_name", list(HIGH_RISK_TOOLS))
def test_high_risk_tools_not_in_plan_mode(
    registry: ToolRegistry, tool_name: str
) -> None:
    """高风险工具在 plan 模式下不可见（allowed_modes=["build"]）。"""
    plan_tools = registry.get_tool_names("plan")
    assert tool_name not in plan_tools, (
        f"{tool_name} 是高风险工具，不应在 plan 模式可见"
    )


@pytest.mark.parametrize("tool_name", list(HIGH_RISK_TOOLS))
def test_high_risk_tools_visible_in_build_mode(
    registry: ToolRegistry, tool_name: str
) -> None:
    """高风险工具在 build 模式下可见。"""
    build_tools = registry.get_tool_names("build")
    assert tool_name in build_tools


# ============================================================================
# 写入工具在 plan 模式不可见
# ============================================================================


#: build-only 写入工具（allowed_modes=["build"]）
_BUILD_ONLY_TOOLS: tuple[str, ...] = (
    "graph_extract_from_observation",
    "graph_extend_node",
    "graph_touch_node",
    "graph_star_node",
    "graph_unstar_node",
    "graph_set_reminder",
    "graph_clear_reminder",
    "graph_answer_quiz",
    "graph_add_user_fill",
    "graph_confirm_work_objects",
)


@pytest.mark.parametrize("tool_name", _BUILD_ONLY_TOOLS)
def test_write_tools_not_in_plan_mode(
    registry: ToolRegistry, tool_name: str
) -> None:
    """写入工具（allowed_modes=["build"]）在 plan 模式下不可见。"""
    plan_tools = registry.get_tool_names("plan")
    assert tool_name not in plan_tools


@pytest.mark.parametrize("tool_name", _BUILD_ONLY_TOOLS)
def test_write_tools_visible_in_build_mode(
    registry: ToolRegistry, tool_name: str
) -> None:
    """写入工具在 build 模式下可见。"""
    build_tools = registry.get_tool_names("build")
    assert tool_name in build_tools


# ============================================================================
# 只读图谱工具在 plan/build 均可见
# ============================================================================


@pytest.mark.parametrize("tool_name", READONLY_GRAPH_TOOLS)
def test_readonly_tools_visible_in_both_modes(
    registry: ToolRegistry, tool_name: str
) -> None:
    """只读图谱工具（allowed_modes=["plan","build"]）在 plan 与 build 模式均可见。"""
    plan_tools = registry.get_tool_names("plan")
    build_tools = registry.get_tool_names("build")
    assert tool_name in plan_tools, f"{tool_name} 应在 plan 模式可见"
    assert tool_name in build_tools, f"{tool_name} 应在 build 模式可见"


# ============================================================================
# is_tool_allowed 行为
# ============================================================================


def test_is_tool_allowed(registry: ToolRegistry) -> None:
    """is_tool_allowed 应正确反映 plan/build 可见性。"""
    # 通用工具：plan/build 均可用
    assert registry.is_tool_allowed("knowledge_search", "plan")
    assert registry.is_tool_allowed("knowledge_search", "build")
    assert registry.is_tool_allowed("task_create", "plan")

    # 只读图谱工具：plan/build 均可用
    assert registry.is_tool_allowed("graph_query_nodes", "plan")
    assert registry.is_tool_allowed("graph_query_nodes", "build")

    # 写入图谱工具：仅 build
    assert not registry.is_tool_allowed("graph_star_node", "plan")
    assert registry.is_tool_allowed("graph_star_node", "build")

    # 高风险工具：仅 build
    assert not registry.is_tool_allowed("graph_extract_from_observation", "plan")
    assert registry.is_tool_allowed("graph_extract_from_observation", "build")
    assert not registry.is_tool_allowed("graph_confirm_work_objects", "plan")
    assert registry.is_tool_allowed("graph_confirm_work_objects", "build")


# ============================================================================
# get_tool_schemas 返回结构
# ============================================================================


def test_get_tool_schemas_build(registry: ToolRegistry) -> None:
    """get_tool_schemas('build') 应返回 28 个 schema（含 function 字段）。"""
    schemas = registry.get_tool_schemas("build")
    assert len(schemas) == 28
    # 每个 schema 应是 OpenAI function calling 格式
    for schema in schemas:
        assert schema["type"] == "function"
        assert "function" in schema
        assert "name" in schema["function"]
        assert "parameters" in schema["function"]


def test_get_tool_schemas_plan(registry: ToolRegistry) -> None:
    """get_tool_schemas('plan') 应返回 18 个 schema（7 通用 + 11 只读图谱）。"""
    schemas = registry.get_tool_schemas("plan")
    assert len(schemas) == 18
    plan_names = {s["function"]["name"] for s in schemas}
    # 高风险工具不应出现
    assert "graph_extract_from_observation" not in plan_names
    assert "graph_confirm_work_objects" not in plan_names
