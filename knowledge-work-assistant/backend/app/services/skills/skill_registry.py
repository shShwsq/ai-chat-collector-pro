"""Skill 注册表与内置技能定义。

**Skill 数据结构**::

    {
        "id": "study_path",                  # 唯一 id（snake_case）
        "name": "学习路径生成",
        "description": "基于图谱节点规划一条循序渐进的学习路径...",
        "scenario_modes": ["study"],          # 适配场景：study / work
        "plan_mode_only": False,              # 是否仅 plan 模式可用
        "tools": [                            # 建议工具调用顺序
            "graph_get_context",
            "graph_query_nodes",
            "graph_get_node_detail"
        ],
        "steps": [                            # 每步说明
            "调用 graph_get_context 获取图谱全貌",
            "..."
        ],
        "output_template": "## 学习路径\\n1. ...",  # 输出结构模板
        "example": "用户：帮我规划 React 学习路径\\n..."  # 示例对话
    }

设计要点：

1. **声明式蓝图**：技能只描述"应该做什么"，不执行任何业务逻辑，
   agent 拿到蓝图后自行决策调用工具。
2. **场景过滤**：``scenario_modes`` 让 ``skill_list`` 工具按当前
   study/work 模式过滤可用技能。
3. **模式兼容**：``plan_mode_only=False`` 的技能在 plan/build 均可用，
   ``plan_mode_only=True`` 的技能仅 plan 模式暴露（如纯规划类）。
4. **不抛异常**：所有方法对异常做兜底，``list_skills`` /
   ``get_skill`` 在异常时返回空列表 / None。
5. **延迟扩展**：内置技能在模块顶部声明；未来可在 ``register_skill``
   接口动态注册第三方技能（如 MCP 服务器的技能）。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)


# ============================================================================
# Skill 数据类
# ============================================================================

@dataclass
class Skill:
    """单个技能的定义条目。

    Attributes:
        id: 技能唯一 id（snake_case，如 ``study_path``）。
        name: 显示名（中文）。
        description: 简短描述（用于 LLM 选择技能）。
        scenario_modes: 适配场景列表（``["study"]`` / ``["work"]`` / ``["study","work"]``）。
        plan_mode_only: 是否仅 plan 模式可用（默认 False，plan/build 均可用）。
        tools: 建议工具调用顺序（工具名列表，供 agent 参考，非强制）。
        steps: 每步说明（简短描述，与 tools 长度可不同）。
        output_template: 最终回复应遵循的输出结构模板。
        example: 典型示例对话（agent 学习如何调用本技能）。
    """

    id: str
    name: str
    description: str
    scenario_modes: list[str] = field(default_factory=lambda: ["study", "work"])
    plan_mode_only: bool = False
    tools: list[str] = field(default_factory=list)
    steps: list[str] = field(default_factory=list)
    output_template: str = ""
    example: str = ""

    def to_dict(self) -> dict[str, Any]:
        """转换为 dict（用于工具返回结果，剔除空字段以减少 token 占用）。"""
        data: dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "scenario_modes": self.scenario_modes,
        }
        if self.plan_mode_only:
            data["plan_mode_only"] = True
        if self.tools:
            data["tools"] = self.tools
        if self.steps:
            data["steps"] = self.steps
        if self.output_template:
            data["output_template"] = self.output_template
        if self.example:
            data["example"] = self.example
        return data


# ============================================================================
# SkillRegistry
# ============================================================================

class SkillRegistry:
    """Skill 注册表：管理内置与动态注册的技能。

    用法::

        from app.services.skills import skill_registry
        skills = skill_registry.list_skills(scenario="study", plan_mode=False)
    """

    def __init__(self) -> None:
        self._skills: dict[str, Skill] = {}

    def register(self, skill: Skill) -> None:
        """注册一个技能。重复 id 覆盖旧值。"""
        self._skills[skill.id] = skill
        logger.debug("注册技能 %s (modes=%s)", skill.id, skill.scenario_modes)

    def unregister(self, skill_id: str) -> bool:
        """注销技能。返回是否曾存在。"""
        return self._skills.pop(skill_id, None) is not None

    def get_skill(self, skill_id: str) -> dict[str, Any] | None:
        """按 id 查询技能并返回 dict。不存在返回 None。"""
        skill = self._skills.get(skill_id)
        if skill is None:
            return None
        return skill.to_dict()

    def list_skills(
        self,
        *,
        scenario: str | None = None,
        plan_mode: bool | None = None,
    ) -> list[dict[str, Any]]:
        """列出可用技能（按场景 + 模式过滤）。

        Args:
            scenario: 场景模式（``"study"`` / ``"work"``，None 时不过滤）。
            plan_mode: 是否 plan 模式（True 时仅返回 plan_mode_only=False 与
                plan_mode_only=True 的技能；False 时仅返回 plan_mode_only=False
                的技能；None 时不过滤）。

        Returns:
            技能 dict 列表（含 id / name / description，便于 LLM 选择）。
            详细字段（tools / steps / template / example）需通过
            :meth:`get_skill` 单独查询以减少 token 占用。
        """
        result: list[dict[str, Any]] = []
        for skill in self._skills.values():
            if scenario is not None and scenario not in skill.scenario_modes:
                continue
            if plan_mode is True:
                # plan 模式：包含 plan_mode_only=True 与 False 的技能
                pass
            elif plan_mode is False:
                # build 模式：仅包含 plan_mode_only=False 的技能
                if skill.plan_mode_only:
                    continue
            # 列表只返回简短字段（详细字段需 get_skill）
            result.append({
                "id": skill.id,
                "name": skill.name,
                "description": skill.description,
                "scenario_modes": skill.scenario_modes,
            })
        return result

    def has_skill(self, skill_id: str) -> bool:
        """是否注册了某技能。"""
        return skill_id in self._skills


# ============================================================================
# 内置技能定义（KWA 核心 6 个）
# ============================================================================

#: 全局 SkillRegistry 单例。
skill_registry = SkillRegistry()


def _register_builtin_skills() -> None:
    """注册内置技能到全局 skill_registry。

    在模块加载时调用一次。每个技能覆盖一个典型场景：
    - study 场景：学习路径 / 测验复盘
    - work 场景：周报产出 / 风口分析 / 工作对象入图
    - 跨场景：观察抽取入图
    """
    # 1. 学习路径生成（study）
    skill_registry.register(Skill(
        id="study_path",
        name="学习路径生成",
        description=(
            "基于知识图谱为学习者规划一条循序渐进的学习路径。"
            "适用于用户表示要“从头学某主题”或“规划学习路线”的场景。"
        ),
        scenario_modes=["study"],
        tools=[
            "graph_get_context",
            "graph_query_nodes",
            "graph_get_node_detail",
        ],
        steps=[
            "调用 graph_get_context 获取图谱全貌（节点数、类型分布、关联结构）",
            "调用 graph_query_nodes 定位核心概念节点（按关键词匹配）",
            "对每个核心节点调用 graph_get_node_detail 获取详情与关联",
            "基于节点依赖关系（关联边）组织学习路径，前置概念在前",
            "用 output_template 格式化输出路径",
        ],
        output_template=(
            "## 学习路径：<主题>\n\n"
            "### 阶段 1：基础概念\n"
            "- <节点名>：<一句话说明>\n\n"
            "### 阶段 2：核心原理\n"
            "- <节点名>：<一句话说明>\n\n"
            "### 阶段 3：进阶应用\n"
            "- <节点名>：<一句话说明>\n\n"
            "### 下一步建议\n"
            "- 推荐先掌握 <前置节点>，再进入 <后续节点>\n"
            "- 完成后可触发 graph_generate_quiz 验证掌握程度"
        ),
        example=(
            "用户：帮我规划 React Hooks 学习路径\n"
            "assistant：[调用 graph_get_context / graph_query_nodes / graph_get_node_detail]\n"
            "assistant：## 学习路径：React Hooks\n\n"
            "### 阶段 1：基础概念\n- useState：状态管理入门...\n"
            "### 阶段 2：核心原理\n- useEffect：副作用处理...\n"
            "### 阶段 3：进阶应用\n- useMemo / useCallback：性能优化..."
        ),
    ))

    # 2. 测验复盘（study）
    skill_registry.register(Skill(
        id="quiz_review",
        name="测验复盘",
        description=(
            "回顾用户的测验历史，识别薄弱知识点并生成针对性测验巩固。"
            "适用于用户表示“最近表现怎么样”或“想复习之前答错的”场景。"
        ),
        scenario_modes=["study"],
        tools=[
            "graph_list_quiz_history",
            "graph_get_quiz_detail",
            "graph_get_node_detail",
            "graph_generate_quiz",
        ],
        steps=[
            "调用 graph_list_quiz_history 获取近 N 次测验记录",
            "对错误率高的测验调用 graph_get_quiz_detail 查看题目",
            "对错题涉及的节点调用 graph_get_node_detail 获取详情",
            "调用 graph_generate_quiz 针对薄弱节点生成新测验",
            "用 output_template 输出复盘报告与下一步建议",
        ],
        output_template=(
            "## 测验复盘\n\n"
            "### 整体表现\n- 共完成 <N> 次测验，平均得分 <score>\n\n"
            "### 薄弱知识点\n"
            "- <节点名>：<错题数> 道错题，建议复习\n\n"
            "### 巩固测验\n"
            "已为你生成针对 <薄弱节点> 的新测验，点击下方作答。\n\n"
            "### 下一步建议\n- 建议先复习 <节点> 后再作答新测验"
        ),
        example=(
            "用户：我最近学得怎么样\n"
            "assistant：[调用 graph_list_quiz_history / graph_get_quiz_detail]\n"
            "assistant：## 测验复盘\n\n### 整体表现\n- 共完成 5 次测验，平均得分 72\n\n"
            "### 薄弱知识点\n- React Hooks：3 道错题..."
        ),
    ))

    # 3. 周报产出（work）
    skill_registry.register(Skill(
        id="work_weekly_report",
        name="周报产出",
        description=(
            "从本周工作对象与观察记录中提炼周报。"
            "适用于用户表示“写周报”或“总结本周工作”的场景。"
        ),
        scenario_modes=["work"],
        tools=[
            "graph_list_observations",
            "graph_extract_work_objects",
            "graph_generate_report",
        ],
        steps=[
            "调用 graph_list_observations 列出本周观察记录",
            "对每条观察调用 graph_extract_work_objects 抽取工作对象候选",
            "调用 graph_generate_report 生成结构化周报",
            "用 output_template 补充洞察与下周计划",
        ],
        output_template=(
            "## 周报：<日期范围>\n\n"
            "### 本周完成\n- <工作对象 1>\n- <工作对象 2>\n\n"
            "### 关键观察\n- <观察摘要>\n\n"
            "### 风险与跟进\n- <待办 / 提醒>\n\n"
            "### 下周计划\n- <建议优先级>"
        ),
        example=(
            "用户：帮我写本周周报\n"
            "assistant：[调用 graph_list_observations / graph_generate_report]\n"
            "assistant：## 周报：2026-W30\n\n### 本周完成\n- 完成支付模块对接..."
        ),
    ))

    # 4. 风口分析（work）
    skill_registry.register(Skill(
        id="work_trends_analysis",
        name="风口分析",
        description=(
            "基于工作图谱节点生成行业风口分析报告。"
            "适用于用户表示“看看最近有什么风口”或“行业趋势”的场景。"
        ),
        scenario_modes=["work"],
        tools=[
            "graph_get_context",
            "graph_generate_trends",
        ],
        steps=[
            "调用 graph_get_context 获取工作图谱全貌",
            "调用 graph_generate_trends 生成风口分析",
            "用 output_template 补充行动建议",
        ],
        output_template=(
            "## 风口分析：<主题>\n\n"
            "### 趋势总览\n- <核心趋势>\n\n"
            "### 关键信号\n- <信号 1>\n- <信号 2>\n\n"
            "### 行动建议\n- <建议 1>\n- <建议 2>"
        ),
        example=(
            "用户：看看最近 AI 应用有什么风口\n"
            "assistant：[调用 graph_get_context / graph_generate_trends]\n"
            "assistant：## 风口分析：AI 应用\n\n### 趋势总览\n- 多模态交互正在普及..."
        ),
    ))

    # 5. 工作对象入图（work）
    skill_registry.register(Skill(
        id="work_objects_to_graph",
        name="工作对象入图",
        description=(
            "从对话或会议纪要中抽取工作对象并批量入图。"
            "适用于用户粘贴一段工作对话想沉淀到图谱的场景。"
            "**注意**：涉及高风险工具 graph_confirm_work_objects，需用户确认。"
        ),
        scenario_modes=["work"],
        tools=[
            "graph_extract_work_objects",
            "graph_confirm_work_objects",
        ],
        steps=[
            "调用 graph_extract_work_objects 从文本抽取候选工作对象（只读，不入图）",
            "向用户展示候选列表，等待用户确认或修改",
            "调用 graph_confirm_work_objects 批量入图（高风险，系统会弹确认框）",
            "用 output_template 输出入图结果摘要",
        ],
        output_template=(
            "## 工作对象入图\n\n"
            "### 候选对象（共 <N> 个）\n- <对象 1>：<类型>\n- <对象 2>：<类型>\n\n"
            "### 入图结果\n- 成功入图 <M> 个，跳过 <K> 个\n"
            "- 新增节点 ID 列表：<ids>"
        ),
        example=(
            "用户：[粘贴会议纪要]\n"
            "assistant：[调用 graph_extract_work_objects]\n"
            "assistant：## 工作对象入图\n\n### 候选对象（共 5 个）\n- 项目 Alpha...\n"
            "（用户确认后调用 graph_confirm_work_objects）"
        ),
    ))

    # 6. 观察抽取入图（跨场景）
    skill_registry.register(Skill(
        id="observation_to_nodes",
        name="观察抽取入图",
        description=(
            "从一条观察记录中抽取知识节点写入图谱。"
            "适用于 study（从学习对话抽取概念）与 work（从工作观察抽取对象）场景。"
            "**注意**：涉及高风险工具 graph_extract_from_observation，需用户确认。"
        ),
        scenario_modes=["study", "work"],
        tools=[
            "graph_list_observations",
            "graph_extract_from_observation",
        ],
        steps=[
            "调用 graph_list_observations 列出未处理观察记录",
            "向用户确认要处理哪条观察",
            "调用 graph_extract_from_observation 抽取节点入图（高风险，系统会弹确认框）",
            "用 output_template 输出抽取结果摘要",
        ],
        output_template=(
            "## 观察抽取入图\n\n"
            "### 观察来源\n- <observation_id>：<简短描述>\n\n"
            "### 抽取结果\n- 成功抽取 <N> 个节点入图\n"
            "- 新增节点：\n  - <节点名>（<类型>）\n"
            "- 分块信息：truncated=<bool>, segment_count=<N>"
        ),
        example=(
            "用户：把上次那段对话沉淀到图谱\n"
            "assistant：[调用 graph_list_observations]\n"
            "assistant：找到 3 条未处理观察，要处理哪条？\n"
            "用户：第一条\n"
            "assistant：[调用 graph_extract_from_observation，系统弹确认框]"
        ),
    ))


# 模块加载时注册内置技能
_register_builtin_skills()


__all__ = [
    "Skill",
    "SkillRegistry",
    "skill_registry",
]
