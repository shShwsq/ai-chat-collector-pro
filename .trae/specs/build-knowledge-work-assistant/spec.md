# 知识工作助手（Knowledge Work Assistant）规格说明

## Why
用户需要一个长期使用的双模式（Study / Work）知识图谱软件：学习侧把浏览器插件采集的 AI 对话沉淀为可视化的知识无向图，并自动出题检验学习效果；工作侧以工作对象（线索/承诺/关键人等）为节点，辅助整理长程上下文、推荐行业风口、生成工作报告。软件复用「步影」的 Electron + React + FastAPI 架构与 Agent / 文件管理 / 上下文管理代码，与浏览器插件通过预留接口对接（插件不由用户开发）。

## What Changes
- 新建项目 `knowledge-work-assistant/`，采用 Electron + React + TypeScript 前端 + Python FastAPI 后端，参考并拷贝适配步影的 `main_agent / sub_agent / knowledge_store / file_storage / llm_factory / llm_client / ws_notify` 等模块。
- 右上角实现 Study / Work 模式切换开关，切换流畅、状态清晰；模式与图谱类型绑定，study 与 work 图谱互不互通。
- Study 模式：
  - 预留浏览器插件对接接口（POST webhook，先空实现，仅定义契约）。
  - Agent 从收集的对话中自动抽取知识点作为图谱初始节点。
  - 知识图谱以无向图呈现，**节点本身渲染为小卡片**（常显标题 + 一句话概括 + 类型标签），允许孤立节点。
  - 悬停节点显示详情卡（节点标题 + 知识点概括 + 重要点 + 延伸方向推荐 + 用户留白区）。
  - **双击节点 = 生成全部延伸内容**，新生成的节点标记为灰色并与被双击节点建立连接；单击推荐方向 = 仅生成该方向一个延伸节点。
  - 测验生成：选择题（单选/多选）+ 费曼解释题，Agent 自动出题与判分。
  - 节点详情卡按学科模板展示（通用 / 人文社科 / 理科 / 技术 / 学科细分），未命中走通用兜底模板。
  - 用户可编辑、删除节点；用户留白可保存为疑问/联想/考点/易错点/笔记。
- Work 模式：
  - 图谱节点以工作对象为基本单元（工作线索 / 关键人 / 承诺 / 期望 / 事件 / 决策 / 风险 / 资料 / 偏好 / 复盘，按设计方案.md 第一部分）。
  - 行业风口推荐：独立侧栏列表 + 可一键转为图谱节点深入探索。
  - 自动生成标准化工作报告（Markdown + 可导出 docx + HTML 预览/打印 PDF）。
  - 支持用户提问获取工作相关信息（Agent 基于工作图谱上下文回答）。
- 双视图并重可切换：图谱视图（无向图）与卡片视图（今日上下文 / 节点详情卡片）并列，数据同步。
- 图谱管理：用户可新建图谱，新建时绑定类型（study / work），与旧图谱不互通。

## Impact
- 新增能力：双模式切换、知识图谱可视化（节点小卡片）、对话采集接口、自动出题、工作上下文整理、风口推荐、工作报告、双视图切换、图谱隔离管理。
- 参考代码：步影 `backend/app/services/`（main_agent、sub_agent、knowledge_store、file_storage、llm_factory、llm_client、ws_notify、session_queue、settings_store）、步影 `frontend/src/`（React 组件、api、ws）。
- 参考架构：web-AI-chat-collector 的对话采集与导出格式（仅用于定义插件对接契约）。
- 新增代码：`knowledge-work-assistant/` 下完整的前后端工程。

## ADDED Requirements

### Requirement: 项目骨架与步影代码复用
The system SHALL be initialized as an Electron + React + TypeScript frontend with a Python FastAPI backend under `knowledge-work-assistant/`, reusing adapted copies of 步影's agent, knowledge store, file storage, and LLM modules.

#### Scenario: 项目可启动
- **WHEN** 开发者按 README 启动后端 (`uv run uvicorn`) 与前端 (`pnpm dev:electron`)
- **THEN** 前端窗口打开、后端健康检查通过、前后端 WebSocket 与 HTTP 通信正常

#### Scenario: 步影模块适配复用
- **WHEN** 拷贝步影的 main_agent / knowledge_store / file_storage / llm_factory 等模块
- **THEN** 这些模块在新项目中可用，且已按本软件需求（双模式、图谱）做最小必要适配，不破坏步影原有职责

### Requirement: Study / Work 模式切换开关
The system SHALL provide a mode toggle switch in the top-right corner that switches between Study and Work modes with smooth transition and clear state indication.

#### Scenario: 切换模式
- **WHEN** 用户点击右上角开关从 Study 切到 Work
- **THEN** 界面流畅过渡到 Work 模式，当前显示的图谱切换为该模式下的图谱集，开关视觉状态明确指示当前模式

#### Scenario: 模式与图谱类型绑定
- **WHEN** 处于 Study 模式
- **THEN** 仅可见与可操作 study 类型图谱；Work 模式同理；study 与 work 图谱互不互通

### Requirement: 浏览器插件对接接口（预留）
The system SHALL reserve a webhook interface for the browser plugin to push collected AI conversations; the interface contract is defined but the plugin implementation is not part of this project.

#### Scenario: 插件推送对话（预留）
- **WHEN** 浏览器插件向 `POST /api/plugin/conversations` 发送对话数据（含平台、时间戳、对话原文、可选元数据）
- **THEN** 后端接收并存为原始观察记录，返回接收确认；当前阶段接口先空实现，仅校验契约与持久化原始数据

### Requirement: Study 图谱节点自动抽取
The system SHALL auto-extract knowledge points from collected conversations as initial graph nodes via the Agent, with user confirm/modify capability.

#### Scenario: 从对话抽取节点
- **WHEN** 插件推送（或手动导入）一段对话后
- **THEN** Agent 自动抽取候选知识点，生成带类型初判的节点，供用户确认后加入当前 study 图谱

### Requirement: 知识图谱可视化（无向图 + 节点小卡片）
The system SHALL render the knowledge graph as an undirected graph where each node is displayed as a small card showing title + one-line summary + type label; isolated nodes are allowed.

#### Scenario: 图谱渲染
- **WHEN** 用户进入图谱视图
- **THEN** 节点以小卡片形式呈现（常显标题、概括、类型标签），边表示关联关系，支持拖拽、缩放、平移；孤立节点独立显示

#### Scenario: 双视图切换
- **WHEN** 用户在图谱视图与卡片视图间切换
- **THEN** 两个视图数据同步，切换无数据丢失

### Requirement: 节点悬停详情卡
The system SHALL display a detail card on hover over a node, containing node title, knowledge summary, important points, extension direction recommendations, and a user fill-in area.

#### Scenario: 悬停显示详情卡
- **WHEN** 鼠标悬停节点 300-500ms
- **THEN** 弹出详情卡，含五个区域：节点标题、知识点概括、重要点/关键材料、延伸方向推荐、我的补充留白区；鼠标移开 200-300ms 后消失

#### Scenario: 学科模板命中
- **WHEN** 节点类型为已知学科（语文/数学/英语/历史/地理/政治/生物/化学/物理/编程/大模型）
- **THEN** 详情卡按对应学科模板展示字段

#### Scenario: 未命中类型走通用兜底
- **WHEN** 节点类型未识别
- **THEN** 详情卡使用通用知识模板（它是什么/为什么重要/关键内容/常见场景或考法/延伸方向），并允许用户手动切换类型；不编造、不报错、不空白

### Requirement: 双击节点全部延伸（按用户原需求）
The system SHALL, on double-click of a node, generate all extension content; newly generated nodes are marked gray and connected to the double-clicked node.

#### Scenario: 双击生成全部延伸
- **WHEN** 用户双击一个节点
- **THEN** 系统基于该节点的延伸方向推荐生成全部延伸节点，新生成节点标记为灰色，并与被双击节点建立连接关系；已存在的节点不重复生成（高亮已有）；支持撤销

### Requirement: 单击推荐方向单点延伸
The system SHALL, on click of a single extension direction recommendation, generate only that one extension node.

#### Scenario: 单击推荐方向
- **WHEN** 用户单击详情卡中某个延伸方向推荐
- **THEN** 仅生成该方向的一个延伸节点，并与当前节点建立连接

### Requirement: 用户留白与节点编辑
The system SHALL allow users to fill in the blank area (saving as doubt/association/exam-point/error-point/note) and to edit or delete nodes.

#### Scenario: 保存留白
- **WHEN** 用户在"我的补充"区输入内容并选择类型
- **THEN** 内容保存到该节点，可选生成新的延伸节点

#### Scenario: 编辑/删除节点
- **WHEN** 用户对节点执行编辑或删除
- **THEN** 节点信息更新或从图谱移除（含相关边的清理），相关视图同步刷新

### Requirement: Study 测验生成
The system SHALL auto-generate quizzes (multiple-choice single/multi + Feynman explanation) from collected content and grade them via the Agent.

#### Scenario: 生成并作答选择题
- **WHEN** 用户发起测验
- **THEN** Agent 基于图谱节点生成选择题（单选/多选），用户作答后立即判分并给出解析

#### Scenario: 费曼解释题
- **WHEN** 用户作答费曼解释题
- **THEN** Agent 对用户用自己的话解释的知识点进行理解度判断，给出评分与反馈

### Requirement: Work 图谱节点体系
The system SHALL use work objects (work thread / key person / commitment / expectation / event / decision / risk / material / preference / review) as graph nodes in Work mode, per 设计方案.md Part 1.

#### Scenario: Work 节点详情卡
- **WHEN** 悬停/选中 Work 节点
- **THEN** 详情卡显示工作概括、关键信息、相关人物、相关承诺、风险、延伸关联、我的补充（按设计方案.md 第七部分）

### Requirement: Work 行业风口推荐
The system SHALL provide an industry-trend recommendation sidebar that lists recommendations over time; users can convert a recommendation into a graph node for deeper exploration.

#### Scenario: 风口推荐侧栏
- **WHEN** 用户在 Work 模式查看侧栏
- **THEN** 看到按时间线排列的风口推荐卡片，含推荐理由（可解释）

#### Scenario: 一键入图
- **WHEN** 用户点击某条推荐的"加入图谱"
- **THEN** 该推荐作为新节点加入当前 work 图谱，并可延伸探索

### Requirement: Work 工作报告生成
The system SHALL auto-generate standardized work reports in Markdown, exportable to docx, with HTML preview printable to PDF.

#### Scenario: 生成报告
- **WHEN** 用户触发报告生成
- **THEN** 基于当前 work 图谱生成 Markdown 报告（含进展/计划/风险/承诺跟进），可导出 .docx、可 HTML 预览并打印为 PDF

### Requirement: Work 用户提问
The system SHALL allow users to ask questions answered by the Agent based on the work graph context.

#### Scenario: 提问回答
- **WHEN** 用户在 Work 模式提问
- **THEN** Agent 基于工作图谱上下文回答，并标注信息来源与置信度

### Requirement: 图谱管理（新建与隔离）
The system SHALL allow users to create new graphs; each graph is bound to a type (study/work) at creation and is isolated from other graphs.

#### Scenario: 新建图谱
- **WHEN** 用户新建图谱并选择类型（study 或 work）
- **THEN** 图谱创建成功，归属当前模式，与其它图谱数据不互通

#### Scenario: 图谱切换
- **WHEN** 用户在图谱列表中切换
- **THEN** 仅显示同类型的其它图谱，切换后视图与数据正确加载

## MODIFIED Requirements
无（本项目为全新构建，无既有 spec 需修改）。

## REMOVED Requirements
- 工作区根目录 `.trae/specs/build-omnivision-demo/`（台风巴威单 HTML demo）与本次任务无关，保留不动，不纳入本次范围。
