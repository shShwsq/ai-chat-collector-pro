"""Skills 子包：将"技能"作为 agent 可调用的结构化能力单元。

技能（Skill）= 一段预置的「工具组合 + 调用步骤 + 输出模板 + 示例对话」，
用于典型场景（学习路径生成 / 周报产出 / 测验复盘 / 工作对象入图等），
让 agent 不必每次从零规划工具调用链。

技能本身**不执行业务**，而是向 agent 提供「调用蓝图」：
- ``tools``：建议调用的工具顺序
- ``steps``：每步的简短说明
- ``output_template``：最终回复应遵循的结构
- ``example``：典型示例对话

通过 :func:`register_skill_tools` 将 ``skill_list`` / ``skill_activate`` 两个
Function Calling 工具暴露给 :class:`MainAgent`，agent 可像调用普通工具一样
查询并激活技能，把蓝图注入对话上下文。

KWA 适配：本子包无外部依赖（仅依赖 :mod:`tool_registry` 的 ToolHandler 类型），
所有内置技能定义在 :mod:`skill_registry` 的 ``_BUILTIN_SKILLS`` 中。
"""

from __future__ import annotations

from app.services.skills.skill_registry import (
    Skill,
    SkillRegistry,
    skill_registry,
)
from app.services.skills.skill_tools import (
    make_skill_handlers,
    register_skill_tools,
)

__all__ = [
    # 类型与注册表
    "Skill",
    "SkillRegistry",
    "skill_registry",
    # 工具注册
    "make_skill_handlers",
    "register_skill_tools",
]
