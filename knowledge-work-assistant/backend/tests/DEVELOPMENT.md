# tests/ 测试套件开发指南

> 一句话定位：本目录是 KWA 后端的测试套件，用 `pytest` + `httpx` + `httpx-ws` 跑；`conftest.py` 提供 4 个核心 fixture（`tmp_db` / `app` / `async_client` / `mock_llm`），`e2e/` 子目录含端到端集成测试覆盖插件推送 → 落库 → WS 广播完整链路。

## 模块职责

```
tests/
├── __init__.py                      # 空（仅标识为 Python 包）
├── conftest.py                      # pytest 全局 fixture：tmp_db / mock_llm / app / async_client
└── e2e/
    ├── __init__.py                  # 空（仅标识为 Python 包）
    ├── test_plugin_webhook.py       # 浏览器插件 webhook 端点单元测试（8 个用例）
    └── test_plugin_ws_broadcast.py  # WS 广播 + 完整链路 e2e 测试（2 个用例）
```

**测试栈**：
- `pytest` + `pytest-asyncio`：测试框架与异步用例支持
- `httpx.AsyncClient` + `ASGITransport`：直连 FastAPI app，无需启动 uvicorn
- `httpx_ws.aconnect_ws` + `ASGIWebSocketTransport`：直连 WebSocket 端点
- `unittest.mock.AsyncMock` / `MagicMock`：mock LLM 客户端
- `sqlalchemy.ext.asyncio`：临时 SQLite engine / session

## 核心 fixture

4 个核心 fixture 定义在 `conftest.py`，所有测试通过依赖注入使用：

### `tmp_db`：临时 SQLite 数据库

用 `tmp_path` 创建临时 SQLite 文件，monkeypatch `settings.database_url` 与 `app.db.engine` / `AsyncSessionLocal`，并 monkeypatch 所有从 `app.db` import `AsyncSessionLocal` 的使用方模块，调用 `Base.metadata.create_all` 初始化表结构。**不读写 `backend/data/app.db`**。

**关键操作**：
1. `monkeypatch.setattr(settings, "database_url", db_url)`：指向临时 SQLite 文件
2. `monkeypatch.setattr(settings, "data_dir", tmp_path / "data")`：避免 lifespan 在 `backend/data` 下创建目录
3. 重建 `test_engine` + `test_session_maker`（绑定到临时 SQLite）
4. `monkeypatch.setattr(db_module, "engine", test_engine)` 与 `monkeypatch.setattr(db_module, "AsyncSessionLocal", test_session_maker)`
5. 通过 `_ASYNC_SESSION_IMPORTERS` 列表逐一 monkeypatch 所有使用方模块（`graph_store` / `writer_agent` / `main_agent` / `context_manager` / `mcp_manager` / `graph_agent` / 各 `routers.*` 等）的 `AsyncSessionLocal` 引用
6. `Base.metadata.create_all` 初始化表结构（不创建 FTS5 虚拟表与触发器）
7. yield 后 `test_engine.dispose()` 释放连接，临时 SQLite 文件由 pytest `tmp_path` 自动清理

**fixture 类型**：`@pytest_asyncio.fixture`（异步，需 yield）

### `app`：FastAPI app 实例

依赖 `tmp_db`，延迟 `from app.main import app as fastapi_app`（确保在 `tmp_db` 已 monkeypatch `app.db` 后再加载 `app.main`，使路由注册使用 monkeypatch 后的 db 引用）。

**关键特性**：`ASGITransport` 默认 `lifespan="off"`，**不触发 lifespan**，故 `app.main.lifespan` 中的 `init_db()` / `migrate_node_columns` / `init_graph_agent` 都不会执行，表结构初始化由 `tmp_db` fixture 负责。

**fixture 类型**：`@pytest_asyncio.fixture`（异步，需 yield）

### `async_client`：httpx AsyncClient + ASGITransport

依赖 `tmp_db` 与 `app`，构造 `AsyncClient(transport=ASGITransport(app=app), base_url="http://test")`，yield client，测试结束自动关闭。

`base_url` 设为 `http://test`（占位，`ASGITransport` 直连 app 不实际发 HTTP）。

**fixture 类型**：`@pytest_asyncio.fixture`（异步，需 yield）

### `mock_llm`：Mock LLM 客户端

monkeypatch `app.services.llm_factory.get_llm_client` 返回 `MagicMock` 对象，常用方法已配置为 `AsyncMock`：
- `chat_stream`：流式对话
- `chat`：非流式对话（默认返回 `{"content": ""}`）
- `embed`：向量化（默认返回 `[0.0]`）
- `model = "mock-model"` / `max_output_tokens = 4096` / `default_temperature = 0.7`

所有 LLM 调用通过 mock 替代，不发真实网络请求，可在无 API Key 环境下运行。

**fixture 类型**：`@pytest.fixture`（同步，因 monkeypatch 是同步操作）

## `_ASYNC_SESSION_IMPORTERS` 维护规则

`conftest.py` 顶部定义了 `_ASYNC_SESSION_IMPORTERS: tuple[str, ...]`，列出所有通过 `from app.db import AsyncSessionLocal` 在模块加载时绑定本地名字的使用方模块。

**当前列表**（按字母顺序）：
```python
_ASYNC_SESSION_IMPORTERS = (
    "app.services.graph_store",
    "app.services.tag_store",
    "app.services.knowledge_store",
    "app.services.writer_agent",
    "app.services.main_agent",
    "app.services.context_manager",
    "app.services.mcp_manager",
    "app.services.graph_agent",
    "app.routers.llm_admin",
    "app.routers.extraction",
    "app.routers.extensions",
    "app.routers.graphs",
    "app.routers.nodes",
    "app.routers.quiz",
    "app.routers.recommendations",
    "app.routers.work",
    "app.routers.stream",
)
```

**维护规则**：
- **新增模块时必须追加**：若你在 `app/services/` 或 `app/routers/` 下新增模块并通过 `from app.db import AsyncSessionLocal` 绑定本地名字，**必须**在此列表追加该模块名，否则测试会用真实 `app.db.AsyncSessionLocal`（指向 `backend/data/app.db`），导致测试污染生产数据。
- **校验方法**：在 `app/` 目录下 `grep -r "from app.db import AsyncSessionLocal"`，确保扫描结果中的所有模块都在 `_ASYNC_SESSION_IMPORTERS` 中。
- **跳过逻辑**：`tmp_db` fixture 中 `try/except ImportError` 容忍部分模块未引入 `AsyncSessionLocal` 的情况，但 `hasattr(mod, "AsyncSessionLocal")` 检查后才会 monkeypatch，所以**未在列表中的模块不会被替换**。
- **新模块若通过 `from app.db import engine, AsyncSessionLocal` 一次性导入两个名字**，也只需追加模块名一次（`monkeypatch.setattr(mod, "AsyncSessionLocal", ...)` 仅替换 `AsyncSessionLocal`，若需替换 `engine` 也需在 fixture 中追加相应逻辑）。

## 测试用例清单

### `test_plugin_webhook.py`（8 个用例）

覆盖 `app/routers/plugin.py` 的所有端点：

| # | 用例名 | 端点 | 期望 |
|---|--------|------|------|
| 1 | `test_push_conversation_success` | `POST /api/plugin/conversations` | 200 + 落库 `source='plugin'` |
| 2 | `test_push_conversation_dedup` | `POST /api/plugin/conversations` | 同 `conversation_id` 重复推送 → 第二次 `deduplicated=true` |
| 3 | `test_push_conversation_invalid_platform` | `POST /api/plugin/conversations` | 非法 `platform` → 400 |
| 4 | `test_push_conversation_missing_field` | `POST /api/plugin/conversations` | 缺 `conversation_markdown` → 422（Pydantic 校验） |
| 5 | `test_plugin_health` | `GET /api/plugin/health` | 200 + `{ok, version, supported_platforms, queue_size}` |
| 6 | `test_plugin_contract` | `GET /api/plugin/contract` | 200 + 含 `version` / `supported_platforms` / `push_examples` |
| 7 | `test_plugin_recent` | `GET /api/plugin/conversations/recent` | 先推 N 条再 GET → 倒序列表 |
| 8 | `test_push_conversation_metadata_validation` | `POST /api/plugin/conversations` | `metadata.title` 非 string → 422 |

### `test_plugin_ws_broadcast.py`（2 个用例）

覆盖 WS 广播与端到端数据一致性：

| # | 用例名 | 验证点 |
|---|--------|--------|
| 1 | `test_ws_broadcast_on_push` | 建立 WS 连接 → POST 推送 → WS 收到 `{type: 'plugin.conversation_received', payload: {observation_id, platform, title, timestamp}}` 事件 |
| 2 | `test_e2e_full_pipeline` | 模拟采集器 patch 的完整对话 Markdown → 调 webhook → 验证落库（`observations` 表字段正确）→ 验证 WS 广播 → **HTTP 响应 / 数据库 / WS 广播三者 `observation_id` 一致** |

## WS 测试技术要点

### `ASGIWebSocketTransport` vs `ASGITransport`

`httpx.ASGITransport` **仅支持 HTTP**，不支持 WebSocket。WS 连接需用 `httpx_ws.transport.ASGIWebSocketTransport`（继承自 `ASGITransport`，扩展 WS 支持）。

```python
from httpx_ws import aconnect_ws
from httpx_ws.transport import ASGIWebSocketTransport

async with aconnect_ws(
    "http://test/ws",
    transport=ASGIWebSocketTransport(app=app),
) as ws:
    msg = await ws.receive_json()
```

### HTTP 与 WS 使用独立 `AsyncClient`

WS 连接是长连接，会占用 client 的 transport 状态。为避免冲突，HTTP POST 推送与 WS 接收使用**独立的** `AsyncClient` 实例，但都指向同一个 FastAPI app。`ws_notify` 模块是全局单例，WS 连接注册到全局 `_connections`，`broadcast` 能跨 client 找到已注册连接。

### keepalive ping 禁用

`aconnect_ws` 默认每 20s 发 keepalive ping，测试中禁用（`keepalive_ping_interval_seconds=None`）避免干扰消息接收：

```python
async with aconnect_ws(
    "http://test/ws",
    transport=ASGIWebSocketTransport(app=app),
    keepalive_ping_interval_seconds=None,
) as ws:
    ...
```

### 先接收 welcome 消息再 POST 推送

WS 端点 `/ws` 在连接建立后会立即推送 `{type: 'welcome'}`，测试需**先接收 welcome**（确认连接已注册到 `ws_notify`），再 POST 推送，否则 `broadcast` 可能找不到连接：

```python
async with aconnect_ws(...) as ws:
    welcome = await ws.receive_json()  # 接收 welcome
    assert welcome["type"] == "welcome"

    # 用另一个 async_client 发推送
    resp = await async_client.post("/api/plugin/conversations", json=payload)
    assert resp.status_code == 200

    # 接收广播
    broadcast = await asyncio.wait_for(ws.receive_json(), timeout=5.0)
    assert broadcast["type"] == "plugin.conversation_received"
```

## 测试隔离原则

| 原则 | 实现方式 |
|------|---------|
| **不读写 `backend/data/app.db`** | `tmp_db` fixture 用 `tmp_path` 创建临时 SQLite，monkeypatch `settings.database_url` 与所有 `AsyncSessionLocal` 引用 |
| **无真实 LLM 依赖** | `mock_llm` fixture monkeypatch `get_llm_client`，返回 `AsyncMock` 客户端，可在无 API Key 环境下运行 |
| **`ASGITransport` 不触发 lifespan** | `app` fixture 用 `ASGITransport(app=app)`，默认 `lifespan="off"`，故 `init_db()` / `migrate_node_columns` / `init_graph_agent` 都不执行 |
| **不创建 FTS5 虚拟表** | `tmp_db` 仅 `Base.metadata.create_all`，不创建 FTS5 虚拟表与触发器（插件 webhook 测试不依赖全文检索） |
| **测试结束清理** | `tmp_db` 在 yield 后 `dispose` 测试 engine，临时 SQLite 文件由 pytest `tmp_path` 自动清理 |

## 新增测试流程

1. **新建测试文件**：在 `e2e/` 下新建 `test_*.py`（如 `test_graph_agent.py`）。
2. **请求 fixture**：在测试函数签名中请求所需 fixture：
   ```python
   @pytest.mark.asyncio
   async def test_xxx(async_client: AsyncClient, tmp_db: None, mock_llm: MagicMock):
       ...
   ```
3. **发请求**：用 `async_client` 发 HTTP 请求（`async_client.get(...)` / `async_client.post(...)`）。
4. **断言**：用 `pytest` 标准断言；若需查 DB，用 `from app.db import AsyncSessionLocal` + `async with AsyncSessionLocal() as session:` 查询（已被 `tmp_db` monkeypatch 指向临时库）。
5. **mock LLM**：若测试会触发 LLM 调用（如 `graph_agent` 的方法），用 `mock_llm` fixture；可配置 `mock_llm.chat.return_value = {"content": "..."}` 自定义返回。
6. **WS 测试**：参考 `test_plugin_ws_broadcast.py` 的模式（独立 `AsyncClient` for HTTP 与 WS，禁用 keepalive ping，先接收 welcome）。

**验证**：`uv run pytest tests/e2e/test_xxx.py -v` 应全绿。

## 常用命令

| 命令 | 说明 |
|------|------|
| `uv run pytest` | 跑全部测试 |
| `uv run pytest tests/e2e/test_plugin_webhook.py -v` | 跑 webhook 测试，详细输出 |
| `uv run pytest tests/e2e/test_plugin_ws_broadcast.py -v` | 跑 WS 广播测试，详细输出 |
| `uv run pytest -k "dedup or health"` | 按关键字筛选跑（用例名含 `dedup` 或 `health`） |
| `uv run pytest -x` | 第一个失败就停止 |
| `uv run pytest --tb=short` | 失败时显示简短 traceback |
| `uv run pytest -s` | 显示 `print` 输出（默认被 pytest 捕获） |

**运行前提**：
- 已安装 `pytest` / `pytest-asyncio` / `httpx` / `httpx-ws`（在 `pyproject.toml` 的 `[tool.pytest.ini_options]` / `[project.optional-dependencies]` 中声明）
- 在 `backend/` 目录下运行（`conftest.py` 会自动把 `backend/` 加入 `sys.path`，无论从哪个 cwd 启动 pytest）

## 代码约定

### 异步用例

- 所有测试用例 `async def`，用 `@pytest.mark.asyncio` 标记（或在 `pyproject.toml` 中配置 `asyncio_mode = "auto"`，则无需显式标记）。
- 用 `await async_client.get(...)` 而非 `async_client.get(...).result()`。
- WS 接收用 `await asyncio.wait_for(ws.receive_json(), timeout=5.0)` 包裹，避免测试卡死。

### 命名

- **测试文件**：`test_*.py`（如 `test_plugin_webhook.py`）。
- **测试函数**：`test_*`（如 `test_push_conversation_success`），名称反映场景 + 期望。
- **fixture 函数**：snake_case（`tmp_db` / `async_client` / `mock_llm`）。
- **辅助函数**：下划线前缀（`_make_payload` / `_make_full_conversation_payload`）。

### 导入

- `from __future__ import annotations` 在文件首行（在 docstring 之后）。
- 导入顺序：标准库 → 第三方（`pytest` / `httpx` / `sqlalchemy`）→ 本项目（`from app.xxx import yyy`）。
- 测试中导入 `app.xxx` 是允许的（`tmp_db` 会 monkeypatch `app.db` 引用），但**不要**在模块顶部导入会触发 `init_db()` 的代码。

## 常见任务

### 任务 1：新增一个 webhook 端点的测试

**场景**：`routers/plugin.py` 新增 `DELETE /api/plugin/conversations/{id}` 端点。

**步骤**：
1. 在 `test_plugin_webhook.py` 加 `async def test_delete_conversation(async_client, tmp_db):`。
2. 先 POST 推送一条对话拿 `observation_id`。
3. 调 `DELETE /api/plugin/conversations/{observation_id}`，断言 200。
4. 调 `GET /api/plugin/conversations/recent`，断言列表不含已删除项。

**验证**：`uv run pytest tests/e2e/test_plugin_webhook.py::test_delete_conversation -v` 应通过。

### 任务 2：新增一个 WS 广播事件的测试

**场景**：新增一个会触发 WS 广播的端点（如 `POST /api/graphs/{id}/nodes/{nid}/star` 触发 `node.starred` 事件）。

**步骤**：
1. 在 `e2e/` 下新建 `test_graph_ws.py`。
2. 参考 `test_plugin_ws_broadcast.py` 的模式：独立 `AsyncClient` for HTTP 与 WS，禁用 keepalive ping，先接收 welcome。
3. 建立 WS 连接后 POST 触发端点，断言 WS 收到 `{type: 'node.starred', payload: {...}}`。

**验证**：`uv run pytest tests/e2e/test_graph_ws.py -v` 应通过。

### 任务 3：新增一个需要 LLM 的端点测试

**场景**：测试 `graph_agent.generate_node_detail` 的降级路径。

**步骤**：
1. 在 `e2e/` 下新建 `test_graph_agent.py`。
2. 请求 `mock_llm` fixture，配置 `mock_llm.chat.return_value = {"content": "invalid json"}`（模拟 LLM 返回非 JSON）。
3. POST 触发节点详情生成，断言响应含 `degraded: true`。

**验证**：`uv run pytest tests/e2e/test_graph_agent.py -v` 应通过，且无真实 LLM 调用。

## 注意事项（坑）

### 必须把新模块加入 `_ASYNC_SESSION_IMPORTERS`

若你在 `app/services/` 或 `app/routers/` 下新增模块并通过 `from app.db import AsyncSessionLocal` 绑定本地名字，**必须**在 `conftest.py` 的 `_ASYNC_SESSION_IMPORTERS` 列表追加该模块名。否则测试时该模块仍指向真实 `app.db.AsyncSessionLocal`（`backend/data/app.db`），导致：
- 测试数据污染生产库
- 测试间互相干扰（共享同一数据库）
- 测试失败时 traceback 含 `backend/data/app.db` 路径

**校验方法**：`grep -r "from app.db import" app/` 的扫描结果中的所有模块都应在 `_ASYNC_SESSION_IMPORTERS` 中。

### `ASGITransport` 不触发 lifespan

`httpx.ASGITransport` 默认 `lifespan="off"`，故 `app.main.lifespan` 中的 `init_db()` / `migrate_node_columns()` / `init_graph_agent()` 都不会执行。若你的测试依赖 lifespan 中的初始化逻辑（如模型加载、配置预热），需在 fixture 中显式调用相应函数，或改用 `httpx.LifespanManager`（需安装 `asgi-lifespan`）。

### WS 测试需独立 `AsyncClient`

WS 连接是长连接，会占用 client 的 transport 状态。**不要**用同一个 `AsyncClient` 既发 HTTP 又接收 WS，会冲突。HTTP POST 推送与 WS 接收使用独立的 `AsyncClient` 实例（但都指向同一个 FastAPI app）。

### `mock_llm` 不影响 `graph_agent` 的内部状态

`mock_llm` monkeypatch `app.services.llm_factory.get_llm_client`，但 `graph_agent` 的 `_get_llm_client` 是按调用获取的，所以每次 `graph_agent.xxx` 调用都会拿到 mock client。若你测试 `graph_agent` 的降级路径，配置 `mock_llm.chat_stream.side_effect = Exception("network error")` 可模拟 LLM 调用失败。

### 测试不要写真实文件

`tmp_db` fixture 已 monkeypatch `settings.data_dir` 指向 `tmp_path / "data"`，故 `file_storage` / `file_tools` 等 handler 在测试中写入的文件会落在临时目录，测试结束自动清理。**不要**在测试中直接写 `backend/data/` 下的文件。

## 下一步该读什么

| 你的角色 / 目标 | 下一步文档 |
|----------------|-----------|
| 要看 `conftest.py` 的 fixture 实现 | [./conftest.py](./conftest.py) |
| 要看 webhook 测试用例 | [./e2e/test_plugin_webhook.py](./e2e/test_plugin_webhook.py) |
| 要看 WS 广播测试用例 | [./e2e/test_plugin_ws_broadcast.py](./e2e/test_plugin_ws_broadcast.py) |
| 要看被测的 plugin 路由 | [../app/routers/plugin.py](../app/routers/plugin.py) |
| 要看被测的 graph_store | [../app/services/graph_store.py](../app/services/graph_store.py) |
| 要看被测的 ws_notify | [../app/services/ws_notify.py](../app/services/ws_notify.py) |
| 要看后端整体架构 | [../DEVELOPMENT.md](../DEVELOPMENT.md) |
