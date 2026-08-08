"""FastAPI 应用入口。

注册全部业务路由（health / auth / graphs / nodes / extensions / extraction /
quiz / work / recommendations / stream / chat / llm_admin / data_management /
plugin / ws）到对应前缀，配置 CORS（允许前端 Vite dev server 5174 与 file:// 来源），
启用本地 API 鉴权中间件，启动时初始化 SQLite 数据库（含目录创建与表结构）与全局单例。

端口约定：后端监听 **8788**。
- 推荐：``uv run uvicorn app.main:app --reload --port 8788``
- 也可直接运行：``uv run python -m app.main``（使用 settings.backend_port）

services 层（main_agent / graph_agent / graph_store / llm_client 等）由前期项目骨架
适配而来，已全部接入业务路由，承载 Study/Work 双模式与知识图谱功能。
"""

import hmac
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import __version__
from app.config import settings
from app.db import engine, init_db
from app.models.db_models import migrate_node_columns, migrate_session_columns
from app.routers import auth as auth_router

# Task 8：多轮对话 chat 路由（main_agent + 高风险拦截 + WS 推送）
from app.routers import chat as chat_router

# 数据管理：导出备份（批量清空分散在各域路由，导出跨域聚合在此）
from app.routers import data_management as data_management_router

# Task 8 / Task 11：节点延伸与对话抽取路由
from app.routers import extensions as extensions_router
from app.routers import extraction as extraction_router
from app.routers import graphs, health, nodes, plugin, ws

# LLM 请求队列与配置管理（前端设置面板用）
from app.routers import llm_admin as llm_admin_router

# Task 12：Study 测验路由
from app.routers import quiz as quiz_router

# Task 5：智能推荐（按学习 / 工作模式计算推荐分并排序）
from app.routers import recommendations as recommendations_router

# 流式触发路由（详情卡 / 问答 / 报告）
from app.routers import stream as stream_router

# Task 13/14/15/16：Work 模式业务路由（抽取入图/风口/报告/提问）
from app.routers import work as work_router
from app.services import ws_notify
from app.services.graph_agent import init_graph_agent
from app.services.graph_store import graph_store

# Task 8：main_agent + writer_agent 单例初始化
from app.services.main_agent import init_main_agent
from app.services.model_config import _REGISTRY

# 新手引导种子图谱（首次启动自动创建）
from app.services.onboarding_seed import seed_onboarding_if_empty
from app.services.task_registry import background_tasks
from app.services.writer_agent import init_writer_agent


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """应用生命周期。

    startup：加载 model_config.json（文件缺失或损坏时回退到硬编码兜底，不阻断启动）
        → 初始化数据库（init_db 内部会调用 ensure_dirs 创建 data/ 及 files/sessions 子目录）
        → 迁移表新增列（nodes 智能推荐字段 + sessions mode/graph_id 字段，幂等）
        → 初始化全局单例（GraphAgent / MainAgent / WriterAgent）。
    shutdown：当前无额外资源需释放；后续接入 MCP / 后台任务时在此清理。
    """
    _REGISTRY.load()
    await init_db()
    # 迁移 nodes 表新增列（智能推荐字段，幂等，旧库启动不报错）
    await migrate_node_columns(engine)
    # 迁移 sessions 表新增列（Task 8 chat 路由用：mode / graph_id，幂等）
    await migrate_session_columns(engine)
    # 首次启动：数据库无图谱时自动创建新手引导图谱（study + work 各一个）
    await seed_onboarding_if_empty(graph_store)
    # 初始化全局 GraphAgent 单例（无状态，仅确保模块加载与启动日志）
    init_graph_agent()
    # 初始化全局 MainAgent + WriterAgent 单例（Task 8）
    # 实际会话使用独立 MainAgent 实例（按 session_id 缓存于 routers/chat.py），
    # 此处的全局单例仅供「未指定 session」的兜底场景与 import 兼容性使用。
    try:
        _main = init_main_agent()
        init_writer_agent(_main.llm_client)
    except Exception as exc:  # noqa: BLE001 - LLM 未配置时仍允许启动
        # LLM 配置缺失：单例未初始化，前端在「设置面板」配置后调用 chat 接口会报错
        # （chat 路由会动态构造 LLMClient，配置就绪后即可正常工作）
        import logging
        logging.getLogger(__name__).warning(
            "MainAgent / WriterAgent 初始化失败（LLM 可能未配置）: %s", exc
        )
    background_tasks.start_accepting()
    yield
    await background_tasks.shutdown(timeout=8.0)
    await ws_notify.close_all()
    await engine.dispose()


app = FastAPI(
    title="对话回声 后端",
    description="双模式（Study/Work）知识图谱软件后端 - Agent + 知识库 + 图谱服务",
    version=__version__,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# 业务路由
@app.middleware("http")
async def enforce_request_limits_and_cache_policy(request: Request, call_next):
    def error_response(status_code: int, detail: str) -> JSONResponse:
        return JSONResponse(
            status_code=status_code,
            content={"detail": detail},
            headers={"Cache-Control": "no-store", "Pragma": "no-cache"},
        )

    if request.url.path.startswith("/api/"):
        is_plugin_pair = request.url.path == "/api/plugin/pair"
        plugin_credential = request.headers.get("x-plugin-credential", "")
        token = request.headers.get("x-local-api-token", "")
        local_authorized = bool(token) and hmac.compare_digest(
            token, settings.local_api_token
        )
        if not is_plugin_pair and not plugin_credential and not local_authorized:
            return error_response(401, "invalid local API token")

    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            declared_size = int(content_length)
        except ValueError:
            return error_response(400, "invalid Content-Length")
        if declared_size < 0:
            return error_response(400, "invalid Content-Length")
        if declared_size > settings.max_request_size_bytes:
            return error_response(413, "request body too large")

    received = 0
    original_receive = request.receive

    async def limited_receive():
        nonlocal received
        message = await original_receive()
        if message["type"] == "http.request":
            received += len(message.get("body", b""))
            if received > settings.max_request_size_bytes:
                raise ValueError("request body too large")
        return message

    request._receive = limited_receive
    try:
        response = await call_next(request)
    except ValueError as exc:
        if str(exc) != "request body too large":
            raise
        return error_response(413, str(exc))
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    return response


# health 挂载在 /api 前缀下：GET /api/health
app.include_router(
    health.router,
    prefix="/api",
    tags=["health"],
    dependencies=[Depends(auth_router.require_local_api_token)],
)
# 鉴权路由：GET /api/auth/ws-token（WebSocket 短期 token 签发）
app.include_router(
    auth_router.router,
    prefix="/api",
    tags=["auth"],
    dependencies=[Depends(auth_router.require_local_api_token)],
)

# 图谱管理（Task 4）：/api/graphs、/api/graphs/{id}/nodes|edges 等
app.include_router(graphs.router, prefix="/api", tags=["graphs"])
# 节点详情与留白（Task 7 / Task 9）：/api/graphs/{id}/nodes/{nid}/detail|user-fill
app.include_router(nodes.router, prefix="/api", tags=["nodes"])
# 节点延伸（Task 8）：/api/graphs/{id}/nodes/{nid}/extend|extend-revoke
app.include_router(extensions_router.router, prefix="/api", tags=["extensions"])
# Study 对话抽取（Task 11）：/api/observations、/api/graphs/{id}/nodes/batch
app.include_router(extraction_router.router, prefix="/api", tags=["extraction"])
# Study 测验（Task 12）：/api/graphs/{id}/quiz/generate|answer、/api/graphs/{id}/quiz[/{qid}]
app.include_router(quiz_router.router, prefix="/api", tags=["quiz"])
# Work 模式业务（Task 13/14/15/16）：
# /api/graphs/{id}/work/extract|confirm、/trends、/report、/ask
app.include_router(work_router.router, prefix="/api", tags=["work"])
# 智能推荐（Task 5）：/api/graphs/{id}/recommendations?mode=study|work&limit=20
app.include_router(
    recommendations_router.router, prefix="/api", tags=["recommendations"]
)
# 浏览器插件对接（Task 10）：/api/plugin/conversations、/api/plugin/contract
# plugin router 自带 prefix="/plugin"，叠加 /api 后为 /api/plugin/*
app.include_router(plugin.router, prefix="/api", tags=["plugin"])
# LLM 请求队列与配置管理：
# /api/llm/requests、/api/llm/requests/all、/api/llm/requests/{id}/cancel、
# /api/llm/requests/cleanup、/api/llm/config (GET/PUT)
app.include_router(llm_admin_router.router, prefix="/api", tags=["llm-admin"])
# 流式触发路由：
# /api/graphs/{id}/nodes/{nid}/detail-stream、/api/graphs/{id}/work/ask-stream、
# /api/graphs/{id}/work/report-stream
app.include_router(stream_router.router, prefix="/api", tags=["stream"])
# Task 8：多轮对话 chat 路由（main_agent + 高风险拦截 + WS 推送）：
# /api/chat/sessions、/api/chat/sessions/{id}/messages|stream|checkpoint、
# /api/chat/requests/{id}/cancel|confirm
app.include_router(chat_router.router, prefix="/api", tags=["chat"])
# 数据管理：/api/data/export（导出备份；批量清空在各域路由 /chat/sessions/clear、
# /graphs/clear、/observations/clear）
app.include_router(
    data_management_router.router, prefix="/api", tags=["data-management"]
)
# WebSocket 挂载在根路径下：/ws（前端 lib/ws.ts 连接此处做收发测试）
app.include_router(ws.router, tags=["ws"])


if __name__ == "__main__":
    # 便捷入口：uv run python -m app.main
    # 生产/开发推荐使用 uvicorn 命令（支持 --reload 热重载）
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=settings.backend_port,
        reload=False,
    )
