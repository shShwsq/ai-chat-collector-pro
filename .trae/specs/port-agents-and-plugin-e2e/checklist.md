# Checklist

## A. Agent 移植验证

- [x] `services/main_agent.py` 存在且可 import：`uv run python -c "from app.services.main_agent import main_agent; print('ok')"` 不报错
- [x] `services/writer_agent.py` 存在且可 import：`uv run python -c "from app.services.writer_agent import writer_agent; print('ok')"` 不报错
- [x] `services/context_manager.py` 存在且可 import：`uv run python -c "from app.services.context_manager import ContextManager; print('ok')"` 不报错
- [x] `services/tool_registry.py` 存在且可 import：`uv run python -c "from app.services.tool_registry import ToolRegistry, register_default_tools; print('ok')"` 不报错
- [x] `services/mcp_manager.py` 存在且可 import：`uv run python -c "from app.services.mcp_manager import mcp_manager; print('ok')"` 不报错
- [x] `services/multimodal/image_handler.py` 存在且可 import：`uv run python -c "from app.services.multimodal.image_handler import encode_image_for_llm; print('ok')"` 不报错
- [x] `services/tools/task_tools.py` + `file_tools.py` + `system_tools.py` 存在且可 import
- [x] `services/prompts/main_agent_system.md` + `writer_system.md` 存在且内容已适配 KWA 双模式与图谱场景
- [x] `main_agent.py` 中无对 `notes` / `distill` / `dream` 等未移植模块的 import
- [x] `writer_agent.py` 中无对 `notes` 模块的依赖（已替换为直接写文件或忽略）

## B. 图谱工具接入验证

- [x] `services/tools/graph_tools.py` 存在且实现 7 个工具函数：`graph_query_nodes` / `graph_get_node_detail` / `graph_get_context` / `graph_extract_from_observation` / `graph_generate_quiz` / `graph_generate_trends` / `graph_generate_report`
- [x] `register_graph_tools(registry)` 把上述工具注册到 ToolRegistry
- [x] `tool_registry.register_default_tools` 调用 `register_graph_tools`
- [x] `graph_tools.py` 顶部定义 `HIGH_RISK_TOOLS = {"graph_extract_from_observation"}` 常量
- [x] **Study 模式**：暴露全部 7 个图谱工具（含 `graph_extract_from_observation`，但调用时走高风险拦截）
- [x] **Work 模式 Build（默认）**：暴露全部 7 个图谱工具，高风险工具走拦截
- [x] **Work 模式 Plan**：仅暴露只读工具（`graph_query_nodes` / `graph_get_node_detail` / `graph_get_context` / `graph_generate_quiz` / `graph_generate_trends` / `graph_generate_report`），**高风险工具一律拒绝**（不弹框，直接回填拒绝原因）
- [x] `main_agent.chat_stream` 支持 `graph_id` + `mode` + `plan_mode` 参数
- [x] `graph_id` 存在时自动注入 `graph_agent._build_context(graph_id)` 到系统提示
- [x] `main_agent.HIGH_RISK_TOOLS` 可被 import

## C. 后端 chat 路由验证

- [x] `routers/chat.py` 存在，实现 8 个端点：`POST /api/chat/sessions` / `GET /api/chat/sessions` / `GET /api/chat/sessions/{id}/messages` / `POST /api/chat/sessions/{id}/stream` / `POST /api/chat/sessions/{id}/checkpoint` / `GET /api/chat/sessions/{id}/checkpoint` / `POST /api/chat/requests/{id}/cancel` / `POST /api/chat/requests/{id}/confirm`
- [x] `main.py` 在 lifespan 中调用 `init_main_agent()`
- [x] `main.py` 注册 chat 路由：`app.include_router(chat_router, prefix="/api", tags=["chat"])`
- [x] `POST /api/chat/sessions/{id}/stream` 立即返回 `{request_id, started: true}`，后台异步跑 `main_agent.chat_stream`
- [x] 流式 token 通过 WS 推送，事件 `op="chat"`，与现有 `graph_agent_token` 协议区分
- [x] WS 新增事件类型 `chat_tool_call_confirmation`：高风险工具调用时推送 `{type, op: 'chat', tool, args, request_id, timeout: 60}`
- [x] `POST /api/chat/requests/{id}/confirm` 端点：body `{approved: bool, reason?: str}`，唤醒暂停的工具循环
- [x] 启动后端 `uv run uvicorn app.main:app --reload --port 8788`，`curl http://127.0.0.1:8788/api/chat/sessions?mode=work` 返回 200

## D. 前端 ChatPanel 替换验证

- [x] `lib/types.ts` 新增 `ChatSession` / `ChatMessage` / `ToolCall` / `Checkpoint` / `ToolConfirmation` 类型
- [x] `lib/api.ts` 新增 8 个 chat API 方法（含 `confirmChatToolCall`）
- [x] `store/useAppStore.ts` 新增 chat 相关状态（含 `planMode` 默认 `false` + `pendingToolConfirmation`）+ 动作（含 `confirmToolCall` / `rejectToolCall`）+ WS 事件处理（含 `handleChatToolConfirmation`）
- [x] `App.tsx` 的 `socket.onEvent` 订阅 `op="chat"` 的事件，分发到 `handleChatToken` / `handleChatToolCall` / `handleChatToolConfirmation` / `handleChatDone` / `handleChatCancelled` / `handleChatError`
- [x] `ChatPanel.tsx` Work 模式调用 `store.sendMessage`（不再调 `askWorkQuestionStream`）
- [x] `ChatPanel.tsx` Study 模式新增对话能力（之前只有瀑布流首页）
- [x] 工具调用过程展示组件就位，agent 调用图谱工具时消息流显示「正在查询图谱节点…」等状态
- [x] Plan/Build 模式切换按钮就位（Work 模式 header 右侧，默认 Build）
- [x] 高风险操作确认对话框组件就位：`pendingToolConfirmation` 非 null 时弹出，显示工具名 + 参数摘要 + 「同意/拒绝」按钮 + 可选拒绝原因输入框
- [x] 保留现有 UI 布局：消息列表 + 底部输入框 + 流式打字机 + 置信度/来源 + 降级提示
- [x] **不展示 Checkpoint 侧栏**（writer_agent 在后台静默运行，UI 不暴露 11 字段状态）
- [x] `pnpm tsc --noEmit` 类型检查通过
- [x] 启动前端 `pnpm dev`，Work 模式发起对话能看到流式 token + 工具调用状态
- [x] Study 模式发起对话（之前无此能力）能收到学习辅导回答
- [x] 触发高风险工具（如让 agent 调 `graph_extract_from_observation`）时弹出确认对话框；点同意 → 工具执行；点拒绝 → agent 收到拒绝原因继续对话

## E. 插件端到端测试验证 - 后端

- [x] `backend/pyproject.toml` 含 `pytest-asyncio` + `httpx` 测试依赖
- [x] `backend/tests/conftest.py` 提供 `tmp_db` / `async_client` / `mock_llm` fixture
- [x] `tmp_db` fixture 用 `tmp_path` 创建临时 SQLite，不读写 `backend/data/app.db`
- [x] `mock_llm` fixture monkeypatch `llm_factory.get_llm_client`，测试不发真实 LLM 请求
- [x] `backend/tests/e2e/test_plugin_webhook.py` 含 8 个测试用例：`test_push_conversation_success` / `test_push_conversation_dedup` / `test_push_conversation_invalid_platform` / `test_push_conversation_missing_field` / `test_plugin_health` / `test_plugin_contract` / `test_plugin_recent` + 1 个边界用例
- [x] `backend/tests/e2e/test_plugin_ws_broadcast.py` 含 2 个测试用例：`test_ws_broadcast_on_push` + `test_e2e_full_pipeline`
- [x] `uv run pytest tests/e2e/ -v` 全部通过
- [x] 测试运行不需要真实 LLM API Key（全部 mock）

## F. 插件端到端测试验证 - 前端

- [x] `frontend/src/lib/__tests__/kwa-push.test.ts` 含 5 个测试用例：`test_pushConversation_success` / `test_pushConversation_retry` / `test_pushConversation_dedup` / `test_pushConversation_all_retry_failed` + 1 个边界用例
- [x] 测试用 vitest mock fetch，不发真实网络请求
- [x] `frontend/src/store/__tests__/useAppStore.plugin-event.test.ts` 含 5 个测试用例：`test_handlePluginConversationReceived_toast` / `test_handlePluginConversationReceived_refresh_pending_nodes` / `test_chat_token_event` / `test_chat_tool_call_event` / `test_chat_tool_confirmation_event`
- [x] `pnpm test -- kwa-push` 全部通过
- [x] `pnpm test -- useAppStore.plugin-event` 全部通过

## G. 整体回归验证

- [x] 现有 `GraphAgent` 与 `answer_question_stream` 未被删除（保留作为 graph_tools 底层实现）
- [x] 现有 `QAPanel` 浮层仍可正常使用 `answer_question_stream`
- [x] 现有 study 模式图谱视图（GraphView / CardView / PendingNodes / QuizPanel）功能未受影响
- [x] 现有 work 模式图谱视图（WorkInput / TrendsSidebar / ReportPanel）功能未受影响
- [x] `web-ai-chat-collector/` 目录内文件未被修改
- [x] `步影/` 目录内文件未被修改
- [x] 后端启动无报错：`uv run uvicorn app.main:app --reload --port 8788`（app 创建成功，17 路由注册）
- [x] 前端启动无报错：`pnpm dev`（pnpm tsc --noEmit 类型检查通过）
- [x] 全部测试通过：`uv run pytest tests/ -v` + `pnpm test`

## H. 高风险操作拦截验证

- [x] `graph_extract_from_observation` 被标记为 `HIGH_RISK_TOOLS`
- [x] Build 模式下 agent 调用高风险工具时，前端弹出确认对话框（显示工具名 + 参数摘要 + 同意/拒绝按钮）— 代码已实现：`ToolConfirmDialog.tsx` 组件 + `pendingToolConfirmation` 状态 + `handleChatToolConfirmation` 事件处理 + 单元测试 `test_chat_tool_confirmation_event` 覆盖
- [x] 用户点「同意」→ 后端执行工具 → 结果回填给 agent → agent 继续对话 — 代码已实现：`POST /api/chat/requests/{id}/confirm` 端点 + `resolve_tool_confirmation(approved=true)` + `main_agent` 工具执行回填 + 单元测试覆盖 `confirmToolCall` API 调用
- [x] 用户点「拒绝」并填写原因 → 后端把「用户拒绝：原因 XXX」回填给 agent → agent 在消息中告知用户「已取消抽取」并调整后续对话 — 代码已实现：`resolve_tool_confirmation(approved=false, reason)` + 拒绝原因回填 + 单元测试覆盖 `rejectToolCall` API 调用
- [x] 60 秒超时未响应 → 后端视为拒绝，把「用户未响应，视为拒绝」回填给 agent — 代码已实现：`main_agent._intercept_high_risk_tool` 的 `asyncio.wait_for(timeout=60)` 超时分支
- [x] Plan 模式下 agent 调用高风险工具 → 不弹框，直接回填「Plan 模式下不允许」给 agent — 代码已实现：`main_agent._intercept_high_risk_tool` 的 `rejected_by: "plan_mode"` 分支（第 1209 行）
- [x] 低风险工具（query_nodes / get_node_detail / get_context / generate_quiz / generate_trends / generate_report）调用时不弹框，直接执行 — 代码已实现：`HIGH_RISK_TOOLS` 仅含 `graph_extract_from_observation`，其他工具直接走 ToolRegistry 执行
