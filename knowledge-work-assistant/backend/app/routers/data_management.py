"""数据管理路由：导出与批量清空的跨域聚合入口。

目前仅提供导出端点（批量清空分散在各域路由：``POST /chat/sessions/clear``、
``POST /graphs/clear``、``POST /observations/clear``），挂载在 ``/api`` 前缀下：

- ``GET /api/data/export?mode=study|work``  导出全部数据为 JSON 备份文件

设计要点：

1. **跨域聚合**：导出需要同时读取 sessions / messages / checkpoints / graphs /
   nodes / edges / quizzes / observations 多张表，不属于单一域路由职责，故单列
   一个 ``data_management`` 路由。
2. **通用行序列化**：用 ``_row_to_dict`` 遍历 ORM 行的 ``__table__.columns``，
   datetime 转 isoformat 字符串，JSON 文本字段保留原字符串（备份忠实还原，
   不做二次解析，避免 malformed JSON 风险）。
3. **mode 过滤**：仅作用于 sessions（``mode``）与 graphs（``type``）及其级联
   子表（messages/checkpoints 按 session_id，nodes/edges/quizzes 按 graph_id）。
   observations 无 mode 字段，始终全量导出。
4. **下载响应**：用 ``Response`` + ``Content-Disposition: attachment; filename*=...``
   触发浏览器下载，文件名含时间戳。
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy import select

from app.db import AsyncSessionLocal
from app.models.db_models import (
    Checkpoint as CheckpointRow,
)
from app.models.db_models import (
    Edge as EdgeRow,
)
from app.models.db_models import (
    Graph as GraphRow,
)
from app.models.db_models import (
    Message as MessageRow,
)
from app.models.db_models import (
    Node as NodeRow,
)
from app.models.db_models import (
    Observation as ObservationRow,
)
from app.models.db_models import (
    Quiz as QuizRow,
)
from app.models.db_models import (
    Session as SessionRow,
)
from app.models.node_types import GRAPH_TYPES

logger = logging.getLogger(__name__)

router = APIRouter()


def _not_found(detail: str) -> HTTPException:
    return HTTPException(status_code=404, detail=detail)


def _bad_request(detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


def _row_to_dict(row: Any) -> dict[str, Any]:
    """通用 ORM 行序列化：遍历列，datetime 转 isoformat，其余原样。

    JSON 文本字段（attachments / tool_calls / detail_payload 等）保留为字符串，
    备份忠实还原库内存储形态，不二次解析。
    """
    data: dict[str, Any] = {}
    for col in row.__table__.columns:
        v = getattr(row, col.name)
        if isinstance(v, datetime):
            data[col.name] = v.isoformat()
        else:
            data[col.name] = v
    return data


@router.get("/data/export")
async def export_data(
    mode: str | None = Query(
        None, description="按模式过滤：study / work，省略则导出全部"
    ),
) -> Response:
    """导出全部数据为 JSON 备份文件并触发下载。

    ``mode`` 仅过滤 sessions（``mode`` 列）与 graphs（``type`` 列）及其级联子表；
    observations 无 mode 字段，始终全量导出。响应带 ``Content-Disposition`` 头，
    文件名形如 ``kwa_backup_YYYYMMDD_HHMMSS.json``。
    """
    if mode is not None and mode not in GRAPH_TYPES:
        raise _bad_request(f"非法模式: {mode}（允许: {GRAPH_TYPES}）")

    async with AsyncSessionLocal() as db:
        # sessions + 级联 messages / checkpoints
        sess_stmt = select(SessionRow)
        if mode is not None:
            sess_stmt = sess_stmt.where(SessionRow.mode == mode)
        session_rows = list((await db.execute(sess_stmt)).scalars().all())
        session_ids = [r.id for r in session_rows]

        if session_ids:
            msg_rows = list(
                (
                    await db.execute(
                        select(MessageRow).where(MessageRow.session_id.in_(session_ids))
                    )
                ).scalars().all()
            )
            ckpt_rows = list(
                (
                    await db.execute(
                        select(CheckpointRow).where(
                            CheckpointRow.session_id.in_(session_ids)
                        )
                    )
                ).scalars().all()
            )
        else:
            msg_rows = []
            ckpt_rows = []

        # graphs + 级联 nodes / edges / quizzes
        graph_stmt = select(GraphRow)
        if mode is not None:
            graph_stmt = graph_stmt.where(GraphRow.type == mode)
        graph_rows = list((await db.execute(graph_stmt)).scalars().all())
        graph_ids = [r.id for r in graph_rows]

        if graph_ids:
            node_rows = list(
                (
                    await db.execute(
                        select(NodeRow).where(NodeRow.graph_id.in_(graph_ids))
                    )
                ).scalars().all()
            )
            edge_rows = list(
                (
                    await db.execute(
                        select(EdgeRow).where(EdgeRow.graph_id.in_(graph_ids))
                    )
                ).scalars().all()
            )
            quiz_rows = list(
                (
                    await db.execute(
                        select(QuizRow).where(QuizRow.graph_id.in_(graph_ids))
                    )
                ).scalars().all()
            )
        else:
            node_rows = []
            edge_rows = []
            quiz_rows = []

        # observations：无 mode 字段，全量导出
        obs_rows = list((await db.execute(select(ObservationRow))).scalars().all())

    payload = {
        "version": 1,
        "exported_at": datetime.utcnow().isoformat(),
        "mode": mode,
        "sessions": [_row_to_dict(r) for r in session_rows],
        "messages": [_row_to_dict(r) for r in msg_rows],
        "checkpoints": [_row_to_dict(r) for r in ckpt_rows],
        "graphs": [_row_to_dict(r) for r in graph_rows],
        "nodes": [_row_to_dict(r) for r in node_rows],
        "edges": [_row_to_dict(r) for r in edge_rows],
        "quizzes": [_row_to_dict(r) for r in quiz_rows],
        "observations": [_row_to_dict(r) for r in obs_rows],
        "counts": {
            "sessions": len(session_rows),
            "messages": len(msg_rows),
            "checkpoints": len(ckpt_rows),
            "graphs": len(graph_rows),
            "nodes": len(node_rows),
            "edges": len(edge_rows),
            "quizzes": len(quiz_rows),
            "observations": len(obs_rows),
        },
    }

    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    filename = f"kwa_backup_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.json"
    # RFC5987 编码文件名，支持中文 / 特殊字符
    from urllib.parse import quote
    disposition = f"attachment; filename*=UTF-8''{quote(filename)}"

    logger.info(
        "导出数据备份 mode=%s sessions=%d graphs=%d observations=%d",
        mode,
        len(session_rows),
        len(graph_rows),
        len(obs_rows),
    )
    return Response(
        content=body,
        media_type="application/json",
        headers={"Content-Disposition": disposition},
    )


__all__ = ["router"]
