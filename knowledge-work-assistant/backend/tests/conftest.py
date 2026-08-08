"""pytest 全局 fixture：临时 SQLite 数据库 + httpx AsyncClient + mock LLM。

提供 4 个核心 fixture（参见 spec Task 11 / checklist E 段）：

- ``tmp_db``：用 ``tmp_path`` 创建临时 SQLite 文件，monkeypatch
  ``settings.database_url`` 与 ``app.db.engine`` / ``AsyncSessionLocal``，
  并 monkeypatch 所有从 ``app.db`` import ``AsyncSessionLocal`` 的使用方模块，
  调用 ``Base.metadata.create_all`` 初始化表结构。**不读写
  ``backend/data/app.db``**。
- ``app``：FastAPI app 实例（依赖 ``tmp_db``，用于 ASGITransport）。
  ASGITransport 默认不触发 lifespan，故 lifespan 中的 ``init_db()`` 不会被调用，
  表结构初始化由 ``tmp_db`` fixture 负责。
- ``async_client``：``httpx.AsyncClient`` + ``ASGITransport(app)``，
  依赖 ``tmp_db`` 与 ``app``，yield client，测试结束自动关闭。
- ``mock_llm``：monkeypatch ``app.services.llm_factory.get_llm_client``，
  返回 mock LLMClient（``unittest.mock.AsyncMock``），所有 LLM 调用通过 mock
  替代，不发真实网络请求，可在无 API Key 环境下运行。

设计要点
--------

1. **monkeypatch 模块级 import**：``app.services.graph_store`` 等模块通过
   ``from app.db import AsyncSessionLocal`` 在模块加载时绑定到本地名字，
   单纯 monkeypatch ``app.db.AsyncSessionLocal`` 不影响这些已绑定的引用，
   必须逐一 monkeypatch 每个使用方模块的 ``AsyncSessionLocal``。
2. **ASGITransport 不触发 lifespan**：``httpx.ASGITransport`` 默认 ``lifespan="off"``，
   因此 ``app.main.lifespan`` 中的 ``init_db()`` / ``migrate_node_columns`` /
   ``init_graph_agent`` 都不会执行，测试由 ``tmp_db`` 负责表结构初始化。
3. **FTS5 虚拟表**：插件 webhook 测试不依赖 FTS5 全文检索，``tmp_db`` 仅创建
   基础表（``Base.metadata.create_all``），不创建 FTS5 虚拟表与触发器。
4. **测试结束清理**：``tmp_db`` 在 yield 后 ``dispose`` 测试 engine，临时 SQLite
   文件由 pytest ``tmp_path`` 自动清理。
"""

from __future__ import annotations

import importlib
import sys
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

# 把 backend 目录加入 sys.path（确保 `import app` 可用，无论从哪个 cwd 启动 pytest）
_BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))


#: 所有通过 ``from app.db import AsyncSessionLocal`` 在模块加载时绑定本地名字的
#: 使用方模块列表。``tmp_db`` fixture 会逐一 monkeypatch 这些模块的
#: ``AsyncSessionLocal`` 引用，确保使用测试 engine。
#: 列表来源于 ``grep -r "from app.db import" app/`` 的扫描结果。
_ASYNC_SESSION_IMPORTERS: tuple[str, ...] = (
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


@pytest_asyncio.fixture
async def tmp_db(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> AsyncIterator[None]:
    """临时 SQLite 数据库 fixture。

    用 ``tmp_path`` 创建临时 SQLite 文件，monkeypatch ``settings.database_url``
    与 ``settings.data_dir``，重建 engine / ``AsyncSessionLocal``，并 monkeypatch
    到 ``app.db`` 及所有使用方模块，调用 ``Base.metadata.create_all`` 初始化
    表结构。**不读写 ``backend/data/app.db``**。

    Yields:
        None（仅作为副作用型 fixture，标志数据库已就绪）。
    """
    # 临时 SQLite 文件路径（使用正斜杠，避免 Windows 反斜杠在 URL 中转义）
    db_file = tmp_path / "test_app.db"
    db_url = f"sqlite+aiosqlite:///{db_file.as_posix()}"

    # monkeypatch settings：database_url 指向临时文件，data_dir 指向 tmp_path
    # 避免 lifespan / settings.ensure_dirs 在 backend/data 下创建目录
    from app.config import settings

    monkeypatch.setattr(settings, "database_url", db_url)
    monkeypatch.setattr(settings, "data_dir", tmp_path / "data")

    # 重建 engine 与 AsyncSessionLocal（绑定到临时 SQLite）
    test_engine = create_async_engine(db_url, echo=False, future=True)
    from app.db import configure_sqlite_engine
    configure_sqlite_engine(test_engine)
    test_session_maker = async_sessionmaker(
        bind=test_engine,
        expire_on_commit=False,
        autoflush=False,
    )

    # monkeypatch app.db 模块级的 engine 与 AsyncSessionLocal
    import app.db as db_module

    monkeypatch.setattr(db_module, "engine", test_engine)
    monkeypatch.setattr(db_module, "AsyncSessionLocal", test_session_maker)

    # monkeypatch 所有使用方模块的 AsyncSessionLocal 引用
    # 这些模块在加载时通过 `from app.db import AsyncSessionLocal` 绑定到本地
    # 名字，必须逐一替换才能让 graph_store 等使用测试 engine
    for mod_name in _ASYNC_SESSION_IMPORTERS:
        try:
            mod = importlib.import_module(mod_name)
        except ImportError:
            # 部分模块可能未引入 AsyncSessionLocal，跳过
            continue
        if hasattr(mod, "AsyncSessionLocal"):
            monkeypatch.setattr(mod, "AsyncSessionLocal", test_session_maker)

    # 初始化表结构：Base.metadata.create_all（不创建 FTS5 虚拟表与触发器，
    # 插件 webhook 测试不依赖全文检索）
    from app.db import Base
    from app.models import db_models  # noqa: F401  确保所有 ORM 模型被注册

    async with test_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    yield

    # 测试结束：释放 engine 连接（临时 SQLite 文件由 pytest tmp_path 自动清理）
    await test_engine.dispose()


@pytest.fixture
def mock_llm(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """Mock LLM 客户端 fixture。

    monkeypatch ``app.services.llm_factory.get_llm_client`` 返回 mock LLMClient
    （基于 ``unittest.mock.AsyncMock``），所有 LLM 调用通过 mock 替代，不发真实
    网络请求，可在无 API Key 环境下运行。

    Returns:
        MagicMock 对象，常用方法已配置为 AsyncMock：
        - ``chat_stream``：流式对话
        - ``chat``：非流式对话
        - ``embed``：向量化
    """
    mock_client = MagicMock(name="MockLLMClient")
    mock_client.chat_stream = AsyncMock(name="chat_stream")
    mock_client.chat = AsyncMock(name="chat", return_value={"content": ""})
    mock_client.embed = AsyncMock(name="embed", return_value=[0.0])
    mock_client.model = "mock-model"
    mock_client.max_output_tokens = 4096
    mock_client.default_temperature = 0.7

    async def _mock_get_llm_client(_session: Any) -> MagicMock:
        return mock_client

    import app.services.llm_factory as llm_factory

    monkeypatch.setattr(llm_factory, "get_llm_client", _mock_get_llm_client)

    return mock_client


@pytest_asyncio.fixture
async def app(tmp_db: None) -> AsyncIterator[FastAPI]:
    """FastAPI app 实例 fixture，依赖 tmp_db。

    用于 ``ASGITransport``。ASGITransport 默认不触发 lifespan，故 lifespan 中的
    ``init_db()`` / ``migrate_node_columns`` / ``init_graph_agent`` 都不会执行，
    表结构初始化由 ``tmp_db`` fixture 负责。

    Yields:
        配置好的 FastAPI app 实例。
    """
    # 延迟 import：确保在 tmp_db 已 monkeypatch app.db 后再加载 app.main，
    # 使 app.main 中的路由注册使用 monkeypatch 后的 db 引用
    from app.main import app as fastapi_app

    yield fastapi_app


@pytest_asyncio.fixture
async def async_client(app: FastAPI) -> AsyncIterator[AsyncClient]:
    """httpx AsyncClient + ASGITransport fixture。

    依赖 ``tmp_db`` 与 ``app``，yield client，测试结束自动关闭。
    ``base_url`` 设为 ``http://test``（占位，ASGITransport 直连 app 不实际发 HTTP）。

    Yields:
        ``httpx.AsyncClient`` 实例。
    """
    transport = ASGITransport(app=app)
    from app.config import settings
    from app.routers.plugin import _plugin_credentials

    credential = "test-plugin-credential"
    _plugin_credentials.add(credential)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={
            "X-Local-API-Token": settings.local_api_token,
            "X-Plugin-Credential": credential,
        },
    ) as client:
        yield client
    _plugin_credentials.discard(credential)
