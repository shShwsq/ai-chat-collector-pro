# routers/ 路由层开发指南

> 一句话定位：本目录是 KWA 后端的 FastAPI 路由层，14 个 router 模块按业务域拆分，挂载在 `/api` 前缀下（`plugin.py` 自带 `/plugin` 子前缀，`ws.py` 挂在根路径 `/ws`）。本层只做参数校验与 HTTP 适配，业务逻辑下沉到 `services/`；统一用 `_handle_value_error` 把 service 抛的 `ValueError` 映射为 HTTP 异常（404 / 422 / 400）。

## 与 web-ai-chat-collector 的关系（软件 + 插件一体化）

本目录是后端路由层，与插件侧 [web-ai-chat-collector](../../../web-ai-chat-collector/DEVELOPMENT.md) 的对接关系如下：

- **`plugin.py` 是对接核心**：14 个 router 中只有 `plugin.py` 直接处理 collector 推送，提供 4 个端点：
  - `POST /api/plugin/conversations`：接收 collector 通过 [plugin-sdk/kwa-push.js](../../../knowledge-work-assistant/plugin-sdk/kwa-push.js) 推送的对话
  - `GET /api/plugin/contract`：返回接口契约（供 collector 二次开发参考）
  - `GET /api/plugin/conversations/recent`：返回最近推送的对话（供前端 PluginIntegrationSection 展示）
  - `GET /api/plugin/health`：联调自检端点
- **平台白名单**：`plugin.py` 的 `SUPPORTED_PLATFORMS` 与 collector 的 5 平台 ID 取交集；非法平台返回 422。
- **幂等去重**：`metadata.conversation_id` 存在时，组合 `{platform}:{conversation_id}` 作为 `dedup_key`，24h 内不重复落库；collector 推送时建议带此字段。
- **WebSocket 广播**：`plugin.py` 成功落库后调 `ws_notify.broadcast` 推 `plugin.conversation_received` 事件，前端收到后弹 Toast 并刷新"待抽取"侧栏。
- **`extraction.py` 消费推送数据**：`GET /api/observations?processed=false` 列出 collector 推送的未处理对话，供前端"待抽取"侧栏展示；`POST /api/graphs/{id}/nodes/batch` 将抽取的候选节点批量入图。
- **当前不自动抽取**：`plugin.py` 落库后**不触发** `graph_agent` 抽取；抽取由用户在前端主动触发（调 `extraction.py` 的端点）。

跨子工程任务（启用推送、调整对话格式、并行开发联调等）请参考工作区根 [DEVELOPMENT.md](../../../DEVELOPMENT.md) 的"常见跨子工程任务"章节。

## 模块职责

```
routers/
├── __init__.py             # 仅一行 docstring，不聚合导出
├── health.py               # GET /api/health
├── graphs.py               # 图谱 CRUD + 节点 / 边管理（Task 4）
├── nodes.py                # 节点详情生成 / 留白追加 / 复习 / 提醒 / 星标（Task 7 / 9）
├── extensions.py           # 节点延伸与撤销（Task 8）
├── extraction.py           # Study 对话抽取与批量入图（Task 11）
├── quiz.py                 # Study 测验生成 / 作答 / 历史（Task 12）
├── work.py                 # Work 模式业务：抽取入图 / 风口 / 报告 / 提问（Task 13-16）
├── recommendations.py      # 智能推荐（Task 5）
├── plugin.py               # 浏览器插件对接（Task 10）
├── llm_admin.py            # LLM 请求队列与配置管理
├── stream.py               # 流式触发路由（详情卡 / 问答 / 报告）
├── chat.py                 # 多轮对话 chat 路由（Task 8）：会话 CRUD + 流式对话 + 工具确认 + checkpoint
└── ws.py                   # WebSocket 端点 /ws
```

14 个 router 都通过 `main.py` 的 `app.include_router(xxx.router, prefix="/api", tags=["xxx"])` 挂载（`ws.py` 例外，挂根路径 `/ws`）。每个 router 通过 `Depends(get_xxx_store)` 拿全局单例，便于测试时用 `app.dependency_overrides` 替换。

## 关键文件

### `health.py`

- `GET /api/health` → `{"status":"ok","service":"knowledge-work-assistant-backend","version":"0.0.0"}`
- 前端 `App.tsx` 每 5s 轮询此端点更新 header 健康徽章。

### `graphs.py`（Task 4 图谱管理）

提供图谱及节点 / 边的 CRUD：

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/graphs` | 创建图谱（body: `{name, type}`） |
| GET | `/api/graphs?mode=study\|work` | 按模式列出图谱 |
| GET | `/api/graphs/{graph_id}` | 获取单个图谱 |
| GET | `/api/graphs/{graph_id}/full` | 获取完整图谱（含 nodes/edges/stats） |
| PATCH | `/api/graphs/{graph_id}` | 重命名图谱 |
| DELETE | `/api/graphs/{graph_id}` | 删除图谱（级联清理） |
| GET | `/api/graphs/{graph_id}/stats` | 图谱统计 |
| POST | `/api/graphs/{graph_id}/nodes` | 创建节点 |
| GET | `/api/graphs/{graph_id}/nodes` | 列出节点（可按 type 过滤） |
| PATCH | `/api/graphs/{graph_id}/nodes/{node_id}` | 更新节点 |
| DELETE | `/api/graphs/{graph_id}/nodes/{node_id}` | 删除节点 |
| POST | `/api/graphs/{graph_id}/edges` | 创建边 |
| GET | `/api/graphs/{graph_id}/edges` | 列出边 |
| DELETE | `/api/graphs/{graph_id}/edges/{edge_id}` | 删除边 |

**设计要点**：依赖注入 `graph_store`；study/work 隔离（`list_graphs` 按 `mode` 查询参数过滤）；统一用 `_handle_value_error` 映射 ValueError → 404/422/400。

### `nodes.py`（Task 7 / 9 节点详情与留白）

- `POST /api/graphs/{graph_id}/nodes/{node_id}/detail`：生成（或复用缓存）节点详情卡内容。
- `POST /api/graphs/{graph_id}/nodes/{node_id}/user-fill`：向 `user_fill` 追加一条内容。
- `POST /api/nodes/{node_id}/touch`：复习追踪（`last_reviewed_at` 置当前时间，`review_count+1`）。
- `POST /api/nodes/{node_id}/remind`：设置提醒时间。
- `DELETE /api/nodes/{node_id}/remind`：清除提醒时间。
- `POST /api/nodes/{node_id}/star` / `DELETE /api/nodes/{node_id}/star`：星标 / 取消星标。

**设计要点**：`detail_payload` 缓存策略（生成结果以 `_important_points` 等下划线前缀键写入，再次调用时若已含则直接返回缓存，不重复调 LLM）；降级透明传递（`graph_agent.generate_node_detail` 在 LLM 不可用时返回 `degraded=True` 兜底结构，本层原样透传）；类型推断回写（LLM 推断了更具体的合法类型时一并更新 `node.type`）。

### `extensions.py`（Task 8 节点延伸）

- `POST /api/graphs/{graph_id}/nodes/{node_id}/extend`：延伸节点（body: `{mode: 'all'|'single', direction_name?: string}`）。
  - `mode='all'`：双击节点触发，一次生成 6-8 个方向的灰色延伸节点 + extends 边，命中已存在节点不重复创建；批次 ID 存 `extension_batch_id`，可通过 `extend-revoke` 撤销。
  - `mode='single'`：单击延伸方向触发，仅生成一个延伸节点，不进 batch（不可撤销）。
- `POST /api/graphs/{graph_id}/nodes/{node_id}/extend-revoke`：撤销最近一次 `mode='all'` 延伸批次（删 batch 内的灰色节点 + extends 边）。

### `extraction.py`（Task 11 Study 对话抽取）

- `GET /api/observations?processed=false&limit=20`：列出观察记录（可按 `processed` 过滤）。
- `POST /api/graphs/{graph_id}/nodes/extract`：从指定 observation 抽取候选节点（调 `graph_agent.extract_candidates_from_observation`）。
- `POST /api/graphs/{graph_id}/nodes/batch`：批量创建节点 + 边（用户确认候选节点后调用）。

### `quiz.py`（Task 12 Study 测验）

- `POST /api/graphs/{graph_id}/quiz/generate`：生成测验题（body: `{type, node_ids?, count?}`）。
- `POST /api/graphs/{graph_id}/quiz/{quiz_id}/answer`：作答并判分。
- `GET /api/graphs/{graph_id}/quiz`：列出测验历史。
- `GET /api/graphs/{graph_id}/quiz/{quiz_id}`：获取单个测验详情（用于复盘）。

### `work.py`（Task 13-16 Work 模式业务）

- `POST /api/graphs/{graph_id}/work/extract`：从 observation 抽取工作对象候选（Task 13）。
- `POST /api/graphs/{graph_id}/work/confirm`：用户确认候选后批量入图（Task 14）。
- `GET /api/graphs/{graph_id}/work/trends`：获取风口推荐列表（Task 15）。
- `POST /api/graphs/{graph_id}/work/trends`：手动添加风口。
- `POST /api/graphs/{graph_id}/work/report`：生成工作报告（body: `{period: 'daily'|'weekly'|'monthly'}`，非流式）。
- `POST /api/graphs/{graph_id}/work/ask`：用户提问（非流式）。

### `recommendations.py`（Task 5 智能推荐）

- `GET /api/graphs/{graph_id}/recommendations?mode=study|work&limit=20`：按模式计算推荐分并排序返回节点列表。
- 推荐分因子：`mention_count` / `last_reviewed_at` / `remind_at` / `is_starred` / `confidence`。

### `plugin.py`（Task 10 浏览器插件对接）

- `POST /api/plugin/conversations`：接收插件推送的对话，持久化为 `Observation`（`source='plugin'`）。
- `GET /api/plugin/contract`：返回接口契约说明（供插件方对接参考）。
- `GET /api/plugin/conversations/recent?limit=10`：返回最近 N 条 `source='plugin'` 的记录。
- `GET /api/plugin/health`：联调自检端点（版本 / 平台 / 队列规模）。

**设计要点**：
1. **平台白名单**：`platform` 必须命中 `SUPPORTED_PLATFORMS = frozenset({'chatgpt','claude','gemini','deepseek','qwen','doubao','kimi','fudan','custom'})`，否则 400。
2. **metadata 类型校验**：`metadata` 中 `title / url / model` 若提供必须为 string，否则 422（Pydantic 的 `dict[str, Any]` 不约束值类型，需在路由层手动校验）。
3. **幂等去重**：若 `metadata.conversation_id` 存在，组合 `{platform}:{conversation_id}` 作为 `dedup_key`，查最近 24h 是否已落库；命中则返回 `deduplicated: true`，不写新记录、不广播。
4. **WebSocket 广播**：成功落库后通过 `ws_notify.broadcast` 向所有前端连接推送 `plugin.conversation_received` 事件，供前端 Toast / 刷新列表。
5. **当前阶段不触发节点抽取**：抽取逻辑由 `graph_agent` 在用户主动触发时实现。

### `llm_admin.py`（LLM 请求队列与配置管理）

- `GET /api/llm/requests`：当前活跃的 LLM 请求列表（前端 SettingsPanel 显示）。
- `GET /api/llm/requests/all`：所有请求（含已完成 / 失败）。
- `POST /api/llm/requests/{request_id}/cancel`：取消指定请求。
- `POST /api/llm/requests/cleanup`：清理已完成的请求记录。
- `GET /api/llm/config`：读取当前 LLM 配置（`base_url` / `model` / `context_window` 等，`api_key` 不返回）。
- `PUT /api/llm/config`：更新 LLM 配置（`api_key` 经 `settings_store.set_secret` 加密存入 `settings` 表）。

### `stream.py`（流式触发路由）

- `POST /api/graphs/{graph_id}/nodes/{node_id}/detail-stream`：触发节点详情卡流式生成。
- `POST /api/graphs/{graph_id}/work/ask-stream`：触发 Work 模式问答流式生成。
- `POST /api/graphs/{graph_id}/work/report-stream`：触发工作报告流式生成。

**双通道协议**：HTTP 响应**只**返回 `StreamStartedResponse { request_id }`，立即结束；实际 token 流通过 **WebSocket** 推送（按 `session_id` 路由），前端通过 `streamingSessionId` 绑定连接。后端 `asyncio.create_task` 跑 `graph_agent.xxx_stream`，每个 token 通过 `ws_notify.notify_session(session_id, {"type": "graph_agent_token", "op": "...", "delta": token, ...})` 推送。`chat.py` 的流式端点沿用同协议，但 `op` 固定为 `"chat"`，并新增 3 个 chat 事件类型（`chat_tool_call` / `chat_tool_result` / `chat_tool_call_confirmation`）用于工具调用前后端协作。

### `chat.py`（Task 8 多轮对话 chat 路由）

提供 8 个端点：

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/chat/sessions` | 创建会话（body: `{mode: 'study'|'work', graph_id?}`） |
| GET | `/api/chat/sessions` | 列出当前会话（按 mode / graph_id 过滤） |
| GET | `/api/chat/sessions/{session_id}/messages` | 获取会话历史消息 |
| POST | `/api/chat/sessions/{session_id}/stream` | 触发流式对话（HTTP 立即返回 `request_id`，token 走 WS） |
| POST | `/api/chat/sessions/{session_id}/checkpoint` | 触发 Agent 循环 checkpoint |
| GET | `/api/chat/sessions/{session_id}/checkpoint` | 获取最近 checkpoint 内容 |
| POST | `/api/chat/requests/{request_id}/cancel` | 取消进行中的对话流式任务 |
| POST | `/api/chat/requests/{request_id}/confirm` | 确认高风险工具调用（继续执行） |

**设计要点**：
1. **会话级 MainAgent 缓存**：模块内维护 `_session_agents: dict[session_id, MainAgent]`，同一会话复用 agent 实例以保留历史与上下文，会话销毁时清理。
2. **双通道流式**：`POST /api/chat/sessions/{id}/stream` 立即返回 `StreamStartedResponse { request_id }`，实际 token 通过 WebSocket 推送（`op="chat"`），与 `stream.py` 一致；后台 `asyncio.create_task` 跑 `main_agent.run_stream`。
3. **新增 chat 事件类型**：在 WS `op="chat"` 通道上新增 3 个事件类型：
   - `chat_tool_call`：Agent 决定调用工具时推送，携带工具名 / 参数 / call_id。
   - `chat_tool_result`：工具执行完成时推送，携带返回值。
   - `chat_tool_call_confirmation`：高风险工具需用户确认时推送，前端展示"确认 / 取消"按钮。
4. **取消机制**：`POST /api/chat/requests/{id}/cancel` 通过 `llm_request_registry` 持有的 `asyncio.Task` 引用调 `task.cancel()`，终止流式任务。
5. **高风险工具需确认**：工具声明 `require_confirmation=True` 时，Agent 暂停执行，推送 `chat_tool_call_confirmation` 事件等待用户确认；前端调 `POST /api/chat/requests/{id}/confirm` 续跑，或超时自动取消。

### `ws.py`（WebSocket 端点）

- `WS /ws?session_id=<uuid32>`：建立连接后推送 `welcome` 事件；客户端发 `{"type":"ping"}` 回 `pong`，发其他 JSON 回 `echo`。
- **session_id 注册**：连接时附带 `?session_id=xxx` 查询参数，注册到 `ws_notify`，使后台流式任务能通过 `notify_session` 精确推送。未提供时注册到 `"default"` 会话，仅接收 `broadcast` 全局广播。
- 连接断开时从 `ws_notify` 注销，避免向已关闭连接推送。

## 开发工作流

### 新增一个 API 端点

1. 在对应的 router 文件（如 [graphs.py](./graphs.py)）加路由函数：
   ```python
   @router.get(
       "/graphs/{graph_id}/nodes/{node_id}/related",
       response_model=list[NodeResponse],
   )
   async def get_related_nodes(
       graph_id: str,
       node_id: str,
       depth: int = Query(1, ge=1, le=3),
       store: GraphStore = Depends(get_graph_store),
   ):
       try:
           return await store.get_related_nodes(graph_id, node_id, depth)
       except ValueError as exc:
           raise _handle_value_error(exc) from exc
   ```
2. 在 [../services/graph_store.py](../services/graph_store.py) 加对应方法（`async def get_related_nodes(...)`）。
3. 在 [../models/schemas.py](../models/schemas.py) 检查 `NodeResponse` 是否够用；如需额外字段，新建 `RelatedNodeResponse(NodeResponse)` 子类。
4. 在 [../../../frontend/src/lib/api.ts](../../../frontend/src/lib/api.ts) 加 `getRelatedNodes(graphId, nodeId, depth?)` 方法。
5. 在 [../../../frontend/src/lib/types.ts](../../../frontend/src/lib/types.ts) 加对应类型。
6. 在前端组件中调用并渲染。

**验证**：Swagger UI 访问新端点返回预期结果；前端组件显示正确。

### 新增一个 router 模块

1. 在 `routers/` 加新文件，如 `feature_x.py`，导出 `router = APIRouter()`（如需子前缀，加 `prefix="/feature-x"`）。
2. 在 [../main.py](../main.py) 加 `from app.routers import feature_x as feature_x_router` + `app.include_router(feature_x_router.router, prefix="/api", tags=["feature-x"])`。
3. 路由通过 `Depends(get_xxx_store)` 拿全局单例；service 层加对应模块（参考 [../services/DEVELOPMENT.md](../services/DEVELOPMENT.md)）。
4. 统一用 `_handle_value_error` 把 service 抛的 `ValueError` 映射为 HTTP 异常。
5. 访问 `/docs` 确认契约同步。

### 修改插件对接契约

参考 [models/DEVELOPMENT.md](../models/DEVELOPMENT.md) 的"任务 4"流程。要点：
- `PluginConversationRequest.metadata` 是 `dict[str, Any]`，不强约束结构，新字段文档化即可。
- 在 `routers/plugin.py` 的 `_validate_metadata` 中加新字段的类型校验（如必须为 string）。
- 同步更新 [../../../plugin-sdk/kwa-push.d.ts](../../../plugin-sdk/kwa-push.d.ts) 与 [../../../plugin-sdk/README.md](../../../plugin-sdk/README.md)。

## 代码约定

### 依赖注入

每个 router 通过 `Depends(get_xxx_store)` 拿全局单例：
```python
def get_graph_store() -> GraphStore:
    """依赖注入：返回全局 GraphStore 单例。"""
    return graph_store

@router.get("/graphs/{graph_id}")
async def get_graph(graph_id: str, store: GraphStore = Depends(get_graph_store)):
    ...
```
**目的**：便于测试时用 `app.dependency_overrides[get_graph_store] = lambda: mock_store` 替换。

### 错误映射

统一用 `_handle_value_error` 把 service 抛的 `ValueError` 映射为 HTTP 异常：
- 消息含"不存在" → 404（资源缺失）
- 消息含"非法" → 422（语义校验失败，与 Pydantic 422 风格一致）
- 其余 → 400（通用业务校验失败）

```python
def _handle_value_error(exc: ValueError) -> HTTPException:
    msg = str(exc)
    if "不存在" in msg:
        return _not_found(msg)
    if "非法" in msg:
        return HTTPException(status_code=422, detail=msg)
    return _bad_request(msg)
```

资源不存在的返回值（`None` / `False`）由路由显式判断并抛 404：
```python
node = await store.get_node(node_id)
if node is None:
    raise _not_found(f"节点不存在: {node_id}")
```

### 命名

- **路由函数**：snake_case，动词开头（`create_graph` / `list_graphs` / `get_graph` / `update_graph` / `delete_graph`）。
- **路径参数**：snake_case（`graph_id` / `node_id` / `quiz_id`）。
- **查询参数**：snake_case，用 `Query(...)` 标注约束（`ge` / `le` / `min_length` / `max_length`）。
- **请求体**：用 Pydantic schema（`body: GraphCreate`），不直接用 `dict`。

### 异步

所有路由函数 `async def`，service 层方法也 `async def`；DB 操作走 `AsyncSessionLocal`。**不要在路由函数中直接 `import openai` 或调外部 API**，相关逻辑放 `services/`。

### 流式端点的双通道

流式端点（`/api/.../xxx-stream`）的 HTTP 响应**只**返回 `StreamStartedResponse { request_id }`，立即结束。实际 token 流通过 **WebSocket** 推送：
1. 路由函数生成 `request_id`，注册到 `llm_request_registry`。
2. `asyncio.create_task(graph_agent.xxx_stream(graph_id, node_id, session_id, request_id))` 后台跑流式。
3. `graph_agent` 内部每个 token 通过 `ws_notify.notify_session(session_id, {"type": "graph_agent_token", "op": "...", "delta": token, ...})` 推送。
4. 前端通过 `streamingSessionId` 绑定的 WebSocket 接收 token，按 `op` 字段分发到对应流式文本切片。

**chat 流式端点例外**：`chat.py` 的 `/api/chat/sessions/{id}/stream` 沿用双通道协议，但 `op` 固定为 `"chat"`，并新增 3 个 chat 事件类型：
- `chat_tool_call`：Agent 决定调用工具时推送（携带工具名 / 参数 / call_id）。
- `chat_tool_result`：工具执行完成时推送（携带返回值）。
- `chat_tool_call_confirmation`：高风险工具需用户确认时推送（前端展示"确认 / 取消"按钮）。

## 常见任务

### 任务 1：在已有路由上加一个新端点

参考"开发工作流 → 新增一个 API 端点"。

### 任务 2：新增一个流式 LLM 端点

**场景**：希望对比两个节点的异同，结果流式输出。

**步骤**：
1. 在 [../services/graph_agent.py](../services/graph_agent.py) 加 `async def compare_nodes_stream(graph_id, node_a_id, node_b_id, session_id) -> AsyncGenerator[str, None]`：构造 prompt → `LLMClient.chat_stream` → 每个 token `yield` 同时 `await notify_session(session_id, {"type": "graph_agent_token", "op": "compare", "delta": token, ...})`。
2. 在 [stream.py](./stream.py) 加 `POST /api/graphs/{id}/nodes/compare-stream` 路由，接收 `{node_a_id, node_b_id, session_id}` → 立即返回 `StreamStartedResponse { request_id }` → 后台 `asyncio.create_task` 跑 `graph_agent.compare_nodes_stream`。
3. 在 [../services/llm_request_registry.py](../services/llm_request_registry.py) 注册 `request_id` 用于取消。
4. 在 [../../../frontend/src/lib/api.ts](../../../frontend/src/lib/api.ts) 加 `compareNodesStream(graphId, nodeIdA, nodeIdB, sessionId)`。
5. 在 [../../../frontend/src/store/useAppStore.ts](../../../frontend/src/store/useAppStore.ts) 加 `compareStreamingText` 状态 + `handleGraphAgentToken(event)` 中按 `op === 'compare'` 分发。
6. 在 [../../../frontend/src/components/graph/](../../../frontend/src/components/graph/) 新建 `ComparePanel.tsx`，订阅 `compareStreamingText` 渲染打字机效果。
7. 在 [../../../frontend/src/App.tsx](../../../frontend/src/App.tsx) 渲染 `<ComparePanel />` 浮层。

**验证**：选中两个节点 → 右键"对比" → 弹出 ComparePanel → 文本逐字流出 → 完成后可关闭。

### 任务 3：调整插件推送的去重窗口

**场景**：希望把去重窗口从 24h 改为 48h。

**步骤**：
1. 在 [plugin.py](./plugin.py) 把 `_DEDUP_WITHIN_HOURS = 24` 改为 `48`。
2. （可选）把常量提到 `config.py` 的 `Settings` 类，从 `.env` 读取。
3. 同步更新 [../../../plugin-sdk/README.md](../../../plugin-sdk/README.md) 的"幂等去重"章节。

**验证**：推送同一 `conversation_id` 的对话两次（间隔 30h）→ 第二次仍返回 `deduplicated: true`。

### 任务 4：调整 Work 模式风口推荐算法

**场景**：Work 模式风口推荐结果不理想，想调整权重。

**步骤**：
1. 在 [recommendations.py](./recommendations.py) 找到 Work 模式推荐分计算逻辑（`mode='work'` 分支）；或逻辑下沉到 `services/graph_store` / `services/graph_agent`，则去对应 service 调整。
2. 调整权重因子：`mention_count` / `last_reviewed_at` / `remind_at` / `is_starred` / `confidence` 等。
3. 在 [../../../frontend/src/components/graph/TrendsSidebar.tsx](../../../frontend/src/components/graph/TrendsSidebar.tsx) 看是否需要同步 UI 变化（如显示推荐理由）。
4. 跑种子脚本注入 Work 图谱，前端切到 Work 模式查看 TrendsSidebar。

**验证**：TrendsSidebar 中推荐项的顺序与分数符合预期；点击推荐项能跳到对应节点。

## 扩展点

### 新增 router 模块

参考"开发工作流 → 新增一个 router 模块"。

### 新增 WebSocket 事件类型

参考 [../DEVELOPMENT.md](../DEVELOPMENT.md) 的"扩展点 → 新增 WebSocket 事件类型"。

### 新增流式 LLM 端点

参考"任务 2"。

## 注意事项（坑）

### `_handle_value_error` 的消息约定

`_handle_value_error` 通过**消息文本**判断 HTTP 状态码：
- 含"不存在" → 404
- 含"非法" → 422
- 其余 → 400

因此 service 层抛 `ValueError` 时，**消息措辞要遵循此约定**：
- 资源缺失：`raise ValueError(f"图谱不存在: {graph_id}")` → 404
- 语义校验：`raise ValueError(f"非法图谱类型: {type}")` → 422
- 业务校验：`raise ValueError("节点不能自环")` → 400

不要写 `raise ValueError("找不到图谱")`（会被映射为 400 而非 404）。

### 流式端点的 HTTP 响应不流

流式端点（`/api/.../xxx-stream`）的 HTTP 响应**只**返回 `{"request_id": "..."}`，立即结束，**不要**用 `StreamingResponse` 在 HTTP 通道逐 token 推送。实际 token 流走 WebSocket（按 `session_id` 路由）。前端收到 `request_id` 后绑定 WebSocket 接收。

### 推送端点的鉴权风险

`POST /api/plugin/conversations` 当前**不做 token / Origin / 签名校验**，仅适用于本机 loopback（`127.0.0.1:8788`）。若将后端绑定到 `0.0.0.0` 或部署到公网 / 局域网，请务必自行在反向代理层（如 Nginx / Caddy）加 token / Origin 白名单 / IP 限制。详见 [../../../plugin-sdk/README.md](../../../plugin-sdk/README.md) 的"风险提示"章节。

### WebSocket 连接的 session_id 不能为空

前端连接 `/ws` 时必须传 `?session_id=<uuid32>`，否则注册到 `"default"` 会话，**所有用户共享同一个 default 通道**，流式 LLM token 会串流。前端 `App.tsx` 启动时调 `generateSessionId()` 生成唯一 ID，存到 `store.streamingSessionId`。

### 路由函数不要持有状态

路由函数应是无状态的，所有状态放 service 单例或 DB。不要在路由模块顶层声明可变全局变量（如 `_cache = {}`），改放 service 层（如 `llm_request_registry`）。

## 下一步该读什么

| 你的角色 / 目标 | 下一步文档 |
|----------------|-----------|
| 要改 ORM 模型 / Pydantic schema / 节点类型枚举 | [../models/DEVELOPMENT.md](../models/DEVELOPMENT.md) |
| 要改服务层 / graph_agent / LLM 调用 / 图谱存储 | [../services/DEVELOPMENT.md](../services/DEVELOPMENT.md) |
| 要看应用入口 / 配置 / DB 初始化 | [../DEVELOPMENT.md](../DEVELOPMENT.md) |
| 要改前端 React 组件 / 图谱可视化 | [../../../frontend/DEVELOPMENT.md](../../../frontend/DEVELOPMENT.md) |
| 要做插件推送对接 | [../../../plugin-sdk/DEVELOPMENT.md](../../../plugin-sdk/DEVELOPMENT.md) |
| 要看后端整体架构 | [../../DEVELOPMENT.md](../../DEVELOPMENT.md) |
