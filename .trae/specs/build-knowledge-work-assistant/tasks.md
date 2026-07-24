# Tasks

- [x] Task 1: 搭建项目骨架并复用步影代码
  - [x] SubTask 1.1: 在 `knowledge-work-assistant/` 下初始化 backend（FastAPI + uv，Python 3.12），建立 `app/main.py`、`app/routers/`、`app/services/`、`app/models/` 目录骨架与 `.env.example`、`pyproject.toml`
  - [x] SubTask 1.2: 从步影 `backend/app/services/` 拷贝并适配 `main_agent.py`、`sub_agent.py`、`knowledge_store.py`、`file_storage.py`、`llm_factory.py`、`llm_client.py`、`llm_errors.py`、`ws_notify.py`、`session_queue.py`、`settings_store.py`、`model_config.py`，确保在本项目可运行且不破坏原职责
  - [x] SubTask 1.3: 在 `knowledge-work-assistant/` 下初始化 frontend（Electron + React + TS + Vite + pnpm），建立 `electron/`（main/preload/launcher）、`src/`（App/main/lib/components）、`package.json`、`vite.config.ts`、`tsconfig.json`
  - [x] SubTask 1.4: 从步影 `frontend/src/lib/` 拷贝适配 `api.ts`、`ws.ts`、`types.ts`，从 `frontend/electron/` 拷贝适配 main/preload/launcher，确保前后端 HTTP+WebSocket 通信打通
  - [x] SubTask 1.5: 编写项目 README，记录启动命令（后端 `uv run uvicorn app.main:app --reload --port 8788`，前端 `pnpm dev:electron`）

- [x] Task 2: 数据模型与存储层
  - [x] SubTask 2.1: 定义图谱数据模型：`Graph`(id, name, type[study|work], created_at)、`Node`(id, graph_id, type, title, summary, detail_payload, is_gray, user_fill, source, confidence, created_at)、`Edge`(id, graph_id, src_id, dst_id, relation)、`Observation`(原始观察/对话记录)、`Quiz`(id, graph_id, node_id, type, payload, answer, result)
  - [x] SubTask 2.2: 定义 Work 对象节点子类型（工作线索/关键人/承诺/期望/事件/决策/风险/资料/偏好/复盘）与 Study 学科节点子类型（语文/数学/英语/历史/地理/政治/生物/化学/物理/编程/大模型/通用）
  - [x] SubTask 2.3: 实现 SQLite + SQLAlchemy 存储层（复用步影 knowledge_store/file_storage 思路），提供图谱/节点/边/观察/测验的 CRUD

- [x] Task 3: 模式切换开关
  - [x] SubTask 3.1: 前端实现右上角 Study/Work 切换开关组件，含流畅过渡动画与当前模式高亮
  - [x] SubTask 3.2: 前端全局状态管理当前模式（study|work），切换时按模式过滤图谱列表并加载该模式当前图谱
  - [x] SubTask 3.3: 后端接口按模式过滤图谱（`GET /api/graphs?mode=study|work`）

- [x] Task 4: 图谱管理（新建与隔离）
  - [x] SubTask 4.1: 后端 `POST /api/graphs`（name, type）创建图谱，type 必须与当前模式一致
  - [x] SubTask 4.2: 前端图谱列表侧栏，支持新建（绑定类型）、切换、重命名、删除
  - [x] SubTask 4.3: 确保 study 与 work 图谱数据隔离，切换模式仅见对应类型图谱

- [x] Task 5: 图谱可视化（无向图 + 节点小卡片）
  - [x] SubTask 5.1: 选型并引入图可视化库（如 react-force-graph / cytoscape / d3-force），支持无向图、拖拽、缩放、平移
  - [x] SubTask 5.2: 自定义节点渲染：每个节点为小卡片，常显标题 + 一句话概括 + 类型标签；孤立节点独立显示
  - [x] SubTask 5.3: 实现边渲染、节点拖拽、画布缩放平移、自适应布局
  - [x] SubTask 5.4: 灰色节点标记样式（延伸生成的新节点）

- [x] Task 6: 双视图切换（图谱视图 / 卡片视图）
  - [x] SubTask 6.1: 前端实现图谱视图与卡片视图的并列切换控件
  - [x] SubTask 6.2: 卡片视图：Study 显示节点卡片网格；Work 显示今日上下文卡片 / 承诺追踪 / 人物上下文（按设计方案.md 第四部分）
  - [x] SubTask 6.3: 两视图数据同步，切换无数据丢失

- [x] Task 7: 节点悬停详情卡
  - [x] SubTask 7.1: 实现悬停 300-500ms 显示详情卡、移开 200-300ms 消失的延时逻辑
  - [x] SubTask 7.2: 详情卡五区域布局：节点标题 / 知识点概括 / 重要点 / 延伸方向推荐 / 我的补充留白区
  - [x] SubTask 7.3: 实现学科模板体系（通用 / 人文社科 / 理科 / 技术 / 11 学科细分），按节点类型渲染对应字段
  - [x] SubTask 7.4: 未命中类型走通用兜底模板，提供手动切换类型入口并记忆用户选择
  - [x] SubTask 7.5: Work 节点详情卡按工作模板（工作概括/关键信息/相关人物/相关承诺/风险/延伸关联/我的补充）

- [x] Task 8: 节点延伸交互
  - [x] SubTask 8.1: 双击节点触发"全部延伸"：Agent 基于延伸方向推荐生成全部延伸节点，新节点标灰并与原节点建边
  - [x] SubTask 8.2: 单击推荐方向触发单点延伸：仅生成该方向一个节点并建边
  - [x] SubTask 8.3: 已存在节点不重复生成（高亮已有），全部延伸支持撤销
  - [x] SubTask 8.4: 用户留白输入后可选生成新延伸节点

- [x] Task 9: 节点编辑与删除
  - [x] SubTask 9.1: 节点右键/详情卡内提供编辑（标题/概括/类型/详情字段）与删除入口
  - [x] SubTask 9.2: 删除节点时清理相关边，更新图谱与卡片视图

- [x] Task 10: 浏览器插件对接接口（预留）
  - [x] SubTask 10.1: 后端定义 `POST /api/plugin/conversations` 契约（platform、timestamp、conversation_markdown、metadata），参考 web-AI-chat-collector 导出格式
  - [x] SubTask 10.2: 实现空实现：仅校验契约、持久化为 Observation 原始记录、返回接收确认
  - [x] SubTask 10.3: 文档化接口契约供插件方对接

- [x] Task 11: Study 对话收集与节点自动抽取
  - [x] SubTask 11.1: Agent 从 Observation 原始对话中抽取候选知识点，带类型初判
  - [x] SubTask 11.2: 生成"待确认节点列表"，用户确认后加入当前 study 图谱
  - [x] SubTask 11.3: 抽取时归一去重（复用步影 knowledge_store 思路）

- [x] Task 12: Study 测验生成
  - [x] SubTask 12.1: Agent 基于图谱节点生成选择题（单选/多选）与费曼解释题
  - [x] SubTask 12.2: 前端测验作答界面，选择题即时判分并给解析
  - [x] SubTask 12.3: 费曼题 Agent 语义判分，给出理解度评分与反馈
  - [x] SubTask 12.4: 测验结果记录到 Quiz 表，关联节点用于复盘

- [x] Task 13: Work 图谱节点体系与详情
  - [x] SubTask 13.1: Work 节点按工作对象子类型（线索/关键人/承诺/期望/事件/决策/风险/资料/偏好/复盘）建模与渲染
  - [x] SubTask 13.2: Agent 从用户输入/对话中抽取工作对象、归一去重、建立关系（属于/涉及/承诺给/依赖/等待/影响/来源/替代）
  - [x] SubTask 13.3: Work 节点详情卡按工作模板展示，含置信度与来源依据

- [x] Task 14: Work 行业风口推荐
  - [x] SubTask 14.1: Agent 基于当前 work 图谱分析并生成风口推荐（含可解释理由）
  - [x] SubTask 14.2: 前端侧栏按时间线展示风口推荐卡片
  - [x] SubTask 14.3: "加入图谱"按钮：把推荐转为 work 图谱节点，可延伸探索

- [x] Task 15: Work 工作报告生成
  - [x] SubTask 15.1: Agent 基于当前 work 图谱生成 Markdown 报告（进展/下周计划/风险/承诺跟进）
  - [x] SubTask 15.2: 导出 .docx（复用步影已依赖的 python-docx）
  - [x] SubTask 15.3: HTML 预览组件，支持浏览器打印为 PDF

- [x] Task 16: Work 用户提问
  - [x] SubTask 16.1: Work 模式提问入口（对话式）
  - [x] SubTask 16.2: Agent 基于工作图谱上下文回答，标注信息来源与置信度（复用步影 main_agent/sub_agent）

- [x] Task 17: Agent 集成与上下文管理
  - [x] SubTask 17.1: 适配步影 main_agent/sub_agent 承载本项目的节点抽取、延伸生成、测验出题判分、风口推荐、报告生成、提问回答
  - [x] SubTask 17.2: 适配步影 file_storage/file_storage 管理导出报告与导入对话
  - [x] SubTask 17.3: WebSocket（复用 ws_notify）推送 Agent 流式输出与图谱变更

- [x] Task 18: 联调验证与优化
  - [x] SubTask 18.1: 端到端验证 Study 流程：插件接口（模拟 POST）→ 抽取节点 → 图谱渲染 → 悬停详情 → 双击/单击延伸 → 测验
  - [x] SubTask 18.2: 端到端验证 Work 流程：新建 work 图谱 → 添加工作对象 → 风口侧栏 → 一键入图 → 报告生成 → 提问
  - [x] SubTask 18.3: 验证模式切换、图谱隔离、双视图切换、节点编辑删除
  - [x] SubTask 18.4: UI 细节与性能优化（大图谱节点渲染、流式响应）

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1
- Task 4 depends on Task 2, Task 3
- Task 5 depends on Task 2
- Task 6 depends on Task 5
- Task 7 depends on Task 5
- Task 8 depends on Task 7, Task 17
- Task 9 depends on Task 5
- Task 10 depends on Task 2
- Task 11 depends on Task 10, Task 17
- Task 12 depends on Task 11, Task 17
- Task 13 depends on Task 5, Task 17
- Task 14 depends on Task 13, Task 17
- Task 15 depends on Task 13, Task 17
- Task 16 depends on Task 13, Task 17
- Task 17 depends on Task 1, Task 2
- Task 18 depends on Task 4, Task 6, Task 8, Task 9, Task 12, Task 14, Task 15, Task 16
