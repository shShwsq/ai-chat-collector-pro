/**
 * 前端节点模板定义（Task 7.3）。
 *
 * 与 backend/app/models/node_types.py 一一对应的镜像常量：
 * - 学科 / 工作对象枚举与中文标签
 * - 详情卡模板字段（STUDY_TEMPLATES / WORK_TEMPLATES + 通用兜底）
 * - 用户留白类型枚举与标签
 *
 * 前端按 ``getTemplate(graphType, nodeType)`` 选择模板，渲染详情卡对应字段；
 * 未命中类型走通用兜底模板（不空白、不报错）。类型切换时重新解析模板并渲染。
 */

import type { Mode } from './types'

// ============================================================================
// Study 学科节点子类型
// ============================================================================

export const STUDY_SUBJECT_CHINESE = 'chinese'
export const STUDY_SUBJECT_MATH = 'math'
export const STUDY_SUBJECT_ENGLISH = 'english'
export const STUDY_SUBJECT_HISTORY = 'history'
export const STUDY_SUBJECT_GEOGRAPHY = 'geography'
export const STUDY_SUBJECT_POLITICS = 'politics'
export const STUDY_SUBJECT_BIOLOGY = 'biology'
export const STUDY_SUBJECT_CHEMISTRY = 'chemistry'
export const STUDY_SUBJECT_PHYSICS = 'physics'
export const STUDY_SUBJECT_PROGRAMMING = 'programming'
export const STUDY_SUBJECT_LLM = 'llm'
export const STUDY_SUBJECT_GENERAL = 'general'

/** Study 学科枚举（含通用兜底）。 */
export const STUDY_SUBJECTS = [
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
] as const

/** 学科中文名映射（前端展示用）。 */
export const STUDY_SUBJECT_LABELS: Record<string, string> = {
  [STUDY_SUBJECT_CHINESE]: '语文',
  [STUDY_SUBJECT_MATH]: '数学',
  [STUDY_SUBJECT_ENGLISH]: '英语',
  [STUDY_SUBJECT_HISTORY]: '历史',
  [STUDY_SUBJECT_GEOGRAPHY]: '地理',
  [STUDY_SUBJECT_POLITICS]: '政治',
  [STUDY_SUBJECT_BIOLOGY]: '生物',
  [STUDY_SUBJECT_CHEMISTRY]: '化学',
  [STUDY_SUBJECT_PHYSICS]: '物理',
  [STUDY_SUBJECT_PROGRAMMING]: '编程',
  [STUDY_SUBJECT_LLM]: '大模型',
  [STUDY_SUBJECT_GENERAL]: '通用',
}

// ============================================================================
// Work 工作对象节点子类型
// ============================================================================

export const WORK_OBJECT_THREAD = 'thread'
export const WORK_OBJECT_KEY_PERSON = 'key_person'
export const WORK_OBJECT_COMMITMENT = 'commitment'
export const WORK_OBJECT_EXPECTATION = 'expectation'
export const WORK_OBJECT_EVENT = 'event'
export const WORK_OBJECT_DECISION = 'decision'
export const WORK_OBJECT_RISK = 'risk'
export const WORK_OBJECT_MATERIAL = 'material'
export const WORK_OBJECT_PREFERENCE = 'preference'
export const WORK_OBJECT_REVIEW = 'review'

/** Work 工作对象枚举。 */
export const WORK_OBJECTS = [
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
] as const

/** 工作对象中文名映射。 */
export const WORK_OBJECT_LABELS: Record<string, string> = {
  [WORK_OBJECT_THREAD]: '工作线索',
  [WORK_OBJECT_KEY_PERSON]: '关键人',
  [WORK_OBJECT_COMMITMENT]: '承诺',
  [WORK_OBJECT_EXPECTATION]: '期望',
  [WORK_OBJECT_EVENT]: '事件',
  [WORK_OBJECT_DECISION]: '决策',
  [WORK_OBJECT_RISK]: '风险',
  [WORK_OBJECT_MATERIAL]: '资料',
  [WORK_OBJECT_PREFERENCE]: '偏好',
  [WORK_OBJECT_REVIEW]: '复盘',
}

// ============================================================================
// 详情卡模板
// ============================================================================

/** 模板字段定义。 */
export interface TemplateField {
  /** detail_payload 中的字段名。 */
  key: string
  /** 前端展示标签。 */
  label: string
  /** 空值时的提示文案。 */
  placeholder: string
}

/** 通用学科兜底模板（未命中具体学科时使用）。 */
export const STUDY_TEMPLATE_DEFAULT: TemplateField[] = [
  { key: 'what_is', label: '它是什么', placeholder: '用一句话解释这个概念' },
  { key: 'why_important', label: '为什么重要', placeholder: '重要性与应用场景' },
  { key: 'key_points', label: '关键内容', placeholder: '核心要点与公式 / 定义' },
  { key: 'common_cases', label: '常见场景或考法', placeholder: '典型应用 / 考点' },
  { key: 'extensions', label: '延伸方向', placeholder: '可深入探索的方向' },
]

/** 学科模板表（具体学科覆盖通用模板，未列出走默认）。 */
export const STUDY_TEMPLATES: Record<string, TemplateField[]> = {
  [STUDY_SUBJECT_CHINESE]: [
    { key: 'what_is', label: '知识点概括', placeholder: '字词 / 文学常识 / 阅读理解要点' },
    { key: 'key_points', label: '重要点', placeholder: '考点 / 易错字音字形' },
    { key: 'examples', label: '例句或出处', placeholder: '经典例句 / 出处' },
    { key: 'extensions', label: '延伸方向', placeholder: '相关作家 / 体裁 / 主题' },
  ],
  [STUDY_SUBJECT_MATH]: [
    { key: 'what_is', label: '知识点概括', placeholder: '定义 / 公式 / 定理' },
    { key: 'key_points', label: '重要点', placeholder: '推导步骤 / 适用条件' },
    { key: 'examples', label: '典型例题', placeholder: '例题与解法' },
    { key: 'common_cases', label: '常见考法', placeholder: '题型与陷阱' },
    { key: 'extensions', label: '延伸方向', placeholder: '相关定理 / 拓展' },
  ],
  [STUDY_SUBJECT_ENGLISH]: [
    { key: 'what_is', label: '知识点概括', placeholder: '词汇 / 语法 / 句型' },
    { key: 'key_points', label: '重要点', placeholder: '用法 / 搭配 / 易错点' },
    { key: 'examples', label: '例句', placeholder: '例句与翻译' },
    { key: 'extensions', label: '延伸方向', placeholder: '相关表达 / 同义辨析' },
  ],
  [STUDY_SUBJECT_HISTORY]: [
    { key: 'what_is', label: '知识点概括', placeholder: '事件 / 人物 / 制度' },
    { key: 'key_points', label: '重要点', placeholder: '时间 / 地点 / 影响' },
    { key: 'examples', label: '史料或背景', placeholder: '相关史料 / 时代背景' },
    { key: 'extensions', label: '延伸方向', placeholder: '因果关联 / 横向对比' },
  ],
  [STUDY_SUBJECT_GEOGRAPHY]: [
    { key: 'what_is', label: '知识点概括', placeholder: '自然 / 人文地理现象' },
    { key: 'key_points', label: '重要点', placeholder: '分布 / 成因 / 规律' },
    { key: 'examples', label: '典型案例', placeholder: '区域案例' },
    { key: 'extensions', label: '延伸方向', placeholder: '相关专题 / 关联现象' },
  ],
  [STUDY_SUBJECT_POLITICS]: [
    { key: 'what_is', label: '知识点概括', placeholder: '概念 / 原理' },
    { key: 'key_points', label: '重要点', placeholder: '原理表述 / 适用范围' },
    { key: 'examples', label: '时政案例', placeholder: '时政背景与对应' },
    { key: 'extensions', label: '延伸方向', placeholder: '相关原理 / 体系' },
  ],
  [STUDY_SUBJECT_BIOLOGY]: [
    { key: 'what_is', label: '知识点概括', placeholder: '概念 / 机制 / 结构' },
    { key: 'key_points', label: '重要点', placeholder: '过程 / 条件 / 影响因素' },
    { key: 'examples', label: '实验或实例', placeholder: '经典实验 / 实例' },
    { key: 'extensions', label: '延伸方向', placeholder: '相关生理过程 / 应用' },
  ],
  [STUDY_SUBJECT_CHEMISTRY]: [
    { key: 'what_is', label: '知识点概括', placeholder: '物质 / 反应 / 原理' },
    { key: 'key_points', label: '重要点', placeholder: '方程式 / 条件 / 现象' },
    { key: 'examples', label: '典型反应', placeholder: '反应示例' },
    { key: 'extensions', label: '延伸方向', placeholder: '相关物质 / 反应类型' },
  ],
  [STUDY_SUBJECT_PHYSICS]: [
    { key: 'what_is', label: '知识点概括', placeholder: '概念 / 定律 / 公式' },
    { key: 'key_points', label: '重要点', placeholder: '适用条件 / 推导' },
    { key: 'examples', label: '典型例题', placeholder: '例题与解法' },
    { key: 'extensions', label: '延伸方向', placeholder: '相关定律 / 应用' },
  ],
  [STUDY_SUBJECT_PROGRAMMING]: [
    { key: 'what_is', label: '知识点概括', placeholder: '概念 / 语法 / API' },
    { key: 'key_points', label: '重要点', placeholder: '用法 / 注意事项' },
    { key: 'examples', label: '代码示例', placeholder: '示例代码' },
    { key: 'common_cases', label: '常见场景', placeholder: '典型应用 / 踩坑' },
    { key: 'extensions', label: '延伸方向', placeholder: '相关 API / 设计模式' },
  ],
  [STUDY_SUBJECT_LLM]: [
    { key: 'what_is', label: '知识点概括', placeholder: '概念 / 模型 / 技术' },
    { key: 'key_points', label: '重要点', placeholder: '原理 / 局限 / 评测' },
    { key: 'examples', label: '示例或论文', placeholder: '代表工作 / 论文' },
    { key: 'common_cases', label: '应用场景', placeholder: '落地场景 / 用法' },
    { key: 'extensions', label: '延伸方向', placeholder: '相关技术 / 开放问题' },
  ],
}

/** 通用工作对象兜底模板。 */
export const WORK_TEMPLATE_DEFAULT: TemplateField[] = [
  { key: 'summary', label: '工作概括', placeholder: '用一句话描述这个工作对象' },
  { key: 'key_info', label: '关键信息', placeholder: '时间 / 地点 / 状态等关键事实' },
  { key: 'related_persons', label: '相关人物', placeholder: '涉及的关键人' },
  { key: 'related_commitments', label: '相关承诺', placeholder: '关联的承诺 / 期望' },
  { key: 'risks', label: '风险', placeholder: '潜在风险与影响' },
  { key: 'extensions', label: '延伸关联', placeholder: '可深入探索的方向' },
]

/** 工作对象模板表（具体类型覆盖通用模板，未列出走默认）。 */
export const WORK_TEMPLATES: Record<string, TemplateField[]> = {
  [WORK_OBJECT_THREAD]: [
    { key: 'summary', label: '线索概括', placeholder: '这条工作线索是什么' },
    { key: 'key_info', label: '关键信息', placeholder: '来源 / 时间 / 优先级' },
    { key: 'related_persons', label: '相关人物', placeholder: '线索涉及的关键人' },
    { key: 'risks', label: '风险', placeholder: '潜在风险' },
    { key: 'extensions', label: '延伸关联', placeholder: '可深入的下一步' },
  ],
  [WORK_OBJECT_KEY_PERSON]: [
    { key: 'summary', label: '人物概括', placeholder: '角色 / 立场 / 影响力' },
    { key: 'key_info', label: '关键信息', placeholder: '组织 / 联系方式 / 偏好' },
    { key: 'related_commitments', label: '相关承诺', placeholder: '对该人的承诺 / 期望' },
    { key: 'extensions', label: '延伸关联', placeholder: '可关联的事件 / 决策' },
  ],
  [WORK_OBJECT_COMMITMENT]: [
    { key: 'summary', label: '承诺概括', placeholder: '承诺的内容与对象' },
    { key: 'key_info', label: '关键信息', placeholder: '承诺对象 / 截止时间 / 状态' },
    { key: 'related_persons', label: '相关人物', placeholder: '承诺给谁' },
    { key: 'risks', label: '风险', placeholder: '未兑现的后果' },
    { key: 'extensions', label: '延伸关联', placeholder: '依赖的事件 / 决策' },
  ],
  [WORK_OBJECT_EXPECTATION]: [
    { key: 'summary', label: '期望概括', placeholder: '期望的内容' },
    { key: 'key_info', label: '关键信息', placeholder: '来自谁 / 时间 / 优先级' },
    { key: 'related_persons', label: '相关人物', placeholder: '提出者' },
    { key: 'extensions', label: '延伸关联', placeholder: '关联的承诺 / 决策' },
  ],
  [WORK_OBJECT_EVENT]: [
    { key: 'summary', label: '事件概括', placeholder: '发生了什么' },
    { key: 'key_info', label: '关键信息', placeholder: '时间 / 地点 / 参与方' },
    { key: 'related_persons', label: '相关人物', placeholder: '参与者' },
    { key: 'extensions', label: '延伸关联', placeholder: '影响的线索 / 决策' },
  ],
  [WORK_OBJECT_DECISION]: [
    { key: 'summary', label: '决策概括', placeholder: '决策内容' },
    { key: 'key_info', label: '关键信息', placeholder: '决策时间 / 决策者 / 依据' },
    { key: 'related_persons', label: '相关人物', placeholder: '决策者 / 影响的人' },
    { key: 'risks', label: '风险', placeholder: '决策风险' },
    { key: 'extensions', label: '延伸关联', placeholder: '影响的承诺 / 事件' },
  ],
  [WORK_OBJECT_RISK]: [
    { key: 'summary', label: '风险概括', placeholder: '风险描述' },
    { key: 'key_info', label: '关键信息', placeholder: '概率 / 影响 / 触发条件' },
    { key: 'extensions', label: '延伸关联', placeholder: '关联的决策 / 事件' },
  ],
  [WORK_OBJECT_MATERIAL]: [
    { key: 'summary', label: '资料概括', placeholder: '资料是什么' },
    { key: 'key_info', label: '关键信息', placeholder: '类型 / 来源 / 链接' },
    { key: 'extensions', label: '延伸关联', placeholder: '关联的线索 / 事件' },
  ],
  [WORK_OBJECT_PREFERENCE]: [
    { key: 'summary', label: '偏好概括', placeholder: '偏好内容' },
    { key: 'key_info', label: '关键信息', placeholder: '对象 / 范围 / 来源' },
    { key: 'extensions', label: '延伸关联', placeholder: '影响的决策 / 行动' },
  ],
  [WORK_OBJECT_REVIEW]: [
    { key: 'summary', label: '复盘概括', placeholder: '复盘的主题' },
    { key: 'key_info', label: '关键信息', placeholder: '时间 / 范围 / 结论' },
    { key: 'extensions', label: '延伸关联', placeholder: '复盘得出的下一步' },
  ],
}

// ============================================================================
// 用户留白类型
// ============================================================================

export const USER_FILL_DOUBT = 'doubt'
export const USER_FILL_ASSOCIATION = 'association'
export const USER_FILL_EXAM_POINT = 'exam_point'
export const USER_FILL_ERROR_POINT = 'error_point'
export const USER_FILL_NOTE = 'note'

/** 用户留白类型枚举（疑问 / 联想 / 考点 / 易错点 / 笔记）。 */
export const USER_FILL_TYPES = [
  USER_FILL_DOUBT,
  USER_FILL_ASSOCIATION,
  USER_FILL_EXAM_POINT,
  USER_FILL_ERROR_POINT,
  USER_FILL_NOTE,
] as const

/** 留白类型中文名映射。 */
export const USER_FILL_LABELS: Record<string, string> = {
  [USER_FILL_DOUBT]: '疑问',
  [USER_FILL_ASSOCIATION]: '联想',
  [USER_FILL_EXAM_POINT]: '考点',
  [USER_FILL_ERROR_POINT]: '易错点',
  [USER_FILL_NOTE]: '笔记',
}

// ============================================================================
// detail_payload 元数据键（与后端 nodes.py 对齐）
// ============================================================================

/** detail_payload 中存放生成结果的特殊键（加下划线前缀避免与模板字段冲突）。 */
export const DETAIL_KEY_IMPORTANT = '_important_points'
export const DETAIL_KEY_EXTENSIONS = '_extension_directions'
export const DETAIL_KEY_SUMMARY = '_generated_summary'
export const DETAIL_KEY_DEGRADED = '_degraded'
export const DETAIL_KEY_REASON = '_degrade_reason'
export const DETAIL_KEY_TEMPLATE = '_template_used'

// ============================================================================
// 工具函数
// ============================================================================

/** 获取 Study 学科对应的详情卡模板，未命中走通用兜底。 */
export function getStudyTemplate(subject: string): TemplateField[] {
  return STUDY_TEMPLATES[subject] ?? STUDY_TEMPLATE_DEFAULT
}

/** 获取 Work 工作对象对应的详情卡模板，未命中走通用兜底。 */
export function getWorkTemplate(objType: string): TemplateField[] {
  return WORK_TEMPLATES[objType] ?? WORK_TEMPLATE_DEFAULT
}

/** 根据图谱模式与节点类型获取详情卡模板。 */
export function getTemplate(graphType: Mode, nodeType: string): TemplateField[] {
  if (graphType === 'study') return getStudyTemplate(nodeType)
  if (graphType === 'work') return getWorkTemplate(nodeType)
  return STUDY_TEMPLATE_DEFAULT
}

/** 获取节点类型的中文名（用于类型标签展示），未命中返回原值。 */
export function getNodeLabel(graphType: Mode, nodeType: string): string {
  if (graphType === 'study') return STUDY_SUBJECT_LABELS[nodeType] ?? nodeType
  if (graphType === 'work') return WORK_OBJECT_LABELS[nodeType] ?? nodeType
  return nodeType
}

/** 获取某模式下全部可选类型（用于类型切换下拉），返回 [{value, label}]。 */
export function getTypeOptions(
  graphType: Mode,
): { value: string; label: string }[] {
  if (graphType === 'work') {
    return WORK_OBJECTS.map((v) => ({ value: v, label: WORK_OBJECT_LABELS[v] }))
  }
  return STUDY_SUBJECTS.map((v) => ({
    value: v,
    label: STUDY_SUBJECT_LABELS[v],
  }))
}

/** 判断节点类型是否为通用兜底（需要推断 / 可切换到更具体类型）。 */
export function isGenericStudyType(nodeType: string): boolean {
  return nodeType === STUDY_SUBJECT_GENERAL || !(nodeType in STUDY_TEMPLATES)
}

/** 从 detail_payload 剔除下划线前缀元数据键，返回纯模板字段 dict。 */
export function stripMetaKeys(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(payload)) {
    if (!k.startsWith('_')) out[k] = v
  }
  return out
}
