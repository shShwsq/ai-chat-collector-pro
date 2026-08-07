# 设置面板「数据管理 / Danger Zone」清空功能

## Context（为什么做）

`knowledge-work-assistant` 当前只能单条删除会话（`DELETE /api/chat/sessions/{id}`）和单条删除图谱（`DELETE /api/graphs/{graph_id}`），设置面板（[SettingsPanel.tsx](file:///c:/Users/njwjx/Desktop/coding/ai-chat-collector-pro/knowledge-work-assistant/frontend/src/components/SettingsPanel.tsx)）没有任何批量清理入口。本地 SQLite 库会持续累积 chat 会话、图谱、observations，用户想"重置 / 脱敏 / 清测试数据"时只能一个个点，体验很差。

本次新增一个「数据管理」区块，提供：清空所有对话会话、清空所有图谱、清空所有观察记录三项操作，支持按模式（study/work）过滤，清空前提示导出备份。三项操作各自独立（不做"一键清空全部"），职责清晰、可控性强。

## 用户已确认的决策

1. **清空图谱是否连带 observations**：提供选项让用户在确认弹框里选（默认不连带，可勾选"同时清空绑定的源对话"）。
2. **范围粒度**：支持按模式（study/work），也支持全局（全部）。
3. **备份**：清空前在确认弹框里提供「导出 JSON」按钮（不强制）。

## 数据模型关键事实（已核实）

- 会话：`sessions` → `messages` / `checkpoints` 走 `ondelete=CASCADE`（[db_models.py:58-128](file:///c:/Users/njwjx/Desktop/coding/ai-chat-collector-pro/knowledge-work-assistant/backend/app/models/db_models.py#L58-L128)）。`sessions.mode` 区分 study/work。
- 图谱：`graphs` → `nodes` / `edges` / `quizzes` 走 `ondelete=CASCADE`（[db_models.py:234-267](file:///c:/Users/njwjx/Desktop/coding/ai-chat-collector-pro/knowledge-work-assistant/backend/app/models/db_models.py#L234-L267)）。`graphs.type` 区分 study/work。
- observations：`observations.graph_id` 外键为 `ondelete=SET NULL`（[db_models.py:422-427](file:///c:/Users/njwjx/Desktop/coding/ai-chat-collector-pro/knowledge-work-assistant/backend/app/models/db_models.py#L422-L427)）——删图谱不会删 observations，只会解绑。**observations 没有 mode 字段**，只有 `source`（plugin/import/manual），所以 observations 清空按 `source` 过滤（可选），不做 mode 过滤。
- chat.py 模块级缓存 `_session_agents` / `_chat_tasks` / `_request_sessions` / `_session_active_requests`（[chat.py:69-79](file:///c:/Users/njwjx/Desktop/coding/ai-chat-collector-pro/knowledge-work-assistant/backend/app/routers/chat.py#L69-L79)）批量删会话时必须同步清理并取消活跃流式任务。
- `graph_store` 已有 `delete_graph(id)`、`delete_observation(id)`、`list_graphs(type)`、`list_observations(...)`（[graph_store.py:238,269,906](file:///c:/Users/njwjx/Desktop/coding/ai-chat-collector-pro/knowledge-work-assistant/backend/app/services/graph_store.py#L238)）——无批量方法，需新增。
- 启动时 `seed_onboarding_if_empty` 会在无图谱时重建引导图谱（[main.py:69](file:///c:/Users/njwjx/Desktop/coding/ai-chat-collector-pro/knowledge-work-assistant/backend/app/main.py#L69)）：清空图谱后需重启才会重新播种，本次不处理（属预期行为）。

## 复用的既有模式

- **前端 API 下载模式**：`exportReportDocx`（[api.ts:440-481](file:///c:/Users/njwjx/Desktop/coding/ai-chat-collector-pro/knowledge-work-assistant/frontend/src/lib/api.ts#L440-L481)）已实现 fetch→blob→`URL.createObjectURL`→anchor 下载，导出 JSON 直接复用此模式。
- **store action 模式**：`deleteGraph`（[useAppStore.ts:1314-1332](file:///c:/Users/njwjx/Desktop/coding/ai-chat-collector-pro/knowledge-work-assistant/frontend/src/store/useAppStore.ts#L1314-L1332)）：`set({error:''})`→try `api.xxx()`→更新本地态→`pushToast(msg,'success')`→return true；catch→`set({error:errMsg(e)})`→`pushToast(...,'error')`→return false。
- **确认弹窗**：`ConfirmDialog`（[ConfirmDialog.tsx](file:///c:/Users/njwjx/Desktop/coding/ai-chat-collector-pro/knowledge-work-assistant/frontend/src/components/graph/ConfirmDialog.tsx)）已有 `danger` 红色按钮 + Esc/遮罩关闭 + 焦点管理。本次扩展两个可选 prop。
- **设置区块样式**：`.settings-section` / `.settings-section__header` 等（app.css），新区块复用同类结构。

## 实施步骤

### 一、后端

#### 1. `graph_store` 新增批量方法（`backend/app/services/graph_store.py`）

在 `delete_graph` 后新增：
- `delete_graphs_by_type(graph_type: str | None) -> int`：按 `type` 批量删图谱（None=全部），复用 ORM 级联。返回删除条数。用 `delete(GraphRow).where(...)` + `count` 前先 `select` 计数。
- 在 `delete_observation` 后新增 `delete_observations_by_source(source: str | None) -> int`：按 `source` 批量删（None=全部）。返回删除条数。

#### 2. chat 路由新增批量删除端点（`backend/app/routers/chat.py`）

新增 `DELETE /chat/sessions`（注意与单条 `DELETE /chat/sessions/{id}` 共存，FastAPI 路由顺序需把批量路径放在动态路径之前，或用不同路径避免歧义——**改用 `DELETE /chat/sessions:bulk` 或 `POST /chat/sessions/clear` 更清晰**，这里采用 `POST /chat/sessions/clear` 避免与单条 DELETE 路由冲突）：
- 查询参数 `mode: str | None`（study/work/None=全部）。
- 先 `select` 出匹配的 session_id 列表，逐个清理 `_session_agents` / 取消活跃请求（复用单删里的清理逻辑，抽成内部函数 `_cleanup_session_caches(session_id)`），再批量 `delete(SessionRow).where(SessionRow.id.in_(ids))`。
- 返回 `{ok, deleted_count, mode}`。幂等（无数据返回 0）。

#### 3. graphs 路由新增批量删除端点（`backend/app/routers/graphs.py`）

新增 `POST /graphs/clear`（避免与 `DELETE /graphs/{graph_id}` 冲突）：
- 查询参数 `mode: str | None`。
- 调 `graph_store.delete_graphs_by_type(mode)`。
- 返回 `{ok, deleted_count, mode}`。

#### 4. extraction 路由新增 observations 批量删除端点（`backend/app/routers/extraction.py`）

新增 `POST /observations/clear`：
- 查询参数 `source: str | None`（plugin/import/manual/None=全部）。
- 调 `graph_store.delete_observations_by_source(source)`。
- 返回 `{ok, deleted_count, source}`。

#### 5. 新增数据导出路由（`backend/app/routers/data_management.py`，新文件）

- `GET /data/export?mode=study|work`：聚合导出 sessions+messages+checkpoints、graphs+nodes+edges+quizzes、observations 为一个 JSON。mode 仅过滤 sessions/graphs；observations 全量导出（因无 mode 字段）。
- 用 `StreamingResponse`（或直接 `Response(content=json, media_type="application/json")`）+ `Content-Disposition: attachment; filename*=UTF-8''kwa_backup_YYYYMMDD_HHMMSS.json`。
- 复用 `graph_store` 各 list 方法和 chat 路由的查询逻辑；为避免循环依赖，直接在 data_management 里用 `AsyncSessionLocal` 查询各表序列化（参考 graph_store 的 `_xxx_to_dict` 序列化函数，可 import 复用）。
- 在 `main.py` 注册：`app.include_router(data_management.router, prefix="/api", tags=["data-management"])`。

### 二、前端

#### 1. 类型与 API 客户端（`frontend/src/lib/types.ts` + `api.ts`）

- types.ts 新增：`ClearResult { ok: boolean; deleted_count: number; mode?: string | null; source?: string | null }`。
- api.ts 新增方法：
  - `clearChatSessions(mode?: Mode)` → `POST /chat/sessions/clear?mode=...`
  - `clearGraphs(mode?: Mode)` → `POST /graphs/clear?mode=...`
  - `clearObservations(source?: string)` → `POST /observations/clear?source=...`
  - `exportData(mode?: Mode)` → 复用 `exportReportDocx` 的 blob 下载模式（[api.ts:440-481](file:///c:/Users/njwjx/Desktop/coding/ai-chat-collector-pro/knowledge-work-assistant/frontend/src/lib/api.ts#L440-L481)），GET `/data/export`，解析 `Content-Disposition` 文件名。

#### 2. store actions（`frontend/src/store/useAppStore.ts`）

新增三个 action（+ loading 标志 `clearingData: boolean`）：
- `clearAllChatSessions(mode)`：调 api → 成功后若当前在 chat 视图则 `loadChatSessions()` 刷新，`pushToast(\`已清空 ${n} 条对话\`,'success')`；失败 `pushToast(...,'error')`。同步清空 `currentChatSessionId` 等会话态。
- `clearAllGraphs(mode)`：调 api → 成功后 `loadGraphs(mode)` 刷新，若 `currentGraphId` 被删则清空 `currentGraphId/fullGraph/selectedNodeId`，`pushToast`。
- `clearAllObservations()`：调 api → `pushToast`（observations 列表按需刷新）。
- `exportAllData(mode)`：调 api.exportData → 触发下载，`pushToast('已导出备份','success')`。

#### 3. 扩展 ConfirmDialog（`frontend/src/components/graph/ConfirmDialog.tsx`）

新增两个可选 prop（向后兼容，不传则行为不变）：
- `confirmPhrase?: string`：传入后弹框多一个输入框，确认按钮在输入内容等于 `confirmPhrase` 时才启用（type-to-confirm，防误操作）。
- `onExport?: () => void` + `exportText?: string`：传入则在按钮区多渲染一个次要「导出备份」按钮（满足"清空前提示导出"）。

#### 4. SettingsPanel 新增 DangerZoneSection（`frontend/src/components/SettingsPanel.tsx`）

在 `RequestQueueSection` 之后追加 `<DangerZoneSection />`，放在最底部。结构：
- 顶部一个**模式范围选择器**（分段控件：全部 / Study / Work），控制清空会话与图谱的作用域。
- 一行「导出备份」按钮（随时可点，导出当前范围 JSON）。
- 三行操作（每行：标题 + 说明 + 危险按钮）：
  1. 清空所有对话会话（受范围选择器控制）
  2. 清空所有图谱（受范围选择器控制；点击后弹框里多一个"同时清空绑定的 observations"勾选——勾选时先调 clearObservations 解绑该模式图谱的 observations，再调 clearGraphs；不勾选只清图谱，observations 自动 SET NULL 解绑保留）
  3. 清空所有观察记录（全局，不受范围选择器控制，UI 注明"观察记录不区分模式"）
- 每个清空按钮点击 → 打开扩展后的 ConfirmDialog（`danger` + `confirmPhrase="清空"` + `onExport=导出当前范围`）。

#### 5. 样式（`frontend/src/styles/app.css` 或 settings 样式文件）

新增 `.danger-zone` 区块样式（红色边框/标题强调，复用 `.settings-section` 基础布局）、分段控件样式、type-to-confirm 输入框样式。参考既有 `.settings-section` 与 `.confirm-dialog` 风格保持一致。

## 关键设计取舍

- **路径用 `POST /xxx/clear` 而非 `DELETE /xxx` 批量**：避免与单条 `DELETE /xxx/{id}` 动态路由冲突，语义清晰（REST 上 DELETE 集合也可，但 FastAPI 路由匹配顺序易踩坑，POST + `/clear` 子路径最稳）。
- **observations 不做 mode 过滤**：数据模型无 mode 字段，强行按绑定图谱 mode 过滤会漏掉 `graph_id=NULL` 的游离记录，不直观。改用 `source` 过滤，UI 注明。
- **不做"一键清空全部"**：三项独立操作更可控，符合职责清晰偏好；用户要全清可依次点三项。
- **type-to-confirm**：批量不可逆删除必须输"清空"二字才点亮按钮，比单纯 OK 更安全。

## 验证方式

1. **后端单测/手测**：启动后端 `uv run uvicorn app.main:app --reload --port 8788`，用 curl/浏览器调：
   - `POST /api/chat/sessions/clear?mode=work` → 返回 deleted_count，DB sessions 表对应行清空，`_session_agents` 无残留。
   - `POST /api/graphs/clear?mode=study` → graphs + nodes + edges + quizzes 级联清空，observations 的 graph_id 变 NULL。
   - `POST /api/observations/clear` → observations 表清空。
   - `GET /api/data/export?mode=work` → 下载 JSON，校验含 sessions/messages/graphs/nodes/observations。
2. **前端手测**：启动前端 `pnpm dev`，进设置面板最底部「数据管理」：
   - 选范围 = Study，点清空会话 → 弹框输"清空"→确认 → toast 提示 → 切到 chat 视图看会话列表已空。
   - 点清空图谱 → 弹框勾选"同时清空 observations" → 确认 → 图谱列表刷新，observations 清空。
   - 点导出备份 → 浏览器下载 JSON 文件。
   - 验证 study 范围清空后 work 数据仍在。
3. **回归**：单条删除会话/图谱仍正常；清空后重启后端，`seed_onboarding_if_empty` 重建引导图谱（预期）。
