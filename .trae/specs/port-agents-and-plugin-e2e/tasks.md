# Tasks

## Phase 1: 后端 Agent 基础模块移植（顺序依赖）

- [x] Task 1: 移植 context_manager（上下文管理）
  - [x] SubTask 1.1: 从 `步影/backend/app/services/context_manager.py` 适配拷贝到 `knowledge-work-assistant/backend/app/services/context_manager.py`
  - [x] SubTask 1.2: 裁剪步影特有的依赖（如 `notes` / `distill` / `dream` 等不存在模块的引用），保留 token 估算、历史裁剪、压缩核心逻辑
  - [x] SubTask 1.3: 验证：`uv run python -c "from app.services.context_manager import ContextManager; print('ok')"` 不报错

- [x] Task 2: 移植 tool_registry + mcp_manager + multimodal/image_handler
  - [x] SubTask 2.1: 适配拷贝 `tool_registry.py`（保留 `ToolRegistry` 类 + `register_default_tools` + `MCP_PREFIX` 常量；裁剪对未移植工具的注册调用）
  - [x] SubTask 2.2: 适配拷贝 `mcp_manager.py`（KWA 已有 `McpServer` 表，对齐模型字段）
  - [x] SubTask 2.3: 适配拷贝 `multimodal/__init__.py` + `multimodal/image_handler.py`（保留 `encode_image_for_llm`）
  - [x] SubTask 2.4: 验证：`uv run python -c "from app.services.tool_registry import ToolRegistry; from app.services.mcp_manager import mcp_manager; from app.services.multimodal.image_handler import encode_image_for_llm; print('ok')"` 不报错

- [x] Task 3: 移植基础 tools（task_tools / file_tools / system_tools）
  - [x] SubTask 3.1: 适配拷贝 `tools/__init__.py` + `tools/task_tools.py`（TaskStore，writer_agent 依赖）
  - [x] SubTask 3.2: 适配拷贝 `tools/file_tools.py`（file_read / file_write / file_list，writer_agent 工具循环依赖；裁剪对 KWA 不存在路径的处理）
  - [x] SubTask 3.3: 适配拷贝 `tools/system_tools.py`（基础系统工具，如时间/环境信息）
  - [x] SubTask 3.4: 裁剪 `search_tools.py` / `skill_tools.py` / `web_search.py`（暂不移植，从 `register_default_tools` 中移除其注册）
  - [x] SubTask 3.5: 验证：`uv run python -c "from app.services.tools.task_tools import TaskStore; from app.services.tools.file_tools import register_file_tools; print('ok')"` 不报错

- [x] Task 4: 移植 prompts 并适配 KWA 双模式
  - [x] SubTask 4.1: 创建 `services/prompts/` 目录 + `__init__.py`
  - [x] SubTask 4.2: 适配拷贝 `prompts/main_agent_system.md`，修改提示词：
    - 加入「知识工作助手」身份说明
    - 加入 Study/Work 双模式职责说明（Study 偏学习辅导可触发测验，Work 偏工作助手可触发报告/风口）
    - 加入图谱工具使用说明（何时该调用 graph_query_nodes 等）
    - 加入 Plan/Build 模式说明
  - [x] SubTask 4.3: 适配拷贝 `prompts/writer_system.md`，保留 11 字段 checkpoint 记录逻辑，裁剪步影特有场景
  - [x] SubTask 4.4: 验证：两个 .md 文件可被 `Path(__file__).parent / "prompts" / "main_agent_system.md"` 读取

- [x] Task 5: 移植 main_agent.py + 适配修改
  - [x] SubTask 5.1: 适配拷贝 `main_agent.py`，修改 import：
    - 移除 `from app.services.notes import ...`（KWA 无 notes 模块）
    - 移除 `from app.services.distill import ...` / `dream` 等未移植模块
    - 保留对 `context_manager` / `tool_registry` / `mcp_manager` / `multimodal` / `llm_client` / `model_config` / `tools.task_tools` 的引用
  - [x] SubTask 5.2: 修改 `MainAgent.chat_stream` 方法签名，新增 `graph_id: str | None = None` + `mode: str = "work"` + `plan_mode: bool = False` 参数，用于图谱上下文注入、工具白名单控制与高风险拦截
  - [x] SubTask 5.3: 在 `chat_stream` 中加入图谱上下文注入逻辑：若 `graph_id` 存在，调 `graph_agent._build_context(graph_id)` 作为系统提示的一部分
  - [x] SubTask 5.4: 加入高风险工具拦截逻辑：在工具循环中，若工具名属于 `HIGH_RISK_TOOLS`（仅 `graph_extract_from_observation`）：
    - Plan 模式直接返回「Plan 模式下不允许执行修改图谱的操作」作为工具结果
    - Build 模式：通过 WS 推送 `{type: 'chat_tool_call_confirmation', op: 'chat', tool, args, request_id}`，暂停工具循环，等待 `POST /api/chat/requests/{id}/confirm` 或 60 秒超时
    - 用户同意 → 执行工具，结果回填
    - 用户拒绝/超时 → 把拒绝原因作为工具结果回填，agent 继续对话
  - [x] SubTask 5.5: 加入全局单例 `main_agent` + `get_main_agent()` + `init_main_agent()`（对齐 graph_agent 的模式）
  - [x] SubTask 5.6: 验证：`uv run python -c "from app.services.main_agent import main_agent, HIGH_RISK_TOOLS; print('ok')"` 不报错

- [x] Task 6: 移植 writer_agent.py + 适配修改
  - [x] SubTask 6.1: 适配拷贝 `writer_agent.py`，修改 import：
    - 移除 `from app.services.notes import ...`（KWA 无 notes 模块；writer 中的 notes 调用改为直接写文件或忽略）
    - 保留对 `Checkpoint` 模型 / `llm_client` / `file_tools` 的引用
  - [x] SubTask 6.2: 验证 `Checkpoint` 表字段与 writer_agent 写入的字段对齐（KWA 已有 `Checkpoint` 表，可能字段略有差异）
  - [x] SubTask 6.3: 加入全局单例 `writer_agent` + `get_writer_agent()`
  - [x] SubTask 6.4: 验证：`uv run python -c "from app.services.writer_agent import writer_agent; print('ok')"` 不报错

- [x] Task 7: 新增 tools/graph_tools.py（图谱工具封装）
  - [x] SubTask 7.1: 创建 `services/tools/graph_tools.py`，封装以下工具（每个工具返回 dict 供 LLM 解析）：
    - `graph_query_nodes(graph_id, keyword, limit=20)` → 委托 `graph_store.list_nodes` + 关键词过滤
    - `graph_get_node_detail(node_id)` → 委托 `graph_store.get_node`
    - `graph_get_context(graph_id)` → 委托 `graph_agent._build_context`
    - `graph_extract_from_observation(observation_id, graph_type)` → 委托 `graph_agent.extract_nodes_from_observation`
    - `graph_generate_quiz(graph_id, quiz_type="single_choice")` → 委托 `graph_agent.generate_quiz`
    - `graph_generate_trends(graph_id)` → 委托 `graph_agent.generate_trends`（仅 work）
    - `graph_generate_report(graph_id, period="weekly")` → 委托 `graph_agent.generate_report`（仅 work）
  - [x] SubTask 7.2: 实现 `register_graph_tools(registry: ToolRegistry)`，把上述工具注册到 ToolRegistry
  - [x] SubTask 7.3: 在 `tool_registry.register_default_tools` 中调用 `register_graph_tools`，使图谱工具成为默认工具集的一部分
  - [x] SubTask 7.4: 实现 Plan/Build 模式工具白名单过滤：
    - **Study 模式**：暴露全部 7 个图谱工具（含 `graph_extract_from_observation`，但调用时走高风险拦截）
    - **Work 模式 Build**：暴露全部 7 个图谱工具（默认值，高风险工具走拦截）
    - **Work 模式 Plan**：仅暴露只读工具（`graph_query_nodes` / `graph_get_node_detail` / `graph_get_context` / `graph_generate_quiz` / `graph_generate_trends` / `graph_generate_report`），**高风险工具一律拒绝**（不弹框，直接回填拒绝原因）
  - [x] SubTask 7.5: 在 `graph_tools.py` 顶部定义 `HIGH_RISK_TOOLS = {"graph_extract_from_observation"}` 常量，供 main_agent 拦截逻辑查询
  - [x] SubTask 7.6: 验证：`uv run python -c "from app.services.tools.graph_tools import register_graph_tools, HIGH_RISK_TOOLS; print('ok')"` 不报错

## Phase 2: 后端 chat 路由（依赖 Phase 1）

- [x] Task 8: 新增 routers/chat.py + 注册到 main.py
  - [x] SubTask 8.1: 创建 `routers/chat.py`，实现以下端点：
    - `POST /api/chat/sessions` - 创建会话（body: `{mode, graph_id?}`，写 `Session` 表）
    - `GET /api/chat/sessions?mode=study|work` - 列出当前模式会话
    - `GET /api/chat/sessions/{id}/messages` - 获取会话消息历史（从 `Message` 表读）
    - `POST /api/chat/sessions/{id}/stream` - 流式对话（body: `{content, plan_mode?}`，立即返回 `{request_id, started: true}`，后台 `asyncio.create_task(main_agent.chat_stream(...))`）
    - `POST /api/chat/sessions/{id}/checkpoint` - 触发 writer_agent 更新 checkpoint（手动触发，可选）
    - `GET /api/chat/sessions/{id}/checkpoint` - 获取当前会话 checkpoint
    - `POST /api/chat/requests/{id}/cancel` - 取消流式对话（复用 `llm_request_registry`）
    - `POST /api/chat/requests/{id}/confirm` - 确认高风险工具调用（body: `{approved: bool, reason?: str}`，唤醒暂停的工具循环）
  - [x] SubTask 8.2: 在 `main.py` 的 `lifespan` 中调用 `init_main_agent()`（对齐 `init_graph_agent()`）
  - [x] SubTask 8.3: 在 `main.py` 中 `app.include_router(chat_router, prefix="/api", tags=["chat"])`
  - [x] SubTask 8.4: 流式 token 通过 WS 推送，复用现有 `graph_agent_token` 协议但 `op="chat"`，前端按 `op` 区分
  - [x] SubTask 8.5: WS 新增事件类型 `chat_tool_call_confirmation`：高风险工具调用时推送 `{type, op: 'chat', tool, args, request_id, timeout: 60}`，前端弹确认对话框
  - [x] SubTask 8.6: 验证：启动后端 `uv run uvicorn app.main:app --reload --port 8788`，`curl http://127.0.0.1:8788/api/chat/sessions?mode=work` 返回 200

## Phase 3: 前端 ChatPanel 替换（依赖 Phase 2）

- [x] Task 9: 前端类型 + API + store 扩展
  - [x] SubTask 9.1: 在 `lib/types.ts` 新增类型：`ChatSession` / `ChatMessage`（含 `tool_calls?: ToolCall[]`）/ `ToolCall` / `Checkpoint` / `ToolConfirmation`（含 `request_id` / `tool` / `args` / `timeout`）
  - [x] SubTask 9.2: 在 `lib/api.ts` 新增方法：`createChatSession` / `listChatSessions` / `getChatMessages` / `startChatStream` / `cancelChatStream` / `confirmChatToolCall`（POST /api/chat/requests/{id}/confirm）/ `triggerCheckpoint` / `getCheckpoint`
  - [x] SubTask 9.3: 在 `store/useAppStore.ts` 新增状态：`chatSessions` / `currentChatSession` / `chatMessages` / `chatStreamingActive` / `chatStreamingText` / `chatAsking` / `currentCheckpoint` / `planMode`（默认 `false` 即 Build 模式）/ `pendingToolConfirmation`（`ToolConfirmation | null`，非 null 时弹确认对话框）
  - [x] SubTask 9.4: 在 store 新增动作：`loadChatSessions` / `createChatSession` / `sendMessage` / `cancelChat` / `confirmToolCall`（调 confirmChatToolCall API + 清空 pendingToolConfirmation）/ `rejectToolCall` / `loadCheckpoint` / `triggerCheckpoint` / `setPlanMode`
  - [x] SubTask 9.5: 在 store 新增 WS 事件处理：`handleChatToken` / `handleChatToolCall` / `handleChatToolConfirmation`（设置 `pendingToolConfirmation` 触发弹框）/ `handleChatDone` / `handleChatCancelled` / `handleChatError`（在 App.tsx 的 `socket.onEvent` 中订阅 `op="chat"` 的事件）
  - [x] SubTask 9.6: 验证：`pnpm tsc --noEmit` 类型检查通过

- [x] Task 10: ChatPanel 替换为多轮对话
  - [x] SubTask 10.1: 修改 `ChatPanel.tsx` Work 模式：把 `askWorkQuestionStream` 调用替换为 `store.sendMessage(content)`（内部调 `POST /api/chat/sessions/{id}/stream`）
  - [x] SubTask 10.2: 修改 `ChatPanel.tsx` Study 模式：从只渲染 `<ChatHome mode="study" />` 改为支持多轮对话（保留瀑布流首页作为无消息时的占位，有消息时切到对话视图）
  - [x] SubTask 10.3: 新增工具调用过程展示组件：在消息流中显示「正在查询图谱节点…」「正在生成测验…」等状态（基于 `tool_calls` 字段渲染）
  - [x] SubTask 10.4: 新增 Plan/Build 模式切换按钮（Work 模式独有，header 右侧，默认 Build，调 `store.setPlanMode`）
  - [x] SubTask 10.5: 新增高风险操作确认对话框组件：当 `pendingToolConfirmation` 非 null 时弹出，显示工具名（如「从观察抽取节点」）+ 参数摘要 + 「同意/拒绝」按钮 + 可选拒绝原因输入框；同意调 `confirmToolCall`，拒绝调 `rejectToolCall`
  - [x] SubTask 10.6: 保留现有 UI 布局（消息列表 + 底部输入框 + 流式打字机 + 置信度/来源 + 降级提示）
  - [x] SubTask 10.7: 验证：启动前端 `pnpm dev`，在 Work 模式发起对话，能看到流式 token + 工具调用状态；在 Study 模式发起对话（之前无此能力），能收到学习辅导回答；触发高风险工具时弹出确认对话框

## Phase 4: 插件端到端测试（与 Phase 1-3 部分并行）

- [x] Task 11: 后端 pytest 基础设施
  - [x] SubTask 11.1: 在 `backend/pyproject.toml` 的 `[tool.pytest]` / `[project.optional-dependencies]` 加 `pytest-asyncio` + `httpx` 测试依赖（若未已有）
  - [x] SubTask 11.2: 创建 `backend/tests/__init__.py` + `backend/tests/conftest.py`，提供 fixture：
    - `tmp_db` - 用 `tmp_path` 创建临时 SQLite，覆盖 `settings.database_url`
    - `async_client` - `httpx.AsyncClient` + `ASGITransport(app)`，绑定到 app
    - `mock_llm` - monkeypatch `llm_factory.get_llm_client` 返回 mock LLMClient
  - [x] SubTask 11.3: 验证：`uv run pytest tests/ --collect-only` 能发现空测试套件不报错

- [x] Task 12: 后端 webhook 单元测试
  - [x] SubTask 12.1: 创建 `backend/tests/e2e/__init__.py` + `backend/tests/e2e/test_plugin_webhook.py`
  - [x] SubTask 12.2: 测试用例 `test_push_conversation_success`：POST 合法请求 → 200 + `{received: true, observation_id}` + 数据库新增一条 `source='plugin'`
  - [x] SubTask 12.3: 测试用例 `test_push_conversation_dedup`：同 `conversation_id` 重复推送 → 第二次 `{deduplicated: true}` + 数据库不新增
  - [x] SubTask 12.4: 测试用例 `test_push_conversation_invalid_platform`：`platform: "unknown"` → 400 + `{detail: "unsupported platform"}`
  - [x] SubTask 12.5: 测试用例 `test_push_conversation_missing_field`：缺 `conversation_markdown` → 422
  - [x] SubTask 12.6: 测试用例 `test_plugin_health`：`GET /api/plugin/health` → 200 + `{ok, version, supported_platforms, queue_size}`
  - [x] SubTask 12.7: 测试用例 `test_plugin_contract`：`GET /api/plugin/contract` → 200 + 含 `version / supported_platforms / push_examples`
  - [x] SubTask 12.8: 测试用例 `test_plugin_recent`：先推送 N 条，再 `GET /api/plugin/conversations/recent?limit=20` → 倒序列表
  - [x] SubTask 12.9: 验证：`uv run pytest tests/e2e/test_plugin_webhook.py -v` 全部通过

- [x] Task 13: 后端 WS 广播 + e2e 测试
  - [x] SubTask 13.1: 创建 `backend/tests/e2e/test_plugin_ws_broadcast.py`
  - [x] SubTask 13.2: 测试用例 `test_ws_broadcast_on_push`：建立 WS 连接 → POST 推送 → WS 收到 `{type: 'plugin.conversation_received', payload: {observation_id, platform, title, timestamp}}`
  - [x] SubTask 13.3: 测试用例 `test_e2e_full_pipeline`：模拟 collector patch 数据 → 调用 webhook → 验证落库 → 验证 WS 广播 → 验证 payload 一致性
  - [x] SubTask 13.4: 验证：`uv run pytest tests/e2e/test_plugin_ws_broadcast.py -v` 全部通过

- [x] Task 14: 前端 SDK 单元测试（vitest）
  - [x] SubTask 14.1: 创建 `frontend/src/lib/__tests__/kwa-push.test.ts`
  - [x] SubTask 14.2: 测试用例 `test_pushConversation_success`：mock fetch 返回 200 → 验证 SDK 正确构造请求体（platform/timestamp/conversation_markdown/metadata）+ 返回 `{received, observation_id}`
  - [x] SubTask 14.3: 测试用例 `test_pushConversation_retry`：mock fetch 前两次失败、第三次成功 → 验证指数退避（500ms / 1000ms / 2000ms）+ 最终成功
  - [x] SubTask 14.4: 测试用例 `test_pushConversation_dedup`：mock fetch 返回 `{deduplicated: true}` → 验证 SDK 透传 `deduplicated` 字段
  - [x] SubTask 14.5: 测试用例 `test_pushConversation_all_retry_failed`：mock fetch 全部失败 → 验证 SDK 抛错 + 不再重试
  - [x] SubTask 14.6: 验证：`pnpm test -- kwa-push` 全部通过

- [x] Task 15: 前端 store 事件处理测试
  - [x] SubTask 15.1: 创建 `frontend/src/store/__tests__/useAppStore.plugin-event.test.ts`
  - [x] SubTask 15.2: 测试用例 `test_handlePluginConversationReceived_toast`：mock store，调用 `handlePluginConversationReceived(payload)` → 验证 Toast 状态被设置为「收到新对话：{title}」
  - [x] SubTask 15.3: 测试用例 `test_handlePluginConversationReceived_refresh_pending_nodes`：mock store 处于 study 模式图谱视图 → 验证 `loadPendingNodes` 被调用
  - [x] SubTask 15.4: 测试用例 `test_chat_token_event`：mock store，调用 `handleChatToken(event)` → 验证 `chatStreamingText` 累加 + `chatMessages` 最后一条 assistant 消息 content 更新
  - [x] SubTask 15.5: 测试用例 `test_chat_tool_call_event`：mock store，调用 `handleChatToolCall(event)` → 验证最后一条消息的 `tool_calls` 字段追加
  - [x] SubTask 15.6: 测试用例 `test_chat_tool_confirmation_event`：mock store，调用 `handleChatToolConfirmation(event)` → 验证 `pendingToolConfirmation` 被设置为 `{request_id, tool, args, timeout}`；调用 `confirmToolCall()` → 验证调 API + 清空 `pendingToolConfirmation`；调用 `rejectToolCall('原因')` → 验证调 API + 清空
  - [x] SubTask 15.7: 验证：`pnpm test -- useAppStore.plugin-event` 全部通过

# Task Dependencies

- Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7（Phase 1 顺序依赖）
- Task 7 → Task 8（chat 路由依赖 agent + graph_tools）
- Task 8 → Task 9 → Task 10（前端依赖后端 API）
- Task 11 可与 Task 1-10 并行（测试基础设施独立）
- Task 11 → Task 12 → Task 13（后端测试顺序）
- Task 14 可与 Task 12-13 并行（前端 SDK 测试独立）
- Task 14 → Task 15（前端 store 测试依赖 SDK mock 模式）
- **可并行批次**：
  - 批次 A（后端 agent 链）：Task 1-8
  - 批次 B（后端测试基础设施）：Task 11
  - 批次 C（前端 SDK 测试）：Task 14
  - 批次 D（前端 store 测试）：依赖 A 完成 + C 完成
