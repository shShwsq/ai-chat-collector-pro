"""节点类型与详情模板定义（Task 2.2）。

本模块集中管理图谱节点的子类型枚举与详情模板，供：

- ``app.models.db_models.Node.type`` 字段取值约束（字符串枚举，存库不强制约束，
  但 services / 路由层应使用本模块常量，避免拼写分歧）
- ``app.services.graph_store`` 在创建 / 更新节点时校验类型
- 前端 ``frontend/src/lib/types.ts`` 的镜像常量
- Agent 抽取节点时给出类型初判（参考 ``STUDY_SUBJECTS`` / ``WORK_OBJECTS``）
- 节点悬停详情卡按类型命中对应模板（``STUDY_TEMPLATES`` / ``WORK_TEMPLATES``）

设计要点：

1. **图谱类型与节点类型解耦**：``Graph.type`` 仅区分 ``study`` / ``work`` 两种模式，
   节点的具体子类型由 ``Node.type`` 表达。Study 模式下 ``Node.type`` 取学科枚举，
   Work 模式下取工作对象枚举。

2. **未命中走通用兜底**：所有模板查询都应通过 :func:`get_study_template` /
   :func:`get_work_template` 获取，未命中时返回 :data:`STUDY_TEMPLATE_DEFAULT` /
   :data:`WORK_TEMPLATE_DEFAULT`，确保详情卡不空白、不报错。

3. **用户留白类型**：用户在"我的补充"区输入内容时需选择类型，取值见
   :data:`USER_FILL_TYPES`（疑问/联想/考点/易错点/笔记）。

4. **边关系语义**：见 :data:`EDGE_RELATIONS`，Study / Work 通用，Work 模式取值参考
   设计方案.md（属于/涉及/承诺给/依赖/等待/影响/来源/替代）。

5. **节点来源标记**：见 :data:`NODE_SOURCES`，区分 Agent 抽取 / 用户手动 / 插件
   推送 / 延伸生成。
"""

from __future__ import annotations

from typing import Any

# ============================================================================
# 图谱模式
# ============================================================================

#: Study 学习模式
GRAPH_TYPE_STUDY = "study"
#: Work 工作模式
GRAPH_TYPE_WORK = "work"

GRAPH_TYPES: tuple[str, ...] = (GRAPH_TYPE_STUDY, GRAPH_TYPE_WORK)


# ============================================================================
# Study 学科节点子类型
# ============================================================================

STUDY_SUBJECT_CHINESE = "chinese"  # 语文
STUDY_SUBJECT_MATH = "math"  # 数学
STUDY_SUBJECT_ENGLISH = "english"  # 英语
STUDY_SUBJECT_HISTORY = "history"  # 历史
STUDY_SUBJECT_GEOGRAPHY = "geography"  # 地理
STUDY_SUBJECT_POLITICS = "politics"  # 政治
STUDY_SUBJECT_BIOLOGY = "biology"  # 生物
STUDY_SUBJECT_CHEMISTRY = "chemistry"  # 化学
STUDY_SUBJECT_PHYSICS = "physics"  # 物理
STUDY_SUBJECT_PROGRAMMING = "programming"  # 编程
STUDY_SUBJECT_LLM = "llm"  # 大模型
STUDY_SUBJECT_GENERAL = "general"  # 通用兜底

#: Study 学科枚举（含通用兜底，用于未命中学科时归类）
STUDY_SUBJECTS: tuple[str, ...] = (
    STUDY_SUBJECT_CHINESE,
    STUDY_SUBJECT_MATH,
    STUDY_SUBJECT_ENGLISH,
    STUDY_SUBJECT_HISTORY,
    STUDY_SUBJECT_GEOGRAPHY,
    STUDY_SUBJECT_POLITICS,
    STUDY_SUBJECT_BIOLOGY,
    STUDY_SUBJECT_CHEMISTRY,
    STUDY_SUBJECT_PHYSICS,
    STUDY_SUBJECT_PROGRAMMING,
    STUDY_SUBJECT_LLM,
    STUDY_SUBJECT_GENERAL,
)

#: 学科中文名映射（前端展示用）
STUDY_SUBJECT_LABELS: dict[str, str] = {
    STUDY_SUBJECT_CHINESE: "语文",
    STUDY_SUBJECT_MATH: "数学",
    STUDY_SUBJECT_ENGLISH: "英语",
    STUDY_SUBJECT_HISTORY: "历史",
    STUDY_SUBJECT_GEOGRAPHY: "地理",
    STUDY_SUBJECT_POLITICS: "政治",
    STUDY_SUBJECT_BIOLOGY: "生物",
    STUDY_SUBJECT_CHEMISTRY: "化学",
    STUDY_SUBJECT_PHYSICS: "物理",
    STUDY_SUBJECT_PROGRAMMING: "编程",
    STUDY_SUBJECT_LLM: "大模型",
    STUDY_SUBJECT_GENERAL: "通用",
}


# ============================================================================
# Work 工作对象节点子类型
# ============================================================================

WORK_OBJECT_THREAD = "thread"  # 工作线索
WORK_OBJECT_KEY_PERSON = "key_person"  # 关键人
WORK_OBJECT_COMMITMENT = "commitment"  # 承诺
WORK_OBJECT_EXPECTATION = "expectation"  # 期望
WORK_OBJECT_EVENT = "event"  # 事件
WORK_OBJECT_DECISION = "decision"  # 决策
WORK_OBJECT_RISK = "risk"  # 风险
WORK_OBJECT_MATERIAL = "material"  # 资料
WORK_OBJECT_PREFERENCE = "preference"  # 偏好
WORK_OBJECT_REVIEW = "review"  # 复盘

#: Work 工作对象枚举（参考设计方案.md 第一部分）
WORK_OBJECTS: tuple[str, ...] = (
    WORK_OBJECT_THREAD,
    WORK_OBJECT_KEY_PERSON,
    WORK_OBJECT_COMMITMENT,
    WORK_OBJECT_EXPECTATION,
    WORK_OBJECT_EVENT,
    WORK_OBJECT_DECISION,
    WORK_OBJECT_RISK,
    WORK_OBJECT_MATERIAL,
    WORK_OBJECT_PREFERENCE,
    WORK_OBJECT_REVIEW,
)

#: 工作对象中文名映射
WORK_OBJECT_LABELS: dict[str, str] = {
    WORK_OBJECT_THREAD: "工作线索",
    WORK_OBJECT_KEY_PERSON: "关键人",
    WORK_OBJECT_COMMITMENT: "承诺",
    WORK_OBJECT_EXPECTATION: "期望",
    WORK_OBJECT_EVENT: "事件",
    WORK_OBJECT_DECISION: "决策",
    WORK_OBJECT_RISK: "风险",
    WORK_OBJECT_MATERIAL: "资料",
    WORK_OBJECT_PREFERENCE: "偏好",
    WORK_OBJECT_REVIEW: "复盘",
}


# ============================================================================
# 详情卡模板
# ============================================================================
#
# 模板为一组字段定义：``key`` 为 detail_payload 中的字段名，``label`` 为前端展示
# 标签，``placeholder`` 为空值时的提示文案。前端按模板渲染详情卡，未命中类型走
# 通用兜底模板（不编造、不报错、不空白）。
#
# 模板结构示例（通用学科）::
#
#     [
#         {"key": "what_is", "label": "它是什么", "placeholder": "用一句话解释这个概念"},
#         {"key": "why_important", "label": "为什么重要", "placeholder": "重要性与应用场景"},
#         ...
#     ]


#: 通用学科兜底模板（未命中具体学科时使用）
STUDY_TEMPLATE_DEFAULT: list[dict[str, str]] = [
    {"key": "what_is", "label": "它是什么", "placeholder": "用一句话解释这个概念"},
    {"key": "why_important", "label": "为什么重要", "placeholder": "重要性与应用场景"},
    {"key": "key_points", "label": "关键内容", "placeholder": "核心要点与公式 / 定义"},
    {"key": "common_cases", "label": "常见场景或考法", "placeholder": "典型应用 / 考点"},
    {"key": "extensions", "label": "延伸方向", "placeholder": "可深入探索的方向"},
]

#: 学科模板表（具体学科可覆盖通用模板，未列出的学科走默认）
STUDY_TEMPLATES: dict[str, list[dict[str, str]]] = {
    STUDY_SUBJECT_CHINESE: [
        {"key": "what_is", "label": "知识点概括", "placeholder": "字词 / 文学常识 / 阅读理解要点"},
        {"key": "key_points", "label": "重要点", "placeholder": "考点 / 易错字音字形"},
        {"key": "examples", "label": "例句或出处", "placeholder": "经典例句 / 出处"},
        {"key": "extensions", "label": "延伸方向", "placeholder": "相关作家 / 体裁 / 主题"},
    ],
    STUDY_SUBJECT_MATH: [
        {"key": "what_is", "label": "知识点概括", "placeholder": "定义 / 公式 / 定理"},
        {"key": "key_points", "label": "重要点", "placeholder": "推导步骤 / 适用条件"},
        {"key": "examples", "label": "典型例题", "placeholder": "例题与解法"},
        {"key": "common_cases", "label": "常见考法", "placeholder": "题型与陷阱"},
        {"key": "extensions", "label": "延伸方向", "placeholder": "相关定理 / 拓展"},
    ],
    STUDY_SUBJECT_ENGLISH: [
        {"key": "what_is", "label": "知识点概括", "placeholder": "词汇 / 语法 / 句型"},
        {"key": "key_points", "label": "重要点", "placeholder": "用法 / 搭配 / 易错点"},
        {"key": "examples", "label": "例句", "placeholder": "例句与翻译"},
        {"key": "extensions", "label": "延伸方向", "placeholder": "相关表达 / 同义辨析"},
    ],
    STUDY_SUBJECT_HISTORY: [
        {"key": "what_is", "label": "知识点概括", "placeholder": "事件 / 人物 / 制度"},
        {"key": "key_points", "label": "重要点", "placeholder": "时间 / 地点 / 影响"},
        {"key": "examples", "label": "史料或背景", "placeholder": "相关史料 / 时代背景"},
        {"key": "extensions", "label": "延伸方向", "placeholder": "因果关联 / 横向对比"},
    ],
    STUDY_SUBJECT_GEOGRAPHY: [
        {"key": "what_is", "label": "知识点概括", "placeholder": "自然 / 人文地理现象"},
        {"key": "key_points", "label": "重要点", "placeholder": "分布 / 成因 / 规律"},
        {"key": "examples", "label": "典型案例", "placeholder": "区域案例"},
        {"key": "extensions", "label": "延伸方向", "placeholder": "相关专题 / 关联现象"},
    ],
    STUDY_SUBJECT_POLITICS: [
        {"key": "what_is", "label": "知识点概括", "placeholder": "概念 / 原理"},
        {"key": "key_points", "label": "重要点", "placeholder": "原理表述 / 适用范围"},
        {"key": "examples", "label": "时政案例", "placeholder": "时政背景与对应"},
        {"key": "extensions", "label": "延伸方向", "placeholder": "相关原理 / 体系"},
    ],
    STUDY_SUBJECT_BIOLOGY: [
        {"key": "what_is", "label": "知识点概括", "placeholder": "概念 / 机制 / 结构"},
        {"key": "key_points", "label": "重要点", "placeholder": "过程 / 条件 / 影响因素"},
        {"key": "examples", "label": "实验或实例", "placeholder": "经典实验 / 实例"},
        {"key": "extensions", "label": "延伸方向", "placeholder": "相关生理过程 / 应用"},
    ],
    STUDY_SUBJECT_CHEMISTRY: [
        {"key": "what_is", "label": "知识点概括", "placeholder": "物质 / 反应 / 原理"},
        {"key": "key_points", "label": "重要点", "placeholder": "方程式 / 条件 / 现象"},
        {"key": "examples", "label": "典型反应", "placeholder": "反应示例"},
        {"key": "extensions", "label": "延伸方向", "placeholder": "相关物质 / 反应类型"},
    ],
    STUDY_SUBJECT_PHYSICS: [
        {"key": "what_is", "label": "知识点概括", "placeholder": "概念 / 定律 / 公式"},
        {"key": "key_points", "label": "重要点", "placeholder": "适用条件 / 推导"},
        {"key": "examples", "label": "典型例题", "placeholder": "例题与解法"},
        {"key": "extensions", "label": "延伸方向", "placeholder": "相关定律 / 应用"},
    ],
    STUDY_SUBJECT_PROGRAMMING: [
        {"key": "what_is", "label": "知识点概括", "placeholder": "概念 / 语法 / API"},
        {"key": "key_points", "label": "重要点", "placeholder": "用法 / 注意事项"},
        {"key": "examples", "label": "代码示例", "placeholder": "示例代码"},
        {"key": "common_cases", "label": "常见场景", "placeholder": "典型应用 / 踩坑"},
        {"key": "extensions", "label": "延伸方向", "placeholder": "相关 API / 设计模式"},
    ],
    STUDY_SUBJECT_LLM: [
        {"key": "what_is", "label": "知识点概括", "placeholder": "概念 / 模型 / 技术"},
        {"key": "key_points", "label": "重要点", "placeholder": "原理 / 局限 / 评测"},
        {"key": "examples", "label": "示例或论文", "placeholder": "代表工作 / 论文"},
        {"key": "common_cases", "label": "应用场景", "placeholder": "落地场景 / 用法"},
        {"key": "extensions", "label": "延伸方向", "placeholder": "相关技术 / 开放问题"},
    ],
}

#: 通用工作对象兜底模板
WORK_TEMPLATE_DEFAULT: list[dict[str, str]] = [
    {"key": "summary", "label": "工作概括", "placeholder": "用一句话描述这个工作对象"},
    {"key": "key_info", "label": "关键信息", "placeholder": "时间 / 地点 / 状态等关键事实"},
    {"key": "related_persons", "label": "相关人物", "placeholder": "涉及的关键人"},
    {"key": "related_commitments", "label": "相关承诺", "placeholder": "关联的承诺 / 期望"},
    {"key": "risks", "label": "风险", "placeholder": "潜在风险与影响"},
    {"key": "extensions", "label": "延伸关联", "placeholder": "可深入探索的方向"},
]

#: 工作对象模板表（具体类型可覆盖通用模板，未列出走默认）
WORK_TEMPLATES: dict[str, list[dict[str, str]]] = {
    WORK_OBJECT_THREAD: [
        {"key": "summary", "label": "线索概括", "placeholder": "这条工作线索是什么"},
        {"key": "key_info", "label": "关键信息", "placeholder": "来源 / 时间 / 优先级"},
        {"key": "related_persons", "label": "相关人物", "placeholder": "线索涉及的关键人"},
        {"key": "risks", "label": "风险", "placeholder": "潜在风险"},
        {"key": "extensions", "label": "延伸关联", "placeholder": "可深入的下一步"},
    ],
    WORK_OBJECT_KEY_PERSON: [
        {"key": "summary", "label": "人物概括", "placeholder": "角色 / 立场 / 影响力"},
        {"key": "key_info", "label": "关键信息", "placeholder": "组织 / 联系方式 / 偏好"},
        {"key": "related_commitments", "label": "相关承诺", "placeholder": "对该人的承诺 / 期望"},
        {"key": "extensions", "label": "延伸关联", "placeholder": "可关联的事件 / 决策"},
    ],
    WORK_OBJECT_COMMITMENT: [
        {"key": "summary", "label": "承诺概括", "placeholder": "承诺的内容与对象"},
        {"key": "key_info", "label": "关键信息", "placeholder": "承诺对象 / 截止时间 / 状态"},
        {"key": "related_persons", "label": "相关人物", "placeholder": "承诺给谁"},
        {"key": "risks", "label": "风险", "placeholder": "未兑现的后果"},
        {"key": "extensions", "label": "延伸关联", "placeholder": "依赖的事件 / 决策"},
    ],
    WORK_OBJECT_EXPECTATION: [
        {"key": "summary", "label": "期望概括", "placeholder": "期望的内容"},
        {"key": "key_info", "label": "关键信息", "placeholder": "来自谁 / 时间 / 优先级"},
        {"key": "related_persons", "label": "相关人物", "placeholder": "提出者"},
        {"key": "extensions", "label": "延伸关联", "placeholder": "关联的承诺 / 决策"},
    ],
    WORK_OBJECT_EVENT: [
        {"key": "summary", "label": "事件概括", "placeholder": "发生了什么"},
        {"key": "key_info", "label": "关键信息", "placeholder": "时间 / 地点 / 参与方"},
        {"key": "related_persons", "label": "相关人物", "placeholder": "参与者"},
        {"key": "extensions", "label": "延伸关联", "placeholder": "影响的线索 / 决策"},
    ],
    WORK_OBJECT_DECISION: [
        {"key": "summary", "label": "决策概括", "placeholder": "决策内容"},
        {"key": "key_info", "label": "关键信息", "placeholder": "决策时间 / 决策者 / 依据"},
        {"key": "related_persons", "label": "相关人物", "placeholder": "决策者 / 影响的人"},
        {"key": "risks", "label": "风险", "placeholder": "决策风险"},
        {"key": "extensions", "label": "延伸关联", "placeholder": "影响的承诺 / 事件"},
    ],
    WORK_OBJECT_RISK: [
        {"key": "summary", "label": "风险概括", "placeholder": "风险描述"},
        {"key": "key_info", "label": "关键信息", "placeholder": "概率 / 影响 / 触发条件"},
        {"key": "extensions", "label": "延伸关联", "placeholder": "关联的决策 / 事件"},
    ],
    WORK_OBJECT_MATERIAL: [
        {"key": "summary", "label": "资料概括", "placeholder": "资料是什么"},
        {"key": "key_info", "label": "关键信息", "placeholder": "类型 / 来源 / 链接"},
        {"key": "extensions", "label": "延伸关联", "placeholder": "关联的线索 / 事件"},
    ],
    WORK_OBJECT_PREFERENCE: [
        {"key": "summary", "label": "偏好概括", "placeholder": "偏好内容"},
        {"key": "key_info", "label": "关键信息", "placeholder": "对象 / 范围 / 来源"},
        {"key": "extensions", "label": "延伸关联", "placeholder": "影响的决策 / 行动"},
    ],
    WORK_OBJECT_REVIEW: [
        {"key": "summary", "label": "复盘概括", "placeholder": "复盘的主题"},
        {"key": "key_info", "label": "关键信息", "placeholder": "时间 / 范围 / 结论"},
        {"key": "extensions", "label": "延伸关联", "placeholder": "复盘得出的下一步"},
    ],
}


def get_study_template(subject: str) -> list[dict[str, str]]:
    """获取 Study 学科对应的详情卡模板，未命中走通用兜底。

    Args:
        subject: 学科枚举（见 :data:`STUDY_SUBJECTS`）。

    Returns:
        模板字段列表。未命中时返回 :data:`STUDY_TEMPLATE_DEFAULT`。
    """
    return STUDY_TEMPLATES.get(subject, STUDY_TEMPLATE_DEFAULT)


def get_work_template(obj_type: str) -> list[dict[str, str]]:
    """获取 Work 工作对象对应的详情卡模板，未命中走通用兜底。

    Args:
        obj_type: 工作对象枚举（见 :data:`WORK_OBJECTS`）。

    Returns:
        模板字段列表。未命中时返回 :data:`WORK_TEMPLATE_DEFAULT`。
    """
    return WORK_TEMPLATES.get(obj_type, WORK_TEMPLATE_DEFAULT)


def get_template(graph_type: str, node_type: str) -> list[dict[str, str]]:
    """根据图谱模式与节点类型获取详情卡模板。

    Args:
        graph_type: 图谱模式（``study`` / ``work``）。
        node_type: 节点子类型。

    Returns:
        模板字段列表。未命中走对应模式的通用兜底。
    """
    if graph_type == GRAPH_TYPE_STUDY:
        return get_study_template(node_type)
    if graph_type == GRAPH_TYPE_WORK:
        return get_work_template(node_type)
    # 未知模式走 Study 通用兜底
    return STUDY_TEMPLATE_DEFAULT


def get_node_label(graph_type: str, node_type: str) -> str:
    """获取节点类型的中文名（用于前端类型标签展示）。

    Args:
        graph_type: 图谱模式。
        node_type: 节点子类型。

    Returns:
        中文名。未命中返回 ``node_type`` 原值（不报错）。
    """
    if graph_type == GRAPH_TYPE_STUDY:
        return STUDY_SUBJECT_LABELS.get(node_type, node_type)
    if graph_type == GRAPH_TYPE_WORK:
        return WORK_OBJECT_LABELS.get(node_type, node_type)
    return node_type


def is_valid_node_type(graph_type: str, node_type: str) -> bool:
    """校验节点类型是否在对应模式的合法枚举内。

    Args:
        graph_type: 图谱模式。
        node_type: 节点子类型。

    Returns:
        合法返回 True，否则 False。
    """
    if graph_type == GRAPH_TYPE_STUDY:
        return node_type in STUDY_SUBJECTS
    if graph_type == GRAPH_TYPE_WORK:
        return node_type in WORK_OBJECTS
    return False


# ============================================================================
# 用户留白类型
# ============================================================================

USER_FILL_DOUBT = "doubt"  # 疑问
USER_FILL_ASSOCIATION = "association"  # 联想
USER_FILL_EXAM_POINT = "exam_point"  # 考点
USER_FILL_ERROR_POINT = "error_point"  # 易错点
USER_FILL_NOTE = "note"  # 笔记

#: 用户留白类型枚举（用户在"我的补充"区选择）
USER_FILL_TYPES: tuple[str, ...] = (
    USER_FILL_DOUBT,
    USER_FILL_ASSOCIATION,
    USER_FILL_EXAM_POINT,
    USER_FILL_ERROR_POINT,
    USER_FILL_NOTE,
)

#: 留白类型中文名映射
USER_FILL_LABELS: dict[str, str] = {
    USER_FILL_DOUBT: "疑问",
    USER_FILL_ASSOCIATION: "联想",
    USER_FILL_EXAM_POINT: "考点",
    USER_FILL_ERROR_POINT: "易错点",
    USER_FILL_NOTE: "笔记",
}


# ============================================================================
# 节点来源标记
# ============================================================================

NODE_SOURCE_AGENT = "agent"  # Agent 抽取
NODE_SOURCE_USER = "user"  # 用户手动创建
NODE_SOURCE_PLUGIN = "plugin"  # 插件推送后 Agent 抽取
NODE_SOURCE_EXTENSION = "extension"  # 延伸生成（双击全部延伸 / 单击单点延伸）

NODE_SOURCES: tuple[str, ...] = (
    NODE_SOURCE_AGENT,
    NODE_SOURCE_USER,
    NODE_SOURCE_PLUGIN,
    NODE_SOURCE_EXTENSION,
)


# ============================================================================
# 边关系语义
# ============================================================================

EDGE_RELATED = "related"  # 通用关联
EDGE_PREREQUISITE = "prerequisite"  # 前置（Study：A 是 B 的前置知识）
EDGE_EXTENDS = "extends"  # 延伸（A 是 B 的延伸节点）
EDGE_BELONGS_TO = "belongs_to"  # 属于（Work：A 属于 B）
EDGE_INVOLVES = "involves"  # 涉及（Work：A 涉及 B）
EDGE_COMMITTED_TO = "committed_to"  # 承诺给（Work：A 承诺给 B）
EDGE_DEPENDS_ON = "depends_on"  # 依赖（Work：A 依赖 B）
EDGE_WAITING_FOR = "waiting_for"  # 等待（Work：A 等待 B）
EDGE_INFLUENCES = "influences"  # 影响（Work：A 影响 B）
EDGE_SOURCE_OF = "source_of"  # 来源（Work：A 是 B 的来源）
EDGE_ALTERNATIVE_TO = "alternative_to"  # 替代（Work：A 替代 B）

#: 边关系语义枚举（Study / Work 通用，Work 模式参考设计方案.md）
EDGE_RELATIONS: tuple[str, ...] = (
    EDGE_RELATED,
    EDGE_PREREQUISITE,
    EDGE_EXTENDS,
    EDGE_BELONGS_TO,
    EDGE_INVOLVES,
    EDGE_COMMITTED_TO,
    EDGE_DEPENDS_ON,
    EDGE_WAITING_FOR,
    EDGE_INFLUENCES,
    EDGE_SOURCE_OF,
    EDGE_ALTERNATIVE_TO,
)

#: 边关系中文名映射
EDGE_RELATION_LABELS: dict[str, str] = {
    EDGE_RELATED: "关联",
    EDGE_PREREQUISITE: "前置",
    EDGE_EXTENDS: "延伸",
    EDGE_BELONGS_TO: "属于",
    EDGE_INVOLVES: "涉及",
    EDGE_COMMITTED_TO: "承诺给",
    EDGE_DEPENDS_ON: "依赖",
    EDGE_WAITING_FOR: "等待",
    EDGE_INFLUENCES: "影响",
    EDGE_SOURCE_OF: "来源",
    EDGE_ALTERNATIVE_TO: "替代",
}


# ============================================================================
# 测验题型
# ============================================================================

QUIZ_SINGLE_CHOICE = "single_choice"  # 单选题
QUIZ_MULTI_CHOICE = "multi_choice"  # 多选题
QUIZ_FEYNMAN = "feynman"  # 费曼解释题

QUIZ_TYPES: tuple[str, ...] = (
    QUIZ_SINGLE_CHOICE,
    QUIZ_MULTI_CHOICE,
    QUIZ_FEYNMAN,
)

QUIZ_TYPE_LABELS: dict[str, str] = {
    QUIZ_SINGLE_CHOICE: "单选题",
    QUIZ_MULTI_CHOICE: "多选题",
    QUIZ_FEYNMAN: "费曼解释题",
}


# ============================================================================
# 观察来源
# ============================================================================

OBSERVATION_SOURCE_PLUGIN = "plugin"  # 浏览器插件推送
OBSERVATION_SOURCE_IMPORT = "import"  # 手动导入
OBSERVATION_SOURCE_MANUAL = "manual"  # 应用内输入

OBSERVATION_SOURCES: tuple[str, ...] = (
    OBSERVATION_SOURCE_PLUGIN,
    OBSERVATION_SOURCE_IMPORT,
    OBSERVATION_SOURCE_MANUAL,
)


# ============================================================================
# 工具函数
# ============================================================================


def default_detail_payload(graph_type: str, node_type: str) -> dict[str, Any]:
    """根据节点类型生成默认的 detail_payload（空值占位）。

    用于新建节点时初始化 ``detail_payload``，确保前端按模板渲染时所有字段存在。

    Args:
        graph_type: 图谱模式。
        node_type: 节点子类型。

    Returns:
        ``{field_key: ""}`` 形式的字典。
    """
    template = get_template(graph_type, node_type)
    return {field["key"]: "" for field in template}


def default_user_fill() -> dict[str, list[str]]:
    """生成默认的 user_fill 结构（各类型初始为空列表）。

    Returns:
        ``{doubt: [], association: [], exam_point: [], error_point: [], note: []}``。
    """
    return {t: [] for t in USER_FILL_TYPES}
