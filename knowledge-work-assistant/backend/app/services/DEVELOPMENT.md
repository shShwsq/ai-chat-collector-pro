# services/ 服务层开发指南

> 一句话定位：本目录是 KWA 后端的业务服务层，21+ 个模块 + `tools/` / `multimodal/` / `prompts/` 子包按职责拆分：图谱 CRUD（`graph_store`）、图谱 AI Agent（`graph_agent`）、LLM 调用栈（`llm_client` / `llm_factory` / `llm_errors` / `llm_request_registry` / `model_config`）、配置与加密（`settings_store` / `crypto`）、WebSocket 通知（`ws_notify`）、会话队列（`session_queue`）、知识 / 标签 / 文件（`knowledge_store` / `tag_store` / `file_storage`）、子 Agent（`sub_agent`）、主 Agent 与 Writer 子 Agent（`main_agent` / `writer_agent`）、上下文管理（`context_manager` / `compaction`）、MCP 与工具（`mcp_manager` / `tool_registry` + `tools/` 子包）、多模态与提示词（`multimodal/` / `prompts/`）。本层方法均 `async def`，DB 操作走 `AsyncSessionLocal`；LLM 调用必须经 `llm_factory.get_llm_client()` 获取客户端，不直接 `import openai`。

## 与 web-ai-chat-collector 的关系（软件 + 插件一体化）

本目录是后端服务层，与插件侧 [web-ai-chat-collector](../../../web-ai-chat-collector/DEVELOPMENT.md) 的对接关系如下：

- **`graph_agent` 消费推送数据**：`graph_agent.py` 的 `extract_candidates_from_observation(observation_id)` 读取 `observations.conversation_markdown`（collector 推送的 `## 用户` / `## 助手` 分段 Markdown），调 LLM 抽取候选节点；解析逻辑依赖 collector 的对话格式契约，改格式需同步 [content/network/common.js](../../../web-ai-chat-collector/content/network/common.js) 的 `buildAssistantContent`。
- **`graph_store` 管理推送数据 CRUD**：`create_observation(source='plugin')` 由 `routers/plugin.py` 调用写入 collector 推送的对话；`find_observation_by_dedup_key` 实现 24h 幂等去重；`list_recent_plugin_conversations` 供前端 PluginIntegrationSection 展示。
- **`ws_notify` 广播推送事件**：collector 推送成功后，`ws_notify.broadcast` 向所有前端 WebSocket 连接推 `plugin.conversation_received` 事件，前端收到后弹 Toast 并刷新"待抽取"侧栏。
- **`model_config` 与 collector 清单独立**：`model_config.py` 加载 `model_config.json`，与 collector 的 [models.json](../../../web-ai-chat-collector/models.json) 是**两份独立清单**；同步新增厂商时两侧各改一处。
- **`llm_client` 与 collector LLM 客户端独立**：本目录 `llm_client.py` 用 Python + OpenAI SDK，collector 的 [lib/llm.js](../../../web-ai-chat-collector/lib/llm.js) 用 JavaScript + fetch SSE；**两套独立实现**，不共享代码，但可共享 LLM 凭据（各自配置）。
- **`graph_agent` 不自动抽取**：collector 推送落库后，`graph_agent` **不自动触发**抽取；抽取由用户在前端"待抽取"侧栏主动点击触发（调 `routers/extraction.py`）。

跨子工程任务（同步 LLM Provider、调整对话格式、并行开发联调等）请参考工作区根 [DEVELOPMENT.md](../../../DEVELOPMENT.md) 的"常见跨子工程任务"章节。

## 模块职责

```
services/
├── __init__.py                # 仅 docstring + from __future__，不聚合导出
├── graph_store.py             # 图谱 CRUD（Graph / Node / Edge / Observation / Quiz）
├── graph_agent.py             # 图谱 AI Agent（节点详情 / 延伸 / 抽取 / 测验 / 风口 / 报告 / 提问 / 流式）
├── llm_client.py              # OpenAI 兼容 LLM 客户端（流式 / 非流式 / 向量化 + 重试 + 取消）
├── llm_factory.py             # LLM 客户端工厂：从 settings 表读取配置构造 LLMClient
├── llm_errors.py              # LLM 错误类型层级（LLMError / LLMAuthError / LLMRateLimitError / ...）
├── llm_request_registry.py    # LLM 请求注册表（取消 / 清理 / 状态查询）
├── task_registry.py           # **后台任务托管**：流式任务 / 取消等待统一注册，lifespan 统一关停
├── model_config.py            # 模型配置注册表：从 model_config.json 加载并缓存
├── settings_store.py          # settings 表读写助手（普通字段 JSON 序列化，敏感字段加密）
├── crypto.py                  # Fernet 对称加密（敏感字段加密存储）
├── ws_notify.py               # WebSocket 连接注册表（按 session_id 索引，broadcast / notify_session / 健康检查 / close_all）
├── session_queue.py           # 会话队列（任务排队执行）
├── knowledge_store.py         # 知识存储与 FTS5 全文检索
├── tag_store.py               # 标签库 CRUD（去重 / 同义词归一）
├── file_storage.py            # 文件落盘与元数据管理
├── sub_agent.py               # 子 Agent 编排（任务分发 / 工具调用）
├── main_agent.py              # 主 Agent（Task 5）：多轮对话主循环 + Function Calling + Plan/Build 工具白名单 + 高风险工具拦截
├── writer_agent.py            # Writer Subagent（Task 6）：带工具循环的结构化状态记录员，输出 11 字段 checkpoint
├── context_manager.py         # 无限上下文管理器（Task 1）：Checkpoint + Rebuild + Compaction + 文件原文替换四机制协同
├── compaction.py              # 上下文压缩：兜底层摘要压缩 + prune_tool_outputs 裁剪旧工具输出
├── mcp_manager.py             # MCP 客户端管理器（Task 2）：管理 MCP 服务器生命周期 + 工具注册到主 Agent
├── tool_registry.py           # Function Calling 工具注册表（Task 2）：OpenAI function schema + 统一执行框架 + plan/build 白名单
├── tools/                     # 工具 handler 子包（详见 tools/DEVELOPMENT.md）
├── multimodal/                # 多模态子包：image_handler（图片转 base64 data URL）
└── prompts/                   # 系统提示词子包：main_agent_system.md + writer_system.md + 加载函数
```

## 关键文件

### `graph_store.py`：图谱 CRUD

提供 `Graph` / `Node` / `Edge` / `Observation` / `Quiz` 的 CRUD 接口，作为路由层与 Agent 之间的中间层。模块级单例 `graph_store = GraphStore()`，路由通过 `Depends(get_graph_store)` 注入。

**设计要点**：
1. **返回 dict 而非 ORM 实例**：避免懒加载在 session 关闭后触发 `DetachedInstanceError`，所有查询结果在 session 内显式序列化为 `dict[str, Any]`。
2. **JSON 字段透明序列化**：`detail_payload` / `user_fill` / `metadata_json` / `payload` / `result` 在 DB 中以 TEXT 存储，本层在读取时反序列化为 dict，写入时序列化为 JSON 字符串，调用方无需关心。
3. **节点类型校验**：`create_node` / `update_node` 校验 `node_type` 在对应图谱模式的合法枚举内（见 [../models/node_types.py](../models/node_types.py)），非法类型抛 `ValueError`。
4. **图谱隔离**：所有节点 / 边 / 测验操作均通过 `graph_id` 关联到图谱，删除图谱时级联清理（`ondelete=CASCADE`）。
5. **边的无向规范化**：`create_edge(graph_id, src_id, dst_id, relation, ...)` 在写入前对 `(src_id, dst_id)` 做 `sorted()`，确保同一对节点的正反方向只存一条记录；启动迁移会对历史 edges 表做方向规范化 + 去重 + 建唯一索引 `uq_edges_graph_endpoints_relation`，后续 `create_edge` 的去重查询只需匹配单一方向。
6. **观察来源**：`create_observation(source='plugin' | 'import' | 'manual', platform, ..., dedup_key=None)` 支持三种来源，新增独立 `dedup_key` 参数（替代旧 `metadata._dedup_key` JSON 路径）；`mark_observation_processed` 标记已被 Agent 处理，避免重复抽取。
7. **幂等去重**：`find_observation_by_dedup_key(dedup_key, within_hours)` 直接查独立 `dedup_key` 列 + 启动迁移建好的部分唯一索引 `uq_observations_dedup_key`，不再走 `json_extract(metadata_json, '$._dedup_key')`；历史数据由 `_migrate_add_columns` 从 JSON 回填并对重复键保留最早一条，其余置空后建索引。
8. **SQLite 并发写入保护**：`create_observation` 的 DB 写入包在 `with_sqlite_lock_retry(_insert)` 中执行，遇到 `database is locked` / `database table is locked` 时最多重试 4 次（指数退避 50/100/200/400ms），仍失败才向上抛异常。

主要方法（部分）：
- 图谱：`create_graph` / `list_graphs` / `get_graph` / `get_full_graph` / `update_graph` / `delete_graph` / `get_graph_stats`
- 节点：`create_node` / `get_node` / `list_nodes` / `update_node` / `delete_node` / `batch_create_nodes` / `touch_node` / `set_remind` / `set_starred`
- 边：`create_edge` / `list_edges` / `delete_edge`
- 观察：`create_observation` / `list_observations` / `get_observation` / `mark_observation_processed` / `find_observation_by_dedup_key` / `list_recent_plugin_conversations`
- 测验：`create_quiz` / `get_quiz` / `list_quizzes` / `update_quiz_result`

### `graph_agent.py`：图谱 AI Agent

封装所有图谱相关的 AI 操作，模块级单例 `get_graph_agent()` 返回。LLM 客户端按调用获取（`_get_llm_client`），凭据缺失时返回 None 并记日志。

**设计要点**：
1. **不修改 `sub_agent` / `graph_store`**：本模块仅通过 `llm_factory.get_llm_client` 获取客户端、通过 `GraphStore` 读写图谱数据，对其它模块均为只读调用。
2. **统一降级策略**：所有方法在 LLM 不可用（凭据缺失 / 调用失败 / JSON 解析失败）时返回明确的降级结果（空列表 / 空结构 / 兜底文本 + `degraded: True`），不向上抛异常，确保后端不崩溃。
3. **JSON 容错解析**：`_call_llm_json` 剥离 markdown 代码块包裹、尝试 `json.loads`，失败时记录原始文本并返回 None，调用方据此走降级。
4. **流式方法**：`generate_node_detail_stream` / `answer_question_stream` / `generate_report_stream` 通过 `LLMClient.chat_stream` 逐 token 产出，同时通过 `ws_notify.notify_session` 推送给前端（按 `session_id` 路由）。
5. **上下文构建**：`_build_context` 将图谱节点 / 边序列化为紧凑文本，作为 LLM 的上下文输入，避免 token 浪费。
6. **类型推断**：`generate_node_detail` 在 `node_type` 为通用兜底时，利用 `neighbors` 上下文让 LLM 推断更具体的类型，并据此选择模板。
7. **长对话分块抽取**（修复 Issue #9：graph_agent 长对话静默截断丢失节点）：
   - 新增常量 `_CONVERSATION_CHUNK_SIZE=6000` / `_CHUNK_OVERLAP=500` / `_MAX_EXISTING_NODES_HINT=50`；
   - 新工具函数 `_split_conversation(text)`：按字符切分为多块，优先在换行处断开避免割裂句子，块间保留重叠字符以保证跨块节点连续性；短于一块返回单元素列表；
   - 新工具函数 `_merge_nodes(chunk_results)`：按 `_titles_similar` 归一化标题跨块去重，保留首次出现的版本（前块优先）；
   - 新内部方法 `_extract_nodes_from_chunk(...)`：单块抽取封装，prompt 注入「已有节点标题（同义归一）」与「分块上下文（当前块序号/总数）」；
   - 方法 `extract_nodes_from_observation` 升级为顺序逐块抽取 + 末尾合并去重，短对话走单块原路径兼容旧行为。
8. **同义归一**：抽取前从 `store.list_nodes(graph_id)` 加载当前图谱已有节点标题（最多 `_MAX_EXISTING_NODES_HINT` 个）注入 prompt，要求 LLM 优先复用已有标题，避免产生"乘法"与"乘法运算"这类同义重复节点。

主要方法（部分）：
- 节点详情：`generate_node_detail` / `generate_node_detail_stream`
- 节点延伸：`extend_node`（mode='all' / 'single'） / `revoke_extension`
- 候选抽取：`extract_nodes_from_observation(observation_id, graph_type) -> dict`（**返回结构变更**：旧版返回 `list[dict]`，新版返回 `{nodes, count, truncated, segment_count, original_length}`；`nodes` 是清洗后的节点列表，`truncated` 标记是否触发分块抽取，`segment_count` 是实际分块数，`original_length` 是原对话字符数。LLM 不可用时 nodes 为空列表，其余字段仍正常返回。调用方需做 `isinstance(result, dict)` 兜底兼容。）
- Work 候选抽取：`extract_work_objects_from_observation`（Work）
- 测验：`generate_quiz` / `grade_quiz_answer`
- Work 业务：`get_trends` / `generate_report` / `generate_report_stream` / `answer_question` / `answer_question_stream`
- 内部工具：`_get_llm_client` / `_call_llm_json` / `_build_context` / `_stream_llm` / `_split_conversation` / `_merge_nodes` / `_extract_nodes_from_chunk` / `_fallback_quiz`（**降级测验占位题生成**）

**测验降级逻辑（新增）**：

`_fallback_quiz(quiz_type, primary_node)` 在 LLM 不可用时生成占位题，避免前端白屏：
- **选择题降级**：返回 4 个占位选项（A/B/C/D），正确答案固定为 A，明确标注"【占位题】"；提示用户配置 LLM 后重试。
- **费曼题降级**：返回占位提示"请用自己的话解释..."，同样标注为占位题。
- **返回字段**：`degraded: True` + `degrade_reason: "LLM 服务暂不可用，当前为占位题。配置好 LLM 后重新生成即可获得正常题目。"`。
- **前端协作**：前端检测到 `degraded=true` 时显示降级横幅，但允许用户作答（固定判分结果）。

### `llm_client.py`：OpenAI 兼容 LLM 客户端

基于 `openai.AsyncOpenAI` 实现流式 / 非流式对话与向量化，封装统一的错误处理与重试策略：

- **网络错误**（`httpx.ConnectError` / `httpx.ReadTimeout`）：最多重试 3 次，指数退避 1s / 2s / 4s。
- **429 限流**：尊重 `Retry-After` header（无则默认 5s），最多重试 2 次。
- **401 / 403 鉴权错误**：不重试，立即抛 `LLMAuthError`。
- **其他 5xx**：重试 2 次，指数退避。
- **流式响应中途中断**：抛 `LLMStreamError`，由调用方处理。

**事件流**（`chat_stream` 产出）：
- `{"type": "token", "content": "..."}`：内容增量
- `{"type": "tool_call", "id": "...", "name": "...", "arguments": "..."}`：工具调用（聚合 deltas 后产出完整 tool_call）
- `{"type": "finish", "reason": "stop"|"tool_calls"|"length"|...}`：完成原因
- `{"type": "cancelled"}`：请求被外部取消（仅当 `request_id` 传入且被 cancel 时）

**请求注册表集成**：调用方可在 `chat` / `chat_stream` / `embed` 传入 `request_id` 关联 `llm_request_registry` 中的请求条目。流式调用会在每个 chunk 边界检查 `is_cancelled`，被取消时主动中断并产出 `cancelled` 事件。

主要方法：`chat(messages, ...)` / `chat_stream(messages, ...)` / `embed(texts)` / `embed_query(text)`。

### `llm_factory.py`：LLM 客户端工厂

`get_llm_client(session) -> LLMClient`：从 `settings` 表读取 `llm.base_url` / `llm.api_key`（解密）/ `llm.model`，构造 `LLMClient` 实例。任一缺失抛 `HTTPException(400)`。模型属性（`max_output_tokens` / `default_temperature`）从 `model_config.get_model_config(model)` 读取。`context_window` **不传给 LLMClient**：由用户在 Ollama Modelfile 中自行配置，后端仅在 `ContextManager` 层记录用于触发压缩 / rebuild。

**配置优先级**：`settings` 表（用户在 SettingsPanel 配置）→ `.env`（开发期兜底）。

### `llm_errors.py`：LLM 错误类型层级

- `LLMError`：基类
- `LLMAuthError`（401 / 403）
- `LLMRateLimitError`（429）
- `LLMConnectionError`（网络错误）
- `LLMServerError`（5xx）
- `LLMStreamError`（流式中断）

`graph_agent` 捕获这些错误后走降级路径，不向上抛。

### `llm_request_registry.py`：LLM 请求注册表

模块级单例 `llm_request_registry`，管理所有活跃的 LLM 请求：
- `register(request_id, task: asyncio.Task, info: dict)`：注册请求。
- `cancel(request_id)`：取消请求（`task.cancel()`，抛 `CancelledError`）。
- `get(request_id)`：查询请求状态。
- `list_active()` / `list_all()`：列出请求。
- `cleanup()`：清理已完成的请求记录。

供 `routers/llm_admin.py` 与 `routers/stream.py` 使用。

### `task_registry.py`：后台任务托管注册表

新增的后台任务统一托管模块，解决 lifespan 退出时裸 `asyncio.create_task` 悬挂、uvicorn 关停时任务被暴力取消无法清理的问题。模块级单例 `background_tasks = TaskRegistry()`。

**生命周期**：
- `start_accepting()`：由 lifespan 在所有初始化完成后、yield 前调用，此后 `create_task` 才会接受新任务；未开启前调用抛 `RuntimeError`，保证启动阶段不会提前注册任务。
- `shutdown(timeout=8.0)`：由 lifespan 在 yield 后调用；依次执行：标记停止接受新任务 → 对所有未完成 task 调 `task.cancel()` → 用 `asyncio.wait_for` 聚合并行等待所有 task 结束（超时未结束直接丢弃）。返回 `(cancelled_count, done_count, timeout_count)` 三元组供日志。

**核心 API**：
- `create_task(coro, *, request_id=None, session_id=None, op=None) -> asyncio.Task`：创建并登记托管任务，返回原始 Task 对象（与 `asyncio.create_task` 兼容）。可选元数据 `request_id/session_id/op` 写入包装对象，供调试时查看任务归属（流式 / chat / 取消等待等）。
- 属性 `.tasks`：只读视图，外部调试可枚举当前登记的任务。

**与 routers 的集成**：`chat.py` 的流式对话与 `cancel_and_wait`、`stream.py` 的三个流式端点，现全部从裸 `asyncio.create_task` 切换为 `background_tasks.create_task(...)`，随 lifespan 统一关停。

### `model_config.py`：模型配置注册表

模块级单例 `_REGISTRY`，从 `backend/data/model_config.json` 加载模型配置并缓存。`get_model_config(model_name)` 返回模型属性 dict（`context_window` / `max_output_tokens` / `default_temperature` / `supports_tools` / `supports_streaming` / `vendor` / `description`）。

**配置优先级**（高 → 低）：
1. DB `settings` 表的 `llm.context_window`（运行时覆盖，由 `PUT /api/llm/config` 设置）
2. `model_config.json` 中该模型的 `context_window`
3. `model_config.json` 中 `default` 条目的 `context_window`
4. 硬编码兜底 `_FALLBACK_DEFAULT`（8192）

启动时由 `main.py` 调 `_REGISTRY.load()`；运行时可调 `reload_model_config()` 重载。文件不存在或解析失败时回退到 `_FALLBACK_DEFAULT`，不抛异常。

### `settings_store.py`：settings 表读写助手

- `get_setting(session, key, default)`：读取普通设置（JSON 反序列化），不存在返回 default。
- `set_setting(session, key, value)`：写入普通设置（JSON 序列化）。
- `get_secret(session, key, default)`：读取加密字段（解密后返回明文），不存在或解密失败返回 default。
- `set_secret(session, key, plaintext)`：写入加密字段（加密后 JSON 序列化）。

**加密字段**：`ENCRYPTED_KEYS = frozenset({'llm.api_key', 'asr.mimo_api_key'})`，自动经 `crypto.encrypt` / `decrypt`。

### `crypto.py`：Fernet 对称加密

- `encrypt(plaintext: str) -> str`：明文 → Fernet token 字符串。
- `decrypt(ciphertext: str) -> str`：Fernet token 字符串 → 明文。

**加密 key 来源**（优先级）：
1. 环境变量 `APP_ENCRYPTION_KEY`
2. `settings.data_dir / .encryption_key`（不存在则生成一次并落盘，POSIX 上 chmod 0o600）

`.encryption_key` 文件已被 `.gitignore` 中的 `data/` 规则覆盖，不会被 git 跟踪。**该文件丢失则历史加密字段无法解密**，需重新配置 LLM 凭据。

### `ws_notify.py`：WebSocket 连接注册表

按 `session_id` 索引的连接注册表，强化了连接生命周期管理与并发安全：

- `register(session_id, ws)`：注册连接。**新行为**：同一会话重新连入时，会用新连接替换旧集合，并主动 `close(code=1000, reason="同一会话已建立新连接")` 关闭被替换的旧 socket，避免重连后重复投递。
- `unregister(session_id, ws)`：注销连接（幂等，空集合自动从 dict 移除）。
- `notify_session(session_id, event) -> int`：向指定会话的所有连接推送事件，返回成功推送的连接数。**推送失败的连接会被追加到 `failed` 列表，循环结束后统一调 `unregister` 清理**，防止脏连接长期占据注册表。
- `broadcast(event) -> int`：向所有连接推送事件，返回成功推送的连接数。同样在失败时回收脏连接；广播时记录 `(session_id, ws)` 二元组以便精确清理。
- `has_session_connection(session_id) -> bool`：同步判断是否存在**已连接** socket（过滤 `client_state / application_state` 非 `CONNECTED` 的僵尸连接）。
- `is_session_online(session_id) -> bool`：异步锁内判断，供业务侧在推送前做快速筛选。
- `close_all() -> int`：清空注册表并关闭所有 socket（`code=1001, reason="服务正在关闭"`），供应用关停阶段使用。

**连接健康检查**：`_is_connected(ws)` 同时校验 `ws.client_state` 与 `ws.application_state` 均为 `WebSocketState.CONNECTED`，过滤"半关闭但尚未清理"的僵尸连接，避免向已关闭 socket 推送导致异常。

**事件预序列化（修复 Bug：含 datetime / UUID 的事件静默失败）**：

`_dumps_event(event) -> str` 在 `notify_session` / `broadcast` 入口处将事件预序列化为 JSON 字符串：
- 调用 `json.dumps(event, ensure_ascii=False, default=str)`，**用 `default=str` 兜底**把 datetime / UUID / ORM 对象等非 JSON 原生类型转字符串；与持久化层（`main_agent` 落库 `tool_calls`）的 `default=str` 策略保持一致。
- 然后用 `ws.send_text(payload)` 发送，**不再用 `ws.send_json(event)`**。
- **修复背景**：旧实现 `send_json` 内部 `json.dumps` 遇到 datetime / UUID 抛 `TypeError`，被 `except Exception` 静默吞掉——既丢消息又会把仍开着的连接误判为死连接并 `unregister`，导致该 session 后续所有 WS 事件都丢失（典型场景：`graph_generate_quiz` 返回的 quiz 记录含 `created_at` datetime 字段，`chat_tool_result` 事件无法送达前端，测验卡需刷新才显示）。
- **回归覆盖**：[`backend/tests/test_ws_notify.py`](../../../tests/test_ws_notify.py) 提供三条用例：含 datetime 的 `notify_session` 成功送达、含 datetime 的 `broadcast` 成功送达、真正断开的连接仍按原逻辑被清理。

**并发安全**：`asyncio.Lock` 保护内部 `dict`。`notify_session` / `broadcast` 在持锁阶段仅做"复制连接列表到局部变量 + 预序列化 JSON 字符串"，释放锁后再 `await ws.send_text(payload)`，避免长时间持锁阻塞其他 `register` / `unregister`。预序列化在持锁外执行不会影响并发安全（每个 event 独立生成 payload 字符串）。

### `session_queue.py`：会话队列

任务排队执行，避免同一会话并发执行多个 LLM 任务导致上下文混乱。供 `graph_agent` 使用。

### `knowledge_store.py`：知识存储与 FTS5 全文检索

基于 `messages_fts` / `checkpoints_fts` / `file_metadata_fts` / `observations_fts` 虚拟表提供全文检索。FTS5 不可用时静默降级（返回空列表）。

### `tag_store.py`：标签库 CRUD

标签库（`tags` 表）的去重 / 同义词归一 / 文件关联。FTS5 不可用时不影响核心 CRUD。

### `file_storage.py`：文件落盘与元数据管理

文件上传到 `data/files/`，元数据存 `file_metadata` 表。支持 PDF / Word / PPT / 图片等格式（依赖 `pypdf` / `python-docx` / `python-pptx` / `Pillow`）。

### `sub_agent.py`：子 Agent 编排

任务分发 / 工具调用编排。**注意**：`main_agent` 已完整移植（Task 5）并接入 `routers/chat.py`；依赖 `context_manager` / `mcp_manager` / `tool_registry` / `multimodal.image_handler` / `tools.task_tools` 均已就位。MCP 包为可选依赖（未在 pyproject.toml 声明），缺失时 `mcp_manager` 以降级模式运行。

### `main_agent.py`：主 Agent（Task 5）

多轮对话主循环，集成上下文管理、Function Calling、Plan/Build 工具白名单、高风险工具拦截、Study/Work 双模式。

- **关键类**：`MainAgent` 类、`get_main_agent()`、`init_main_agent()`、`resolve_tool_confirmation()`
- **关键常量**：`MAX_TOOL_ITERATIONS=10`、`TOOL_CONFIRMATION_TIMEOUT=60.0`、`HIGH_RISK_TOOLS`
- **依赖**：`ContextManager` / `LLMClient` / `mcp_manager` / `ToolRegistry` + `register_default_tools` / `TaskStore` / `graph_agent`（注入图谱上下文）/ `ws_notify.notify_session` / `encode_image_for_llm` / `get_model_config`
- **事件流**：`token` / `tool_call` / `tool_result` / `tool_call_confirmation` / `error` / `done`

### `writer_agent.py`：Writer Subagent（Task 6）

带工具循环的结构化状态记录员，输出 11 字段 checkpoint。

- **关键类**：`WriterAgent` 类、`get_writer_agent()`、`init_writer_agent(llm_client)`、`CHECKPOINT_FIELDS`（11 字段常量）
- **依赖**：`LLMClient` / `LLMError` / ORM `Checkpoint` / `prompts/writer_system.md`
- **设计**：拥有 file_read/file_write/file_list 工具循环；delta as messages；从 checkpoint.md 解析 + JSON fallback

### `context_manager.py`：无限上下文管理器（Task 1）

MiMo-Code 风格"显式存储 + 按需检索"上下文管理，四机制协同：Checkpoint + Writer Subagent / Rebuild + Cycle / Compaction / 文件原文替换。

- **关键类**：`ContextManager` 类
- **关键常量**：`DEFAULT_CHECKPOINT_THRESHOLDS=[0.20, 0.45, 0.70]`、`COMPACT_THRESHOLD=0.85`、`REBUILD_THRESHOLD=0.85`、`REBUILD_BUDGET_RATIO=0.5`、`ROUNDS_BEFORE_FILE_REPLACE=3`、`_CHARS_PER_TOKEN=1.5`
- **依赖**：`Compactor` / `prune_tool_outputs` / `LLMClient` / `WriterAgent` / ORM `Checkpoint` / `FileMetadata` / `Message`

### `compaction.py`：上下文压缩

兜底层上下文压缩，自动/手动将旧消息压缩为摘要，Prune 裁剪旧工具输出。

- **关键类**：`Compactor` 类、`prune_tool_outputs()`
- **关键常量**：`DEFAULT_KEEP_RECENT=6`、`DEFAULT_KEEP_TOOL_RECENT=4`、`DEFAULT_SUMMARY_BUDGET_TOKENS=4000`
- **依赖**：`LLMClient` / `LLMError`
- **设计**：与 Checkpoint/Rebuild 互补——Compaction 是简单摘要压缩（远处信息会有损失），Checkpoint/Rebuild 是结构化持久化

### `mcp_manager.py`：MCP 客户端管理器（Task 2）

管理 MCP（Model Context Protocol）服务器全生命周期，并将工具注册到主 Agent 命名空间。

- **关键类**：`McpClientWrapper` 类、`McpManager` 类、`mcp_manager` 模块级单例
- **关键常量**：`START_TIMEOUT_SECONDS=10.0`、`CALL_TIMEOUT_SECONDS=30.0`
- **依赖**：`tool_registry`（`MCP_PREFIX`）；mcp SDK（**可选导入**，KWA pyproject.toml 未声明 mcp 依赖，用 try/except 包裹）
- **设计**：stdio 传输 + `AsyncExitStack` 长效 session；命名空间 `mcp.{server}.{tool}`；MCP inputSchema → OpenAI function parameters 直接复用

### `tool_registry.py`：Function Calling 工具注册表（Task 2）

定义工具 schema（OpenAI function calling 格式）与统一执行框架。

- **关键类**：`ToolEntry`（dataclass）、`ToolRegistry` 类、`ToolHandler` 类型、`register_default_tools()`、`MCP_PREFIX="mcp."`
- **工具类别**：本地工具（`file_read` / `file_write` / `file_list` / `command_exec` / `open_app` / `open_url` / `system_notification` / `screenshot` / `clipboard_read` / `clipboard_write` / `append_note` / `task_*`）、知识库检索（`knowledge_search`）、图谱工具（Task 7）、MCP 工具
- **设计**：plan/build 模式白名单过滤；`ToolRegistry.execute` 接受可选 `mode` 参数并注入 `args["_mode"]`；全局 `tool_registry` 单例不再自动 `register_default_tools`

## 子包导航

| 子包 | 路径 | 说明 |
|------|------|------|
| `tools/` | [tools/DEVELOPMENT.md](./tools/DEVELOPMENT.md) | 工具 handler 子包：file_tools / system_tools / task_tools / graph_tools |
| `multimodal/` | ./multimodal/ | 多模态子包：image_handler（图片转 base64 data URL）；当前仅 1 文件，未独立 DEVELOPMENT.md |
| `prompts/` | ./prompts/ | 系统提示词子包：main_agent_system.md + writer_system.md + `__init__.py`（加载函数）；当前仅 2 md + 1 py，未独立 DEVELOPMENT.md |

## 开发工作流

### 新增一个 service 方法

1. 在对应 service 文件（如 [graph_store.py](./graph_store.py)）加 `async def xxx(self, ...) -> dict`：
   ```python
   async def get_related_nodes(self, graph_id: str, node_id: str, depth: int = 1) -> list[dict[str, Any]]:
       async with AsyncSessionLocal() as session:
           # 查询逻辑
           ...
           return [n.to_dict() for n in nodes]
   ```
2. 在 [routers/](../routers/) 加对应端点调用此方法。
3. 在 [../../../frontend/src/lib/api.ts](../../../frontend/src/lib/api.ts) 加前端方法。
4. 在 [../../../frontend/src/lib/types.ts](../../../frontend/src/lib/types.ts) 加对应类型。

### 新增一个 LLM 调用场景

1. 在 [graph_agent.py](./graph_agent.py) 加 `async def xxx(self, ...) -> dict`：
   ```python
   async def score_node_importance(self, graph_id: str, node_id: str) -> dict:
       client = await self._get_llm_client()
       if client is None:
           return {"score": 0.5, "reason": "LLM 不可用，返回默认分", "degraded": True}
       node = await graph_store.get_node(graph_id, node_id)
       neighbors = await graph_store.get_neighbors(graph_id, node_id)
       prompt = self._build_importance_prompt(node, neighbors)
       try:
           result = await self._call_llm_json(client, prompt)
           return {"score": float(result.get("score", 0.5)), "reason": result.get("reason", ""), "degraded": False}
       except Exception as exc:
           logger.warning("节点重要性评分失败: %s", exc)
           return {"score": 0.5, "reason": "LLM 调用失败", "degraded": True}
   ```
2. 在 [routers/](../routers/) 加 `POST /api/graphs/{id}/nodes/{nid}/score` 路由。
3. 在 [main.py](../main.py) 注册新 router（若新建文件）。
4. 前端加 api 方法、UI 入口。

**验证**：触发评分接口 → 返回 score 与 reason → degraded 字段在 LLM 不可用时为 True。

### 新增一个流式 LLM 方法

参考 [routers/DEVELOPMENT.md](../routers/DEVELOPMENT.md) 的"任务 2"。

### 调整 LLM 兜底模型清单

1. 找到 `backend/data/model_config.json`（若不存在，看 [model_config.py](./model_config.py) 的 `_FALLBACK_DEFAULT` 兜底硬编码）。
2. 加新条目：
   ```json
   {
     "models": {
       "newprovider": {
         "context_window": 128000,
         "max_output_tokens": 4096,
         "default_temperature": 0.7,
         "supports_tools": true,
         "supports_streaming": true,
         "vendor": "openai",
         "description": "新厂商"
       }
     }
   }
   ```
3. 重启后端，`_REGISTRY.load()` 会重新加载。
4. 在前端 SettingsPanel 的 LLM 配置区可看到新选项。
5. **同步更新 collector 侧**的 [../../../web-ai-chat-collector/models.json](../../../web-ai-chat-collector/models.json)，确保两端一致。

**验证**：在前端 SettingsPanel 选择新厂商 → 填 API Key → 测试连通性返回成功 → 触发一次节点详情生成确认流式正常。

## 代码约定

### 异步栈

- 所有 service 方法 `async def`，DB 操作走 `AsyncSessionLocal`（`async with AsyncSessionLocal() as session: ...`）。
- `graph_store` 自管理 session（每个方法内 `async with AsyncSessionLocal()`），便于跨请求复用单例。
- 路由通过 `Depends(get_xxx_store)` 拿全局单例；service 不持有 HTTP 请求上下文。

### LLM 调用必须经 `llm_factory`

- LLM 调用必须经 `llm_factory.get_llm_client(session)` 获取客户端（凭据从 settings 表读取，加密存储），**不要直接 `import openai`**。
- `LLMClient` 本身无状态，按调用构造可保证配置实时生效且避免持有过期凭据。
- LLM 调用失败由 `graph_agent` 统一降级（返回空列表 / 兜底文本 + `degraded: True`），不向上抛异常。

### 模块级单例

需要持有全局状态的 service 用模块级单例（`graph_store = GraphStore()` / `llm_request_registry = LLMRequestRegistry()` / `_REGISTRY = ModelConfigRegistry()`），便于 router 通过 `Depends(get_xxx_store)` 注入。**不要**在 service 类的 `__init__` 中做 IO 操作（如读文件 / 连 DB），改在 `load()` / `init_xxx()` 方法中由 `lifespan` 调用。

### 错误处理

- service 层抛 `ValueError` 表示业务校验失败（消息含"不存在" / "非法" / 其他），router 层用 `_handle_value_error` 映射为 HTTP 404 / 422 / 400。
- LLM 调用失败由 `graph_agent` 统一降级，**不向上抛** `LLMError`；调用方通过返回值中的 `degraded` / `error` 字段判断是否走降级路径。
- DB 操作失败（如 `IntegrityError`）由 service 层捕获并转抛 `ValueError`（消息含"不存在" / "非法"），避免暴露 ORM 异常给路由层。

### 命名

- **模块文件**：全小写下划线（`graph_store.py` / `llm_client.py` / `node_types.py`）。
- **类**：PascalCase（`GraphStore` / `LLMClient` / `GraphAgent` / `LLMRequestRegistry` / `ModelConfigRegistry`）。
- **函数 / 方法**：snake_case（`extract_candidates` / `mark_observation_processed` / `get_llm_client`）；私有方法下划线前缀（`_call_llm_json` / `_build_context` / `_get_llm_client`）。
- **常量**：全大写下划线（`_MAX_EXTENSIONS_ALL` / `_IMPORTANT_POINTS_MIN` / `ENCRYPTED_KEYS` / `_FALLBACK_DEFAULT`）。

### 导入

`from __future__ import annotations` 在文件首行（在 docstring 之后）。导入顺序：标准库 → 第三方 → 本项目（`from app.xxx import yyy`）。

## 常见任务

### 任务 1：新增一个图谱 AI 能力

参考"开发工作流 → 新增一个 LLM 调用场景"。

### 任务 2：扩展插件推送的去重维度

**场景**：当前用 `{platform}:{conversation_id}` 24h 去重，希望支持自定义 `dedup_key` 字段。

**步骤**：
1. 在 [graph_store.py](./graph_store.py) 加 `find_observation_by_custom_dedup(dedup_key, within_hours)` 方法。
2. 在 [routers/plugin.py](../routers/plugin.py) 的 `POST /api/plugin/conversations` 实现中，若 `metadata.dedup_key` 存在则用它，否则用默认 `{platform}:{conversation_id}`。
3. 同步更新 [../../../web-ai-chat-collector/bg/local-app.js](../../../web-ai-chat-collector/bg/local-app.js) 中 metadata 字段的构造逻辑。

**验证**：推送两条带相同 `dedup_key` 的对话 → 第二次返回 `deduplicated: true`。

### 任务 3：调试 LLM 调用失败

**场景**：触发节点详情生成时返回 `degraded: true`。

**步骤**：
1. 看 `uvicorn` 控制台 `[graph_agent]` 前缀日志，找 `LLM 调用失败` 或 `凭据缺失` 警告。
2. 检查前端 SettingsPanel 的 LLM 配置：`base_url` / `api_key` / `model` 是否完整。
3. 用 `curl -X POST <base_url>/chat/completions -H "Authorization: Bearer <api_key>" -d '{"model":"<model>","messages":[{"role":"user","content":"hi"}]}'` 直接测 LLM 接口连通性。
4. 检查 `backend/data/.encryption_key` 是否存在（凭据加密 key，丢失则无法解密历史 `llm.api_key`）。
5. 若 LLM 接口返回 429，等几分钟再试（限流）；若返回 401 / 403，凭据错误；若返回 5xx，厂商服务异常。

**验证**：`graph_agent.generate_node_detail` 返回 `degraded: false`，`detail_payload._important_points` 含 LLM 生成内容。

### 任务 4：调整 graph_agent 的 prompt

**场景**：节点详情生成的"重要点"数量不理想，想从 3-6 调到 4-8。

**步骤**：
1. 在 [graph_agent.py](./graph_agent.py) 把 `_IMPORTANT_POINTS_MIN = 3` / `_IMPORTANT_POINTS_MAX = 6` 改为 `4` / `8`。
2. 找到对应 prompt 构造方法（如 `_build_detail_prompt`），把"请生成 3-6 个重要点"改为"请生成 4-8 个重要点"。
3. 触发节点详情生成（前端悬停节点 → 详情卡），观察 LLM 输出。

**验证**：`detail_payload._important_points` 列表长度在 4-8 之间。

## 扩展点

### 新增 service 模块

- 在 `services/` 加新文件，遵循既有风格：顶部 docstring → `from __future__ import annotations` → 类型注解 → `logger = logging.getLogger(__name__)` → 业务函数。
- 需要全局状态的 service 用模块级单例（`xxx_store = XxxStore()`），便于 router 通过 `Depends(get_xxx_store)` 注入。
- LLM 调用必须经 `llm_factory.get_llm_client()` 获取客户端，不要直接 `import openai`。
- service 层方法均 `async def`，DB 操作走 `AsyncSessionLocal`。

### 新增 LLM Provider

参考"开发工作流 → 调整 LLM 兜底模型清单"。

### 新增流式 LLM 方法

参考 [routers/DEVELOPMENT.md](../routers/DEVELOPMENT.md) 的"任务 2"。

## 注意事项（坑）

### LLM 凭据的两种来源

- **开发期**：`backend/.env` 的 `LLM_API_KEY`（明文，仅 dev 用），由 [config.py](../config.py) 的 `Settings.llm_api_key` 读取。
- **生产 / 用户配置**：前端 SettingsPanel 保存到后端 `settings` 表（`llm.api_key` 加密为 Fernet 密文存储），由 [llm_factory.py](./llm_factory.py) 的 `get_llm_client()` 解密读取。
- `llm_factory.get_llm_client()` 优先用 settings 表的配置（若存在），否则回退到 `.env`。
- `APP_ENCRYPTION_KEY` 留空时由 [crypto.py](./crypto.py) 自动生成并落盘到 `data/.encryption_key`，**该文件丢失则历史加密字段无法解密**，需重新配置 LLM 凭据。

### 流式 LLM 任务的双通道

- 流式端点（`/api/graphs/{id}/nodes/{nid}/detail-stream` 等）的 HTTP 响应**只**返回 `StreamStartedResponse { request_id }`，立即结束。
- 实际 token 流通过 **WebSocket** 推送（按 `session_id` 路由），前端通过 `streamingSessionId` 绑定连接。
- 前端若未连 WebSocket（`sessionId` 为 null），store 内会自动回退到非流式接口（`/api/graphs/{id}/nodes/{nid}/detail` 等同步接口）。
- 取消流式任务：`POST /api/llm/requests/{request_id}/cancel`，后端 `llm_request_registry` 持有 `asyncio.Task` 引用，取消时 `task.cancel()`。

### LLM 调用失败的降级

`graph_agent` 所有方法在 LLM 不可用时返回降级结果（含 `degraded: True` 字段），**不向上抛** `LLMError`。调用方（router / 前端）通过返回值中的 `degraded` 字段判断是否走降级路径。**不要**在 router 层 try/except 捕获 `LLMError`，应直接信任 service 层的降级返回。

### `graph_store` 返回 dict 而非 ORM 实例

`graph_store` 所有查询方法返回 `dict[str, Any]` 而非 ORM 实例，避免懒加载在 session 关闭后触发 `DetachedInstanceError`。**不要**在 service 层返回 ORM 实例给 router，所有序列化在 service 层完成。

### `ws_notify` 的并发安全

`ws_notify` 用 `asyncio.Lock` 保护内部 `dict`，但 `send_json` 涉及 IO，持锁时间应尽量短（仅复制连接列表后释放锁再推送）。**不要**在持锁时调 `await ws.send_json(...)`，会导致其他 `register` / `unregister` 阻塞。

### `main_agent` 已就位

`main_agent` 已完整移植（Task 5）并接入 `routers/chat.py`；依赖 `context_manager` / `mcp_manager` / `tool_registry` / `multimodal.image_handler` / `tools.task_tools` 均已就位。`services/__init__.py` 不聚合导出 `MainAgent`，调用方按需显式 import 单个模块（如 `from app.services.main_agent import get_main_agent`）。MCP 包为可选依赖（未在 `pyproject.toml` 声明 `mcp`），缺失时 `mcp_manager` 以降级模式运行。

## 下一步该读什么

| 你的角色 / 目标 | 下一步文档 |
|----------------|-----------|
| 要改 ORM 模型 / Pydantic schema / 节点类型枚举 | [../models/DEVELOPMENT.md](../models/DEVELOPMENT.md) |
| 要改路由 / 新增 API 端点 | [../routers/DEVELOPMENT.md](../routers/DEVELOPMENT.md) |
| 要看应用入口 / 配置 / DB 初始化 | [../DEVELOPMENT.md](../DEVELOPMENT.md) |
| 要改前端 React 组件 / 图谱可视化 | [../../../frontend/DEVELOPMENT.md](../../../frontend/DEVELOPMENT.md) |
| 要做插件推送对接 | [../../../web-ai-chat-collector/bg/DEVELOPMENT.md](../../../web-ai-chat-collector/bg/DEVELOPMENT.md)（`bg/local-app.js` 段落） |
| 要看后端整体架构 | [../../DEVELOPMENT.md](../../DEVELOPMENT.md) |
