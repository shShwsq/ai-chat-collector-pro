"""FastAPI 应用入口。

注册业务路由（health / ws）到对应前缀，配置 CORS（允许前端 Vite dev server 5174
与 file:// 来源），启动时初始化 SQLite 数据库（含目录创建与表结构）。

端口约定：后端监听 **8788**（避免和步影 8787 冲突）。
- 推荐：``uv run uvicorn app.main:app --reload --port 8788``
- 也可直接运行：``uv run python -m app.main``（使用 settings.backend_port）

services 层（main_agent / knowledge_store / llm_client 等）已从步影适配拷贝，
但当前**未接入业务路由**，仅作为后续 Study/Work 双模式与知识图谱功能的实现基础。
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.config import settings
from app.db import engine, init_db
from app.models.db_models import migrate_node_columns
from app.routers import graphs, health, nodes, plugin, ws
# Task 8 / Task 11：节点延伸与对话抽取路由
from app.routers import extensions as extensions_router
from app.routers import extraction as extraction_router
# Task 12：Study 测验路由
from app.routers import quiz as quiz_router
# Task 13/14/15/16：Work 模式业务路由（抽取入图/风口/报告/提问）
from app.routers import work as work_router
# Task 5：智能推荐（按学习 / 工作模式计算推荐分并排序）
from app.routers import recommendations as recommendations_router
# LLM 请求队列与配置管理（前端设置面板用）
from app.routers import llm_admin as llm_admin_router
from app.services.graph_agent import init_graph_agent
from app.services.model_config import _REGISTRY


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """应用生命周期。

    startup：加载 model_config.json（文件缺失或损坏时回退到硬编码兜底，不阻断启动）
        → 初始化数据库（init_db 内部会调用 ensure_dirs 创建 data/ 及 files/sessions 子目录）
        → 初始化全局 GraphAgent 单例（Task 17，图谱 AI 服务层）。
    shutdown：当前无额外资源需释放；后续接入 MCP / 后台任务时在此清理。
    """
    _REGISTRY.load()
    await init_db()
    # 迁移 nodes 表新增列（智能推荐字段，幂等，旧库启动不报错）
    await migrate_node_columns(engine)
    # 初始化全局 GraphAgent 单例（无状态，仅确保模块加载与启动日志）
    init_graph_agent()
    yield


app = FastAPI(
    title="知识工作助手后端",
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
# health 挂载在 /api 前缀下：GET /api/health
app.include_router(health.router, prefix="/api", tags=["health"])
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
