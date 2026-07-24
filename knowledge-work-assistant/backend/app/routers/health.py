"""健康检查路由：GET /api/health。"""

from fastapi import APIRouter

from app import __version__
from app.models.schemas import HealthResponse

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
async def health_check() -> HealthResponse:
    """健康检查端点。

    前端启动时会调用此接口判断后端连接状态（绿色 / 红色指示）。
    """
    return HealthResponse(
        status="ok",
        service="knowledge-work-assistant-backend",
        version=__version__,
    )
