# 移植步影 Agent 与插件端到端连通性测试 Spec

## Why

当前 KWA 软件侧的 `GraphAgent` 是面向图谱场景的 LLM 服务封装层（一次性 JSON/Markdown 输出，无多轮上下文、无工具调用），ChatPanel 的 Work 模式仅是单轮问答（`answer_question_stream`），Study 模式完全无对话能力。同时，插件侧 `web-ai-chat-collector` → 软件侧 `POST /api/plugin/conversations` → WS 广播 → 前端事件 这条数据闭环**缺少自动化测试保护网**，每次改动推送链路只能手工联调，回归成本高、易漏。

本次迭代做两件事：
1. **把步影的 `main_agent` + `writer_agent` 及必需依赖移植到 KWA**，让 ChatPanel 支持真正的多轮对话（带历史上下文 + Function Calling 工具调用 + Plan/Build 模式切换），并把知识图谱能力同时通过「工具暴露」和「上下文自动注入」两种方式接入 agent。
2. **建立插件端↔软件端的端到端集成测试**，覆盖 `kwa-push.js` → 后端 webhook → 落库 → WS 广播 → 前端事件处理 的完整链路，作为后续推送链路改动的回归保护网。

## What Changes

### A. 移植步影 Agent（main_agent + writer_agent + 必需依赖）

- **新增 services 模块**（从 `步影/backend/app/services/` 适配拷贝，做 KWA 适配修改）：
  - `main_agent.py`：主 Agent，多轮对话主循环 + Function Calling（本地工具 + MCP 工具）+ Plan/Build 模式切换 + multi-turn 工具循环（`MAX_TOOL_ITERATIONS=10`）
  - `writer_agent.py`：Writer Subagent，带工具循环的结构化状态记录员，写 `checkpoint.md`（11 字段），落库到 `Checkpoint` 表（KWA 已存在）。**触发机制沿用步影**：由 `context_manager.maybe_checkpoint` 按上下文窗口占用比例（默认阈值 20% / 45% / 70%）自动派发，每个阈值只触发一次，rebuild 后重置可再次触发；Writer 运行时跳过新触发（`_writer_running` 标志）。**不在前端展示 checkpoint 侧栏**（用户决策：不展示，writer 在后台静默运行）
  - `context_manager.py`：上下文管理（token 估算、历史裁剪、压缩、checkpoint 触发派发）
  - `tool_registry.py`：工具注册表（`register_default_tools` 注册内置工具 + MCP 工具命名空间 `mcp.{server}.{tool}`）
  - `mcp_manager.py`：MCP 工具管理器（全局单例，KWA 已有 `McpServer` 表）
  - `multimodal/image_handler.py`：图片编码为 LLM 可读格式
  - `tools/`：按需移植 `task_tools.py`（TaskStore，writer 依赖）+ `file_tools.py`（file_read/file_write/file_list，writer 依赖）+ `system_tools.py`（基础系统工具）
  - `prompts/`：`main_agent_system.md` + `writer_system.md`（适配 KWA 双模式与图谱场景）
  - `agents/`：暂不移植 `search_agent.py` / `summarize_agent.py`（后续按需补）
  - `skills/`：暂不移植（后续按需补）
- **KWA 适配修改**：
  - 移除步影特有的 `notes.py` 依赖（KWA 无此模块，writer_agent 中的 notes 调用改为直接写文件或忽略）
  - `Session` / `Message` / `Checkpoint` / `FileMetadata` 表 KWA 已有，无需新增
  - `main_agent.py` 中的 `from app.services.notes import ...` 等不存在的导入要裁剪或替换
  - 端口/配置对齐（KWA 后端 8788，步影 8787）
- **图谱能力接入 agent（双通道）**：
  - **图谱作为工具暴露**：新增 `tools/graph_tools.py`，把 `graph_store` + `graph_agent` 的能力封装成 Function Calling 工具：
    - `graph_query_nodes(graph_id, keyword, limit)` - 搜索节点（只读，低风险）
    - `graph_get_node_detail(node_id)` - 获取节点详情（只读，低风险）
    - `graph_get_context(graph_id)` - 获取图谱上下文摘要（只读，低风险）
    - `graph_generate_quiz(graph_id, quiz_type)` - 生成测验（只读，低风险）
    - `graph_extract_from_observation(observation_id, graph_type)` - 从观察抽取节点（**高风险**，会修改图谱）
    - `graph_generate_trends(graph_id)` - 生成风口（只读，低风险，work 模式）
    - `graph_generate_report(graph_id, period)` - 生成报告（只读，低风险，work 模式）
  - **高风险操作拦截**（用户决策）：高风险工具（仅 `graph_extract_from_observation`）在 agent 调用时**不立即执行**，而是通过 WS 推送 `chat_tool_call_confirmation` 事件给前端，前端弹确认对话框：
    - 用户「同意」→ 后端执行工具，结果回填给 agent 继续
    - 用户「拒绝」→ 后端把「用户拒绝执行该工具，原因是 XXX」作为工具结果回填给 agent，agent 据此调整后续对话（如改用查询工具或说明无法抽取）
    - Plan 模式下所有高风险工具一律拒绝（与 Plan 模式只读语义一致）
  - **对话上下文自动注入图谱**：ChatPanel 对话时，若 `currentGraphId` 存在，自动把 `graph_agent._build_context(graph_id)` 作为系统提示的一部分注入 main_agent 的 messages
- **新增后端路由** `routers/chat.py`：
  - `POST /api/chat/sessions` - 创建会话（指定 mode=study|work + graph_id）
  - `GET /api/chat/sessions` - 列出当前模式会话
  - `GET /api/chat/sessions/{id}/messages` - 获取会话消息历史
  - `POST /api/chat/sessions/{id}/stream` - 流式对话（HTTP 立即返回 `request_id`，token 通过 WS 推送，复用现有 `graph_agent_token` 协议但 `op="chat"`）
  - `POST /api/chat/sessions/{id}/checkpoint` - 触发 writer_agent 更新 checkpoint
  - `GET /api/chat/sessions/{id}/checkpoint` - 获取当前会话 checkpoint
  - `POST /api/chat/requests/{id}/cancel` - 取消流式对话（复用 `llm_request_registry`）

### B. 替换 ChatPanel 现有实现

- **Work 模式**：把 `askWorkQuestionStream`（单轮 `GraphAgent.answer_question_stream`）替换为调用 `POST /api/chat/sessions/{id}/stream`（main_agent 多轮对话 + 图谱工具）
- **Study 模式**：新增学习辅导对话（之前只有瀑布流首页，无对话），基于当前 study 图谱，可触发费曼/测验工具
- **保留 UI 布局**：消息列表 + 底部输入框 + 流式打字机效果 + 置信度/来源展示 + 降级提示
- **新增**：
  - 工具调用过程展示（agent 调用图谱工具时，消息流中显示「正在查询图谱节点…」等状态）
  - Plan/Build 模式切换按钮（Work 模式独有，**默认 Build 全权**，Plan 只读）
  - 高风险操作确认对话框（agent 调用 `graph_extract_from_observation` 等高风险工具时，弹对话框询问用户「同意/拒绝」）

### C. 插件端到端集成测试

- **测试框架**：后端 `pytest` + `httpx.AsyncClient`（已可用）+ `pytest-asyncio`；前端 `vitest`（已可用）
- **测试位置**：
  - 后端：`knowledge-work-assistant/backend/tests/e2e/test_plugin_pipeline.py`
  - 前端 SDK：`knowledge-work-assistant/frontend/src/lib/__tests__/kwa-push.e2e.test.ts`
- **测试覆盖**（端到端链路）：
  1. **插件 SDK 推送**：用 vitest 模拟 `kwa-push.js` 调用后端 webhook，验证 HTTP 响应 `{received, deduplicated, observation_id}`
  2. **后端落库**：用 pytest 验证 `observations` 表新增一条 `source='plugin'` 记录，`platform/timestamp/conversation_markdown/metadata_json` 字段正确
  3. **幂等去重**：同一 `metadata.conversation_id` 重复推送，第二次返回 `deduplicated: true`，不写新记录
  4. **平台白名单**：推送非法 `platform` 返回 400
  5. **契约自检**：`GET /api/plugin/health` 返回 `{ok, version, supported_platforms, queue_size}`；`GET /api/plugin/contract` 返回完整契约
  6. **最近推送记录**：`GET /api/plugin/conversations/recent?limit=20` 返回倒序列表
  7. **WS 广播**：推送成功后，WS 连接收到 `{type: 'plugin.conversation_received', payload: {observation_id, platform, title, timestamp}}` 事件
  8. **前端事件处理**：用 vitest 模拟前端 store 收到 WS 事件后，触发 Toast + 刷新 PendingNodes（mock ws 事件）
  9. **完整链路 e2e**：模拟 collector patch 采集对话 → 调用 kwa-push → 后端落库 → WS 广播 → 前端事件，验证端到端数据一致性
- **测试隔离**：
  - 后端测试用临时 SQLite 数据库（`tmp_path` fixture），不污染开发数据
  - 前端测试 mock fetch + WebSocket，不发真实网络请求
  - 不依赖真实 LLM（所有 LLM 调用 mock）

## Impact

- **Affected specs**:
  - `build-knowledge-work-assistant`（Task 17 main_agent 移植正式落地，补齐待移植状态）
  - `extend-plugin-integration`（为插件对接链路加测试保护网）
  - `redesign-chat-with-smart-recommendations`（ChatPanel 替换为 main_agent 多轮对话）
- **Affected code**:
  - **后端新增**：`services/main_agent.py` / `writer_agent.py` / `context_manager.py` / `tool_registry.py` / `mcp_manager.py` / `multimodal/image_handler.py` / `tools/graph_tools.py` / `tools/task_tools.py` / `tools/file_tools.py` / `tools/system_tools.py` / `prompts/main_agent_system.md` / `prompts/writer_system.md` / `routers/chat.py` / `tests/e2e/test_plugin_pipeline.py` / `tests/conftest.py`
  - **后端修改**：`app/main.py`（注册 chat 路由 + 初始化 main_agent）、`app/services/__init__.py`（导出新模块）
  - **前端修改**：`components/ChatPanel.tsx`（替换为多轮对话）、`store/useAppStore.ts`（新增 chatSession 状态 + chatStream 动作 + 工具调用事件处理）、`lib/api.ts`（新增 chat API）、`lib/ws.ts`（订阅 chat 工具调用事件）、`lib/types.ts`（新增 ChatSession / ChatMessage / ToolCall 类型）、`src/lib/__tests__/kwa-push.e2e.test.ts`
  - **配置**：`backend/pyproject.toml`（新增 `pytest-asyncio` 测试依赖）、`frontend/package.json`（确认 vitest 已就绪）
- **不修改**：
  - `web-ai-chat-collector/` 目录内任何文件（测试通过 mock 模拟，不依赖真实插件）
  - `步影/` 目录内任何文件（仅作适配拷贝来源）
  - 现有 `GraphAgent`（保留，作为 graph_tools 的底层调用方，不替换）
  - 现有 `sub_agent.py`（保留，main_agent 可选使用）

## ADDED Requirements

### Requirement: 步影 Agent 移植与适配
The system SHALL port `main_agent` and `writer_agent` from the 步影 project, along with required dependencies (context_manager / tool_registry / mcp_manager / multimodal / tools / prompts), adapted to work with KWA's existing database models and service layer.

#### Scenario: main_agent 多轮对话
- **WHEN** 用户在 ChatPanel 发送一条消息
- **THEN** main_agent 加载会话历史消息 → 上下文管理裁剪 → 流式调用 LLM → 逐 token 通过 WS 推送 → 保存 assistant 消息到 `Message` 表

#### Scenario: Function Calling 工具调用
- **WHEN** LLM 返回 tool_call 请求（如 `graph_query_nodes`）
- **THEN** main_agent 通过 ToolRegistry 执行工具，把结果回填到 messages，再次调用 LLM，循环直到 LLM 不再请求工具或达到 `MAX_TOOL_ITERATIONS=10`

#### Scenario: Plan/Build 模式切换
- **WHEN** Work 模式下用户切换到 Plan 模式
- **THEN** main_agent 仅暴露只读工具（graph_query_nodes / graph_get_node_detail / graph_get_context），不暴露会修改图谱的工具（extract_from_observation）

#### Scenario: Writer Agent 状态记录
- **WHEN** `context_manager.maybe_checkpoint` 检测到上下文窗口占用达到阈值（默认 20% / 45% / 70%）
- **THEN** 自动派发 writer_agent 读取自上次 checkpoint 之后的消息增量（delta）→ 通过 file_read/file_write 工具循环更新 `checkpoint.md` → 解析为 11 字段 dict → 落库到 `Checkpoint` 表；每个阈值只触发一次，rebuild 后重置可再次触发
- **WHEN** Writer 正在运行（`_writer_running=True`）
- **THEN** 跳过本次 checkpoint 检查，避免并发覆盖

### Requirement: 图谱能力接入 Agent
The system SHALL integrate knowledge graph capabilities into the agent via two channels: tool exposure and context injection.

#### Scenario: 图谱作为工具暴露
- **WHEN** agent 需要查询图谱信息
- **THEN** 通过 Function Calling 调用 `graph_query_nodes` / `graph_get_node_detail` / `graph_get_context` 等工具，工具内部委托 `graph_store` / `graph_agent` 执行

#### Scenario: 对话上下文自动注入图谱
- **WHEN** ChatPanel 对话时 `currentGraphId` 存在
- **THEN** main_agent 的系统提示中自动注入 `graph_agent._build_context(graph_id)` 的图谱摘要，agent 不需主动调工具即可引用图谱内容

#### Scenario: Study/Work 双模式差异化
- **WHEN** Study 模式对话
- **THEN** 系统提示偏向学习辅导，**暴露全部图谱工具**（含 `graph_extract_from_observation`，但调用时走高风险拦截流程），可触发 `graph_generate_quiz` 生成测验
- **WHEN** Work 模式对话
- **THEN** 系统提示偏向工作助手，暴露全部图谱工具（含 `graph_generate_trends` / `graph_generate_report`），高风险工具同样走拦截流程
- **WHEN** Plan 模式（Work 模式下用户切换）
- **THEN** 仅暴露只读工具（`graph_query_nodes` / `graph_get_node_detail` / `graph_get_context` / `graph_generate_quiz` / `graph_generate_trends` / `graph_generate_report`），**高风险工具一律拒绝**（与 Plan 模式只读语义一致）

### Requirement: 高风险操作拦截
The system SHALL intercept high-risk tool calls (modifying the graph) by pushing a confirmation event to the frontend, executing only after user approval.

#### Scenario: 高风险工具调用触发确认
- **WHEN** agent 通过 Function Calling 请求调用 `graph_extract_from_observation`（高风险，会修改图谱）
- **THEN** main_agent 不立即执行，而是通过 WS 推送 `{type: 'chat_tool_call_confirmation', op: 'chat', tool: 'graph_extract_from_observation', args: {...}, request_id: ...}` 给前端，并暂停工具循环等待用户响应

#### Scenario: 用户同意执行
- **WHEN** 前端收到确认事件 → 用户点击「同意」
- **THEN** 前端通过 `POST /api/chat/requests/{id}/confirm` 通知后端 → 后端执行工具 → 结果回填给 agent → agent 继续对话循环

#### Scenario: 用户拒绝执行
- **WHEN** 用户点击「拒绝」（可附拒绝原因）
- **THEN** 后端把「用户拒绝了该工具调用，原因：XXX」作为工具结果回填给 agent → agent 据此调整后续对话（如改用查询工具或说明无法抽取）→ 在消息中告知用户「已取消抽取」

#### Scenario: Plan 模式下高风险工具一律拒绝
- **WHEN** Plan 模式下 agent 请求调用高风险工具
- **THEN** 不弹确认对话框，直接把「Plan 模式下不允许执行修改图谱的操作」作为工具结果回填给 agent，agent 据此调整

#### Scenario: 超时处理
- **WHEN** 确认事件推送后 60 秒内用户未响应
- **THEN** 后端视为拒绝，把「用户未在 60 秒内响应，视为拒绝」作为工具结果回填给 agent

### Requirement: ChatPanel 替换为多轮对话
The system SHALL replace the current single-turn Q&A ChatPanel with a multi-turn conversational interface backed by main_agent.

#### Scenario: Work 模式多轮对话
- **WHEN** 用户在 Work 模式 ChatPanel 发送消息
- **THEN** 调用 `POST /api/chat/sessions/{id}/stream`，main_agent 携带历史上下文 + 图谱工具流式回答，前端实时显示 token + 工具调用状态

#### Scenario: Study 模式新增对话
- **WHEN** 用户在 Study 模式 ChatPanel 发送消息（之前无对话能力）
- **THEN** 调用 `POST /api/chat/sessions/{id}/stream`，main_agent 基于当前 study 图谱提供学习辅导，可触发测验生成

#### Scenario: 工具调用过程展示
- **WHEN** agent 调用图谱工具
- **THEN** 消息流中显示「正在查询图谱节点…」「正在生成测验…」等状态，工具返回后展示结果摘要

### Requirement: 插件端到端连通性测试
The system SHALL provide end-to-end integration tests covering the full plugin push pipeline: kwa-push.js → backend webhook → observation persistence → WS broadcast → frontend event handling.

#### Scenario: 后端 webhook 落库与广播
- **WHEN** 测试用 httpx.AsyncClient 模拟插件 POST `/api/plugin/conversations`
- **THEN** 验证响应 `{received: true, observation_id: <32位hex>}`，数据库 `observations` 表新增一条 `source='plugin'` 记录，WS 连接收到 `plugin.conversation_received` 事件

#### Scenario: 幂等去重
- **WHEN** 同一 `metadata.conversation_id` 重复推送
- **THEN** 第二次返回 `{received: true, deduplicated: true, observation_id: <existing>}`，数据库不新增记录

#### Scenario: 平台白名单
- **WHEN** 推送 `platform: "unknown_platform"`
- **THEN** 返回 400 + `{detail: "unsupported platform: unknown_platform"}`

#### Scenario: 契约自检
- **WHEN** 调用 `GET /api/plugin/health` 与 `GET /api/plugin/contract`
- **THEN** health 返回 `{ok: true, version, supported_platforms, queue_size}`，contract 返回完整契约 JSON（含 version / supported_platforms / push_examples）

#### Scenario: 前端 SDK 推送
- **WHEN** vitest 模拟 `kwa-push.js` 调用后端 webhook（mock fetch）
- **THEN** 验证 SDK 正确构造请求体、处理响应、失败重试（最多 3 次指数退避）

#### Scenario: 前端事件处理
- **WHEN** vitest mock WS 推送 `plugin.conversation_received` 事件给 store
- **THEN** store 触发 Toast 提示 + 刷新 PendingNodes（study 模式图谱视图下）

#### Scenario: 完整链路 e2e
- **WHEN** 测试模拟 collector patch 采集对话 → 调用 kwa-push → 后端落库 → WS 广播 → 前端事件
- **THEN** 端到端验证数据一致性：conversation_markdown 落库正确、observation_id 链路传递无误、前端事件 payload 与后端广播一致

### Requirement: 测试隔离与无 LLM 依赖
The system SHALL ensure tests do not pollute development data and do not depend on real LLM services.

#### Scenario: 测试数据库隔离
- **WHEN** 后端 pytest 运行
- **THEN** 使用 `tmp_path` fixture 创建临时 SQLite 数据库，测试结束自动清理，不读写 `backend/data/app.db`

#### Scenario: 无真实 LLM 依赖
- **WHEN** 测试运行
- **THEN** 所有 LLM 调用通过 mock 替代，不发真实网络请求，可在无 API Key 环境下运行

## MODIFIED Requirements

### Requirement: ChatPanel 对话能力（原 redesign-chat-with-smart-recommendations）
原 ChatPanel Work 模式为单轮问答（`GraphAgent.answer_question_stream`），Study 模式无对话。本次替换为 main_agent 多轮对话：携带历史上下文 + Function Calling 工具调用 + Plan/Build 模式切换 + 图谱能力双通道接入。保留现有 UI 布局（消息列表 + 底部输入框 + 流式打字机）。

### Requirement: main_agent 移植（原 build-knowledge-work-assistant Task 17）
原 spec 标记 main_agent 为「待移植」，依赖 `context_manager` / `mcp_manager` / `tool_registry` / `multimodal.image_handler` / `tools.task_tools` 等模块未拷贝。本次正式移植 main_agent + writer_agent + 全部必需依赖，并新增图谱工具集成，使 main_agent 可通过 Function Calling 操作知识图谱。

## REMOVED Requirements

### Requirement: GraphAgent 单轮问答接口（ChatPanel Work 模式）
**Reason**: 替换为 main_agent 多轮对话后，ChatPanel 不再直接调用 `GraphAgent.answer_question_stream`
**Migration**: `GraphAgent` 与 `answer_question_stream` 保留（作为 graph_tools 的底层实现），仅 ChatPanel 不再直接调用；现有 `QAPanel` 浮层仍可继续使用 `answer_question_stream`
