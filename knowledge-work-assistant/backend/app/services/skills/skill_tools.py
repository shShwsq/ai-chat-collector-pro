"""skill_* 工具：将 SkillRegistry 暴露为 Function Calling 工具。

提供两个工具供 MainAgent 调用：

- ``skill_list``：列出当前模式下可用的技能（按 scenario + plan_mode 过滤）。
  返回简短列表（id / name / description），减少 token 占用。
- ``skill_activate``：按 id 查询技能详情（含 tools / steps / output_template /
  example），把技能蓝图注入对话上下文，供 agent 后续调用工具时参考。

设计要点：

1. **场景与模式感知**：handler 从 ``args["_mode"]`` 读取 plan/build，
   从 ``args["_scenario"]`` 读取 study/work（由 MainAgent 注入）。
2. **不抛异常**：所有 handler 捕获异常返回 ``{"status": "error", ...}``。
3. **延迟绑定**：通过 ``make_skill_handlers`` 工厂创建，无需 session 绑定
   （SkillRegistry 是全局单例）。
4. **schema 严格化**：``skill_activate`` 的 ``skill_id`` 为必填，
   ``skill_list`` 的 ``scenario`` 为可选（缺省时不过滤）。
"""

from __future__ import annotations

import logging
from typing import Any

from app.services.skills.skill_registry import skill_registry
from app.services.tool_registry import ToolHandler, _build_schema

logger = logging.getLogger(__name__)


# ============================================================================
# skill_* handler 工厂
# ============================================================================

def make_skill_handlers() -> dict[str, ToolHandler]:
    """构造 skill_list / skill_activate 两个 handler。

    Returns:
        ``{"skill_list": handler, "skill_activate": handler}`` 映射。
    """

    async def skill_list(args: dict[str, Any]) -> dict[str, Any]:
        """列出当前模式下可用的技能。

        Args（来自 schema）:
            scenario: 场景过滤（``"study"`` / ``"work"``，可选；缺省时不过滤）。
            _mode: 由 ToolRegistry 注入的当前模式（``"plan"`` / ``"build"``）。
            _scenario: 由 MainAgent 注入的当前场景（``"study"`` / ``"work"``）。
        """
        # 优先用显式传入的 scenario；其次用 MainAgent 注入的 _scenario
        scenario = args.get("scenario")
        if not scenario:
            scenario = args.get("_scenario")
        # 模式：args["_mode"] 为 "plan" 时 plan_mode=True
        mode = args.get("_mode")
        plan_mode: bool | None
        if mode == "plan":
            plan_mode = True
        elif mode == "build":
            plan_mode = False
        else:
            plan_mode = None  # 未知模式，不过滤

        try:
            skills = skill_registry.list_skills(
                scenario=scenario if scenario else None,
                plan_mode=plan_mode,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("skill_list 查询失败: %s", exc)
            return {"status": "error", "message": f"查询技能列表失败: {exc}"}

        return {
            "status": "ok",
            "skills": skills,
            "count": len(skills),
            "hint": (
                "调用 skill_activate(skill_id=...) 获取技能详细蓝图"
                "（含建议工具、步骤、输出模板、示例）。"
            ),
        }

    async def skill_activate(args: dict[str, Any]) -> dict[str, Any]:
        """按 id 激活技能，返回详细蓝图。

        Args（来自 schema）:
            skill_id: 技能 id（必填，来自 skill_list 返回的 id 字段）。
        """
        skill_id = str(args.get("skill_id") or "").strip()
        if not skill_id:
            return {"status": "error", "message": "skill_id 不能为空"}

        try:
            skill = skill_registry.get_skill(skill_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("skill_activate 查询失败 skill_id=%s: %s", skill_id, exc)
            return {"status": "error", "message": f"查询技能详情失败: {exc}"}

        if skill is None:
            return {
                "status": "not_found",
                "skill_id": skill_id,
                "message": f"技能不存在: {skill_id}",
                "hint": "调用 skill_list 查看可用技能列表",
            }

        return {
            "status": "ok",
            "skill": skill,
            "usage_hint": (
                "根据蓝图中的 tools 与 steps 调用对应工具，"
                "用 output_template 组织最终回复。"
            ),
        }

    return {
        "skill_list": skill_list,
        "skill_activate": skill_activate,
    }


# ============================================================================
# schema 定义
# ============================================================================

_SKILL_LIST_SCHEMA = _build_schema(
    "skill_list",
    "列出当前模式下可用的技能（Skill）。技能是预置的工具组合蓝图，"
    "用于典型场景（学习路径生成 / 周报产出 / 测验复盘 / 工作对象入图等）。"
    "返回技能简短列表（id / name / description），详细蓝图需调用 skill_activate。"
    "plan 与 build 模式均可用。",
    {
        "scenario": {
            "type": "string",
            "enum": ["study", "work"],
            "description": (
                "场景过滤（可选）。不传时使用当前会话场景。"
                "study=学习辅导场景，work=工作辅助场景。"
            ),
        },
    },
    required=[],
)

_SKILL_ACTIVATE_SCHEMA = _build_schema(
    "skill_activate",
    "按 id 激活技能，获取详细蓝图（含建议工具调用顺序 / 步骤说明 / 输出模板 / 示例）。"
    "激活后根据蓝图调用对应工具完成任务。plan 与 build 模式均可用。",
    {
        "skill_id": {
            "type": "string",
            "description": "技能 id（来自 skill_list 返回的 id 字段，如 'study_path'）",
        },
    },
    required=["skill_id"],
)


# ============================================================================
# 注册函数
# ============================================================================

def register_skill_tools(registry: Any) -> None:
    """向 ToolRegistry 注册 skill_list / skill_activate 工具。

    Args:
        registry: ToolRegistry 实例。
    """
    handlers = make_skill_handlers()
    registry.register(
        "skill_list",
        _SKILL_LIST_SCHEMA,
        handlers["skill_list"],
        allowed_modes=["plan", "build"],
    )
    registry.register(
        "skill_activate",
        _SKILL_ACTIVATE_SCHEMA,
        handlers["skill_activate"],
        allowed_modes=["plan", "build"],
    )
    logger.debug("已注册 skill_list / skill_activate 工具")


__all__ = [
    "make_skill_handlers",
    "register_skill_tools",
]
