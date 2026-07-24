# 对话瀑布流与智能推荐重构 Spec

## Why
原 `build-knowledge-work-assistant` 已完成基础双模式知识图谱软件，但存在两类待解决问题：①遗留 bug（设置面板空白、新建图谱偶尔无法输入名字）影响基本可用性；②对话页当前只是「Work 提问入口 + Study 引导提示」，缺乏用户进入软件后第一眼看到的「今天该关注什么」的智能推荐流。本次迭代把对话页重构为「中间输入框 + 下方瀑布推荐卡片」的首页形态，并配套扩展数据模型以支撑学习侧（遗忘曲线 + 提问热度 + 题目错误率）与工作侧（提醒时间 + 用户标记）的个性化推荐，同时把设置从主导航下沉为 SideNav 底部独立图标。

## What Changes
- **修复 bug**：设置面板点击后空白（疑似轮询/数据加载链路异常）；新建图谱输入框偶尔无法输入（疑似焦点丢失）。
- **设置位置重构**：SideNav 主导航只保留「对话 / 图谱」两项，设置作为独立图标通过 `margin-top:auto` 下沉到 SideNav 最底部，与主导航视觉分隔。
- **对话页重构为首页**：
  - 顶部居中输入框（Study 模式占位为「输入要复习/搜索的知识点」；Work 模式为「输入工作提问」）。
  - 下方瀑布流展示推荐卡片，卡片按推荐分排序，支持滚动加载。
  - 保留 Work 模式完整对话能力（输入框提问 → Agent 回答），消息列表在输入框上方/瀑布流之上叠加显示。
- **学习模式推荐排序**：综合三项指标计算推荐分：
  - 遗忘曲线：基于 `last_reviewed_at` 与 `review_count`，越久未复习且复习次数少 → 分越高。
  - 提问热度：基于节点在对话/测验中被提及次数（新字段 `mention_count`），热度低且久未复习 → 适度提分；热度高但错误率高 → 提分。
  - 题目错误率：基于 Quiz 表统计该节点相关题目的错误率，错误率越高 → 分越高。
- **工作模式推荐排序**：
  - 识别 `remind_at` 字段：临近/到期的卡片优先展示，已过期标红。
  - 用户标记：节点 `type`（承诺/风险/事件等）+ 用户手动「星标」字段 `is_starred`，星标优先。
  - 工作图卡片新增「提醒我」按钮：弹出 datetime 选择器，确认后写入 `remind_at`。
- **轻量通知**：当存在到期/临近提醒时，SideNav「对话」图标右上角红点角标 + 对话页顶部一条「N 项提醒已到期」横幅，点击跳转到对应卡片；不做系统级弹窗。
- **数据模型扩展**：
  - `Node` 新增 `last_reviewed_at`（DateTime, nullable）、`review_count`（Int, default 0）、`mention_count`（Int, default 0）、`remind_at`（DateTime, nullable）、`is_starred`（Boolean, default False）。
  - 节点详情卡被打开 / 测验作答时自动更新 `last_reviewed_at` 与 `review_count`。
  - 抽取/延伸/提问命中节点时更新 `mention_count`。
- **后端新接口**：
  - `GET /api/graphs/{gid}/recommendations?mode=study|work&limit=N`：返回按推荐分排序的节点列表，每项含推荐理由（哪项指标贡献最大）。
  - `POST /api/nodes/{id}/remind`：设置/更新 `remind_at`。
  - `DELETE /api/nodes/{id}/remind`：清除提醒。
  - `POST /api/nodes/{id}/star` / `DELETE /api/nodes/{id}/star`：星标切换。
  - `POST /api/nodes/{id}/touch`：更新 `last_reviewed_at` + `review_count`（详情卡打开时调用）。
- **前端**：
  - 新增 `ChatHome`（瀑布流首页）+ `RecommendationCard` 组件。
  - 改造 `ChatPanel`：Study 模式不再只显示引导提示，而是显示首页瀑布流；Work 模式在无消息时显示首页瀑布流，有消息时切换为对话视图（顶部仍保留输入框入口）。
  - `SideNav` 重构：主导航 chat/graph 在上，settings 用 `margin-top:auto` 推到底部，加分隔线。
  - `NodeDetailCard` 打开时调用 `touch` 接口；Work 节点详情卡新增「提醒我」「星标」按钮。

## Impact
- Affected specs: `build-knowledge-work-assistant`（基础项目，本次在其上扩展）
- Affected code:
  - 前端：`SideNav.tsx`、`ChatPanel.tsx`（重构）、`SettingsPanel.tsx`（修 bug）、`GraphList.tsx`（修 bug）、`NodeDetailCard.tsx`（新增提醒/星标/touch）、`useAppStore.ts`（新增推荐/提醒/星标状态与动作）、`api.ts`（新增接口）、`types.ts`（新增字段）、`app.css`（首页瀑布流样式）。
  - 后端：`db_models.py`（Node 表扩展字段 + 迁移）、`graph_store.py`（CRUD 扩展）、新 router `recommendations.py`、`llm_admin.py`（排查设置面板 bug）。
  - 新组件：`ChatHome.tsx`、`RecommendationCard.tsx`、`ReminderBanner.tsx`。

## ADDED Requirements

### Requirement: 设置下沉到 SideNav 底部
The system SHALL move the settings entry out of the main 3-item nav and pin it to the bottom of SideNav, visually separated from the main nav (chat / graph).

#### Scenario: 设置独立下沉
- **WHEN** 用户查看左侧 SideNav
- **THEN** 顶部主导航只显示「对话」「图谱」两项；设置图标通过分隔线 + 顶部留白固定在 SideNav 最底部；点击设置仍切换到 SettingsPanel

### Requirement: 对话页瀑布流首页
The system SHALL render the chat panel as a home page with a centered input box on top and a waterfall of recommendation cards below, mode-aware.

#### Scenario: Study 模式首页
- **WHEN** 用户在 Study 模式点击「对话」导航
- **THEN** 顶部显示居中输入框（占位「输入要复习/搜索的知识点」），下方瀑布流展示学习推荐卡片（按遗忘曲线+提问热度+错误率综合排序），每张卡片显示节点标题、推荐理由、上次复习时间、错误率

#### Scenario: Work 模式首页（无对话时）
- **WHEN** 用户在 Work 模式点击「对话」且当前无对话消息
- **THEN** 顶部显示居中输入框（占位「输入工作提问」），下方瀑布流展示工作推荐卡片（按提醒时间+星标+类型排序），到期/临近卡片置顶并标红

#### Scenario: Work 模式切到对话视图
- **WHEN** Work 模式下用户发送了第一条提问
- **THEN** 界面切换为对话视图（保留顶部输入框，上方显示消息列表），瀑布流收起；用户可点击「返回首页」回到瀑布流

### Requirement: 学习推荐分计算
The system SHALL compute a recommendation score per node combining forgetting curve, question heat, and quiz error rate.

#### Scenario: 计算推荐分
- **WHEN** 后端收到 `GET /api/graphs/{gid}/recommendations?mode=study`
- **THEN** 对当前 study 图谱每个节点计算：遗忘分（基于 `last_reviewed_at` 与 `review_count`，越久未复习越高）、热度分（基于 `mention_count`，低热度适度提分）、错误率分（基于 Quiz 错误率，越高越高）；综合排序后返回 top-N，每项附推荐理由（哪项指标贡献最大）

### Requirement: 工作推荐分计算
The system SHALL compute a recommendation score per work node based on remind_at proximity, star marker, and node type.

#### Scenario: 工作推荐排序
- **WHEN** 后端收到 `GET /api/graphs/{gid}/recommendations?mode=work`
- **THEN** 已到期 `remind_at` 置顶并标红 → 临近 24h 内次之 → 星标节点 → 按类型权重（承诺/风险优先）；返回 top-N 含推荐理由

### Requirement: 节点提醒设置
The system SHALL allow users to set a reminder datetime on work nodes, with lightweight in-app notification.

#### Scenario: 设置提醒
- **WHEN** 用户在 Work 节点详情卡点击「提醒我」并选择时间
- **THEN** 调用 `POST /api/nodes/{id}/remind` 写入 `remind_at`，卡片显示提醒时间徽标

#### Scenario: 提醒到期轻量通知
- **WHEN** 存在 `remind_at` 已到期的节点
- **THEN** SideNav「对话」图标右上角显示红点角标（数字=到期数）；对话页顶部显示「N 项提醒已到期」横幅，点击横幅滚动到对应卡片

### Requirement: 节点星标
The system SHALL allow users to star/unstar any node for priority recommendation.

#### Scenario: 星标节点
- **WHEN** 用户在节点详情卡点击「星标」
- **THEN** 调用 `POST /api/nodes/{id}/star` 写入 `is_starred=true`，卡片显示星标图标；推荐排序中星标节点适度提前

### Requirement: 学习行为追踪
The system SHALL track per-node learning behavior (last review time, review count, mention count) for recommendation scoring.

#### Scenario: 打开详情卡触发 touch
- **WHEN** 用户打开节点详情卡（悬停或固定态）
- **THEN** 前端调用 `POST /api/nodes/{id}/touch`，后端更新 `last_reviewed_at=now`、`review_count+=1`

#### Scenario: 提问/抽取触发 mention
- **WHEN** Agent 在抽取/延伸/提问中命中某节点
- **THEN** 后端对该节点 `mention_count+=1`

### Requirement: 数据模型扩展
The system SHALL extend the Node model with learning and reminder fields.

#### Scenario: 字段扩展
- **WHEN** 后端启动
- **THEN** Node 表含 `last_reviewed_at`（DateTime nullable）、`review_count`（Int default 0）、`mention_count`（Int default 0）、`remind_at`（DateTime nullable）、`is_starred`（Boolean default False）；旧数据迁移时这些字段取默认值

## MODIFIED Requirements

### Requirement: 设置面板（原 build-knowledge-work-assistant 隐含）
设置面板 SHALL 在点击后正常显示 API 配置区与请求队列区，不再出现空白。

#### Scenario: 点击设置不空白
- **WHEN** 用户点击 SideNav 底部设置图标
- **THEN** SettingsPanel 正常渲染 API 配置表单与请求队列列表；即使后端 `/api/llm/config` 或 `/api/llm/requests` 失败，也显示明确的错误提示而非空白

### Requirement: 新建图谱输入框（原 build-knowledge-work-assistant 隐含）
新建图谱输入框 SHALL 在所有情况下稳定接收输入，不出现无法输入的情况。

#### Scenario: 稳定输入
- **WHEN** 用户多次点击「新建」创建图谱
- **THEN** 输入框始终能获取焦点并接收键盘输入；不会因列表刷新/重渲染导致失焦

## REMOVED Requirements
无（本次为增量扩展，不移除既有能力）。
