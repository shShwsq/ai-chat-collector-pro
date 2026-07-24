"""异步数据库初始化与会话工厂。

基于 SQLAlchemy 2.0 异步 ORM + aiosqlite：
- ``engine``：异步引擎（指向 ``settings.database_url``）
- ``AsyncSessionLocal``：异步 session 工厂
- ``init_db()``：创建所有表（基于 ``Base.metadata``），同时创建 FTS5 虚拟表与同步触发器，
  并确保数据目录存在
- ``get_session()``：FastAPI 依赖，提供请求级 AsyncSession

从步影 backend/app/db.py 适配而来，保留 FTS5 全文检索表结构与触发器，
供 services 层（knowledge_store / tag_store / fts）使用。若 SQLite 未编译 FTS5
扩展，则跳过（仅记录日志，不阻断启动）。
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.config import settings

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    """所有 ORM 模型的声明式基类。"""

    pass


# 异步引擎：future=True 强制 SQLAlchemy 2.0 风格
engine = create_async_engine(
    settings.database_url,
    echo=False,
    future=True,
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)


@event.listens_for(engine.sync_engine, "connect")
def _set_sqlite_pragma(dbapi_connection, _connection_record) -> None:
    """SQLite 默认关闭外键约束，这里在每次连接时打开，确保 ON DELETE CASCADE 生效。"""
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


async def init_db() -> None:
    """创建所有表（基于 metadata），并确保运行所需目录存在。

    开发期使用 ``create_all``；生产环境应改用 Alembic 迁移管理 schema 演进。
    随后创建 FTS5 虚拟表与同步触发器（若 SQLite 支持 FTS5 扩展）。
    """
    # 延迟导入，确保所有 ORM 模型被注册到 Base.metadata
    from app.models import db_models  # noqa: F401

    settings.ensure_dirs()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _create_fts5(conn)


async def _create_fts5(conn) -> None:
    """创建 FTS5 虚拟表与同步触发器。

    四张虚拟表：
    - ``messages_fts(row_id UNINDEXED, content)``
    - ``checkpoints_fts(row_id UNINDEXED, content)``
    - ``file_metadata_fts(row_id UNINDEXED, original_name, summary)``
    - ``observations_fts(row_id UNINDEXED, conversation_markdown)``

    ``row_id`` 存储对应基础表的主键（string），``UNINDEXED`` 表示该列不参与全文匹配、
    仅用于回连。每张表配套 INSERT/UPDATE/DELETE 触发器，保证基础表与 FTS 表同步。

    FTS5 不可用（SQLite 未编译该扩展）时记录警告并跳过，不阻断启动。
    """
    ddl = [
        # ---- messages_fts ----
        "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5("
        "row_id UNINDEXED, content, tokenize='unicode61');",
        "CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN "
        "INSERT INTO messages_fts(row_id, content) VALUES (NEW.id, NEW.content); END;",
        "CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN "
        "DELETE FROM messages_fts WHERE row_id = OLD.id; END;",
        "CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN "
        "DELETE FROM messages_fts WHERE row_id = OLD.id; "
        "INSERT INTO messages_fts(row_id, content) VALUES (NEW.id, NEW.content); END;",
        # ---- checkpoints_fts ----
        "CREATE VIRTUAL TABLE IF NOT EXISTS checkpoints_fts USING fts5("
        "row_id UNINDEXED, content, tokenize='unicode61');",
        "CREATE TRIGGER IF NOT EXISTS checkpoints_ai AFTER INSERT ON checkpoints BEGIN "
        "INSERT INTO checkpoints_fts(row_id, content) VALUES (NEW.id, NEW.content); END;",
        "CREATE TRIGGER IF NOT EXISTS checkpoints_ad AFTER DELETE ON checkpoints BEGIN "
        "DELETE FROM checkpoints_fts WHERE row_id = OLD.id; END;",
        "CREATE TRIGGER IF NOT EXISTS checkpoints_au AFTER UPDATE ON checkpoints BEGIN "
        "DELETE FROM checkpoints_fts WHERE row_id = OLD.id; "
        "INSERT INTO checkpoints_fts(row_id, content) VALUES (NEW.id, NEW.content); END;",
        # ---- file_metadata_fts ----
        "CREATE VIRTUAL TABLE IF NOT EXISTS file_metadata_fts USING fts5("
        "row_id UNINDEXED, original_name, summary, tokenize='unicode61');",
        "CREATE TRIGGER IF NOT EXISTS file_metadata_ai AFTER INSERT ON file_metadata BEGIN "
        "INSERT INTO file_metadata_fts(row_id, original_name, summary) "
        "VALUES (NEW.id, NEW.original_name, NEW.summary); END;",
        "CREATE TRIGGER IF NOT EXISTS file_metadata_ad AFTER DELETE ON file_metadata BEGIN "
        "DELETE FROM file_metadata_fts WHERE row_id = OLD.id; END;",
        "CREATE TRIGGER IF NOT EXISTS file_metadata_au AFTER UPDATE ON file_metadata BEGIN "
        "DELETE FROM file_metadata_fts WHERE row_id = OLD.id; "
        "INSERT INTO file_metadata_fts(row_id, original_name, summary) "
        "VALUES (NEW.id, NEW.original_name, NEW.summary); END;",
        # ---- observations_fts（Task 2 新增，供 Agent 检索对话原文）----
        "CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5("
        "row_id UNINDEXED, conversation_markdown, tokenize='unicode61');",
        "CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN "
        "INSERT INTO observations_fts(row_id, conversation_markdown) "
        "VALUES (NEW.id, NEW.conversation_markdown); END;",
        "CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN "
        "DELETE FROM observations_fts WHERE row_id = OLD.id; END;",
        "CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN "
        "DELETE FROM observations_fts WHERE row_id = OLD.id; "
        "INSERT INTO observations_fts(row_id, conversation_markdown) "
        "VALUES (NEW.id, NEW.conversation_markdown); END;",
    ]
    try:
        for stmt in ddl:
            await conn.execute(text(stmt))
    except Exception as exc:  # noqa: BLE001
        # FTS5 / 触发器创建失败通常意味着 SQLite 未编译 FTS5 扩展
        logger.warning("FTS5 虚拟表创建失败，全文检索将不可用: %s", exc)


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI 依赖：提供请求级 AsyncSession，请求结束自动关闭。"""
    async with AsyncSessionLocal() as session:
        yield session
