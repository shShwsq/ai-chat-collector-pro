# services/ 服务层开发指南

> 一句话定位：本目录是 KWA 后端的业务服务层，16 个模块按职责拆分：图谱 CRUD（`graph_store`）、图谱 AI Agent（`graph_agent`）、LLM 调用栈（`llm_client` / `llm_factory` / `llm_errors` / `llm_request_registry` / `model_config`）、配置与加密（`settings_store` / `crypto`）、WebSocket 通知（`ws_notify`）、会话队列（`session_queue`）、知识 / 标签 / 文件（`knowledge_store` / `tag_store` / `file_storage`）、子 Agent（`sub_agent`）。本层方法均 `async def`，DB 操作走 `AsyncSessionLocal`；LLM 调用必须经 `llm_factory.get_llm_client()` 获取客户端，不直接 `import openai`。

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
├── model_config.py            # 模型配置注册表：从 model_config.json 加载并缓存
├── settings_store.py          # settings 表读写助手（普通字段 JSON 序列化，敏感字段加密）
├── crypto.py                  # Fernet 对称加密（敏感字段加密存储）
├── ws_notify.py               # WebSocket 连接注册表（按 session_id 索引，broadcast / notify_session）
├── session_queue.py           # 会话队列（任务排队执行）
├── knowledge_store.py         # 知识存储与 FTS5 全文检索
├── tag_store.py               # 标签库 CRUD（去重 / 同义词归一）
├── file_storage.py            # 文件落盘与元数据管理
└── sub_agent.py               # 子 Agent 编排（任务分发 / 工具调用）
```

## 关键文件

### `graph_store.py`：图谱 CRUD

提供 `Graph` / `Node` / `Edge` / `Observation` / `Quiz` 的 CRUD 接口，作为路由层与 Agent 之间的中间层。模块级单例 `graph_store = GraphStore()`，路由通过 `Depends(get_graph_store)` 注入。

**设计要点**：
1. **返回 dict 而非 ORM 实例**：避免懒加载在 session 关闭后触发 `DetachedInstanceError`，所有查询结果在 session 内显式序列化为 `dict[str, Any]`。
2. **JSON 字段透明序列化**：`detail_payload` / `user_fill` / `metadata_json` / `payload` / `result` 在 DB 中以 TEXT 存储，本层在读取时反序列化为 dict，写入时序列化为 JSON 字符串，调用方无需关心。
3. **节点类型校验**：`create_node` / `update_node` 校验 `node_type` 在对应图谱模式的合法枚举内（见 [../models/node_types.py](../models/node_types.py)），非法类型抛 `ValueError`。
4. **图谱隔离**：所有节点 / 边 / 测验操作均通过 `graph_id` 关联到图谱，删除图谱时级联清理（`ondelete=CASCADE`）。
5. **观察来源**：`create_observation` 支持 `plugin` / `import` / `manual` 三种来源；`mark_observation_processed` 标记已被 Agent 处理，避免重复抽取。
6. **幂等去重**：`find_observation_by_dedup_key(platform, dedup_key, within_hours)` 用于插件推送去重（24h 内同 `conversation_id` 不重复落库）。

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

主要方法（部分）：
- 节点详情：`generate_node_detail` / `generate_node_detail_stream`
- 节点延伸：`extend_node`（mode='all' / 'single'） / `revoke_extension`
- 候选抽取：`extract_candidates_from_observation`（Study） / `extract_work_objects_from_observation`（Work）
- 测验：`generate_quiz` / `grade_quiz_answer`
- Work 业务：`get_trends` / `generate_report` / `generate_report_stream` / `answer_question` / `answer_question_stream`
- 内部工具：`_get_llm_client` / `_call_llm_json` / `_build_context` / `_stream_llm`

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

按 `session_id` 索引的连接注册表：
- `register(session_id, ws)`：注册连接。
- `unregister(session_id, ws)`：注销连接（幂等，空集合自动从 dict 移除）。
- `notify_session(session_id, event) -> int`：向指定会话的所有连接推送事件，返回成功推送的连接数（0 表示无活跃连接）。推送失败的连接被静默忽略。
- `broadcast(event) -> int`：向所有连接推送事件，返回成功推送的连接数。

**并发安全**：`asyncio.Lock` 保护内部 `dict`，避免 `register` / `unregister` 在事件循环中交错。`send_json` 涉及 IO，持锁时间应尽量短（仅复制连接列表后释放锁再推送）。

### `session_queue.py`：会话队列

任务排队执行，避免同一会话并发执行多个 LLM 任务导致上下文混乱。供 `graph_agent` 使用。

### `knowledge_store.py`：知识存储与 FTS5 全文检索

基于 `messages_fts` / `checkpoints_fts` / `file_metadata_fts` / `observations_fts` 虚拟表提供全文检索。FTS5 不可用时静默降级（返回空列表）。

### `tag_store.py`：标签库 CRUD

标签库（`tags` 表）的去重 / 同义词归一 / 文件关联。FTS5 不可用时不影响核心 CRUD。

### `file_storage.py`：文件落盘与元数据管理

文件上传到 `data/files/`，元数据存 `file_metadata` 表。支持 PDF / Word / PPT / 图片等格式（依赖 `pypdf` / `python-docx` / `python-pptx` / `Pillow`）。

### `sub_agent.py`：子 Agent 编排

任务分发 / 工具调用编排。**注意**：`main_agent`（依赖 `context_manager` / `mcp_manager` / `tool_registry` / `multimodal.image_handler` / `tools.task_tools` 等未移植模块）当前**未接入路由**且不能被直接 import；待后续移植这些依赖后补齐。

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

### `main_agent` 未就位

`main_agent` 依赖 `context_manager` / `mcp_manager` / `tool_registry` / `multimodal.image_handler` / `tools.task_tools` 等未移植模块，当前**未接入路由**且不能被直接 import。`services/__init__.py` 不再聚合导出 MainAgent，调用方按需显式 import 单个模块。待后续移植这些依赖后补齐。

## 下一步该读什么

| 你的角色 / 目标 | 下一步文档 |
|----------------|-----------|
| 要改 ORM 模型 / Pydantic schema / 节点类型枚举 | [../models/DEVELOPMENT.md](../models/DEVELOPMENT.md) |
| 要改路由 / 新增 API 端点 | [../routers/DEVELOPMENT.md](../routers/DEVELOPMENT.md) |
| 要看应用入口 / 配置 / DB 初始化 | [../DEVELOPMENT.md](../DEVELOPMENT.md) |
| 要改前端 React 组件 / 图谱可视化 | [../../../frontend/DEVELOPMENT.md](../../../frontend/DEVELOPMENT.md) |
| 要做插件推送对接 | [../../../web-ai-chat-collector/bg/DEVELOPMENT.md](../../../web-ai-chat-collector/bg/DEVELOPMENT.md)（`bg/local-app.js` 段落） |
| 要看后端整体架构 | [../../DEVELOPMENT.md](../../DEVELOPMENT.md) |
