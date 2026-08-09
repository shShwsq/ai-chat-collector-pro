"""图谱存储层（Task 2.3）。

提供知识图谱（Graph / Node / Edge / Observation / Quiz）的 CRUD 接口，
作为路由层与 Agent 之间的中间层。所有方法均异步，使用 ``AsyncSessionLocal``
自行管理 session（与 :mod:`app.services.tag_store` 保持一致）。

设计要点：

1. **返回 dict 而非 ORM 实例**：避免懒加载在 session 关闭后触发 ``DetachedInstanceError``，
   所有查询结果在 session 内显式序列化为 ``dict[str, Any]``。

2. **JSON 字段透明序列化**：``detail_payload`` / ``user_fill`` / ``metadata_json`` /
   ``payload`` / ``result`` 在数据库中以 TEXT 存储，本层在读取时反序列化为 ``dict``，
   写入时序列化为 JSON 字符串，调用方无需关心序列化细节。

3. **节点类型校验**：``create_node`` / ``update_node`` 校验 ``node_type`` 在对应
   图谱模式的合法枚举内（见 :mod:`app.models.node_types`），非法类型抛
   ``ValueError``。

4. **图谱隔离**：所有节点 / 边 / 测验操作均通过 ``graph_id`` 关联到图谱，
   删除图谱时级联清理（``ondelete=CASCADE``）。``list_graphs`` 按模式过滤，
   确保 study 与 work 图谱互不互通。

5. **观察来源**：``create_observation`` 支持 plugin / import / manual 三种来源，
   ``mark_observation_processed`` 标记已被 Agent 处理，避免重复抽取。

6. **测验**：``create_quiz`` 由 Agent 生成题目，``update_quiz_result`` 记录用户
   作答结果与判分。
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import and_, bindparam, delete, func, or_, select, text
from sqlalchemy.orm import selectinload

from app.db import AsyncSessionLocal, with_sqlite_lock_retry
from app.models.db_models import Edge as EdgeRow
from app.models.db_models import Graph as GraphRow
from app.models.db_models import Node as NodeRow
from app.models.db_models import Observation as ObservationRow
from app.models.db_models import Quiz as QuizRow
from app.models.node_types import (
    EDGE_RELATED,
    GRAPH_TYPES,
    NODE_SOURCE_USER,
    OBSERVATION_SOURCE_MANUAL,
    OBSERVATION_SOURCES,
    QUIZ_TYPES,
    default_detail_payload,
    default_user_fill,
    is_valid_node_type,
)

logger = logging.getLogger(__name__)


def _now() -> datetime:
    """UTC 当前时间。"""
    return datetime.now(UTC)


def _new_id() -> str:
    """生成 32 位十六进制 ID（与步影 sessions / messages 风格一致）。"""
    return uuid.uuid4().hex


def _safe_json_loads(raw: str | None, default: Any) -> Any:
    """安全反序列化 JSON 字符串，失败返回 default。"""
    if not raw:
        return default
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return default


def _safe_json_dumps(value: Any) -> str:
    """序列化为 JSON 字符串，失败回退为 ``"{}"``。"""
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return "{}"


# ============================================================================
# Graph 序列化
# ============================================================================


def _graph_to_dict(row: GraphRow, *, include_nodes: bool = False) -> dict[str, Any]:
    """将 Graph ORM 行序列化为 dict。"""
    data: dict[str, Any] = {
        "id": row.id,
        "name": row.name,
        "type": row.type,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }
    if include_nodes:
        data["nodes"] = [_node_to_dict(n) for n in (row.nodes or [])]
        data["edges"] = [_edge_to_dict(e) for e in (row.edges or [])]
    return data


def _node_to_dict(row: NodeRow) -> dict[str, Any]:
    """将 Node ORM 行序列化为 dict（含 JSON 字段反序列化）。"""
    return {
        "id": row.id,
        "graph_id": row.graph_id,
        "type": row.type,
        "title": row.title,
        "summary": row.summary,
        "detail_payload": _safe_json_loads(row.detail_payload, {}),
        "is_gray": row.is_gray,
        "user_fill": _safe_json_loads(row.user_fill, {}),
        "source": row.source,
        "confidence": row.confidence,
        # 智能推荐相关字段（旧数据兜底取默认值）
        "last_reviewed_at": getattr(row, "last_reviewed_at", None),
        "review_count": getattr(row, "review_count", 0),
        "mention_count": getattr(row, "mention_count", 0),
        "remind_at": getattr(row, "remind_at", None),
        "is_starred": getattr(row, "is_starred", False),
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


def _edge_to_dict(row: EdgeRow) -> dict[str, Any]:
    """将 Edge ORM 行序列化为 dict。"""
    return {
        "id": row.id,
        "graph_id": row.graph_id,
        "src_id": row.src_id,
        "dst_id": row.dst_id,
        "relation": row.relation,
        "created_at": row.created_at,
    }


def _observation_to_dict(row: ObservationRow) -> dict[str, Any]:
    """将 Observation ORM 行序列化为 dict。"""
    return {
        "id": row.id,
        "platform": row.platform,
        "occurred_at": row.occurred_at,
        "conversation_markdown": row.conversation_markdown,
        "metadata": _safe_json_loads(row.metadata_json, {}),
        "source": row.source,
        "graph_id": row.graph_id,
        "processed": row.processed,
        "created_at": row.created_at,
    }


def _quiz_to_dict(row: QuizRow) -> dict[str, Any]:
    """将 Quiz ORM 行序列化为 dict。"""
    return {
        "id": row.id,
        "graph_id": row.graph_id,
        "node_id": row.node_id,
        "type": row.type,
        "payload": _safe_json_loads(row.payload, {}),
        "answer": row.answer,
        "result": _safe_json_loads(row.result, {}),
        "answered": row.answered,
        "created_at": row.created_at,
        "answered_at": row.answered_at,
    }


# ============================================================================
# GraphStore
# ============================================================================


class GraphStore:
    """知识图谱存储管理器。

    提供 Graph / Node / Edge / Observation / Quiz 五类实体的 CRUD 接口。
    所有方法均为 async，内部使用 ``AsyncSessionLocal`` 管理 session。
    """

    # ------------------------------------------------------------------
    # Graph CRUD
    # ------------------------------------------------------------------

    async def create_graph(
        self, name: str, graph_type: str
    ) -> dict[str, Any]:
        """创建图谱。

        Args:
            name: 图谱名称。
            graph_type: 图谱模式（``study`` / ``work``）。

        Returns:
            新建图谱的 dict。
        """
        if graph_type not in GRAPH_TYPES:
            raise ValueError(f"非法图谱类型: {graph_type}（允许: {GRAPH_TYPES}）")
        graph_id = _new_id()
        async with AsyncSessionLocal() as db:
            row = GraphRow(
                id=graph_id,
                name=name or "未命名图谱",
                type=graph_type,
            )
            db.add(row)
            await db.commit()
            return _graph_to_dict(row)

    async def get_graph(
        self, graph_id: str, *, include_nodes: bool = False
    ) -> dict[str, Any] | None:
        """获取图谱，不存在返回 None。

        ``include_nodes=True`` 时使用 ``selectinload`` 预加载 nodes / edges 关系，
        避免异步上下文触发懒加载抛 ``MissingGreenlet``。
        """
        async with AsyncSessionLocal() as db:
            stmt = select(GraphRow).where(GraphRow.id == graph_id)
            if include_nodes:
                stmt = stmt.options(
                    selectinload(GraphRow.nodes), selectinload(GraphRow.edges)
                )
            row = (await db.execute(stmt)).scalar_one_or_none()
            if row is None:
                return None
            return _graph_to_dict(row, include_nodes=include_nodes)

    async def list_graphs(self, graph_type: str | None = None) -> list[dict[str, Any]]:
        """列出图谱，可按模式过滤。

        Args:
            graph_type: 可选模式过滤（``study`` / ``work``），None 表示全部。

        Returns:
            图谱 dict 列表，按 ``updated_at`` 倒序。
        """
        async with AsyncSessionLocal() as db:
            stmt = select(GraphRow).order_by(GraphRow.updated_at.desc())
            if graph_type is not None:
                if graph_type not in GRAPH_TYPES:
                    raise ValueError(
                        f"非法图谱类型: {graph_type}（允许: {GRAPH_TYPES}）"
                    )
                stmt = stmt.where(GraphRow.type == graph_type)
            result = await db.execute(stmt)
            return [_graph_to_dict(r) for r in result.scalars().all()]

    async def rename_graph(self, graph_id: str, name: str) -> dict[str, Any] | None:
        """重命名图谱。不存在返回 None。"""
        async with AsyncSessionLocal() as db:
            stmt = select(GraphRow).where(GraphRow.id == graph_id)
            row = (await db.execute(stmt)).scalar_one_or_none()
            if row is None:
                return None
            row.name = name
            await db.commit()
            return _graph_to_dict(row)

    async def delete_graph(self, graph_id: str) -> bool:
        """删除图谱（级联清理节点 / 边 / 测验）。

        Returns:
            删除成功返回 True，图谱不存在返回 False。
        """
        async with AsyncSessionLocal() as db:
            stmt = select(GraphRow).where(GraphRow.id == graph_id)
            row = (await db.execute(stmt)).scalar_one_or_none()
            if row is None:
                return False
            await db.delete(row)
            await db.commit()
            return True

    async def delete_graphs_by_type(self, graph_type: str | None) -> int:
        """按 ``type`` 批量删除图谱（级联清理节点 / 边 / 测验）。

        ``graph_type`` 为 ``study`` / ``work`` 时仅删该模式；``None`` 删全部。
        observations 表的 ``graph_id`` 外键为 ``ondelete=SET NULL``，故相关
        observations 不会被删除，仅解绑（``graph_id`` 置空）。

        实现用单条 ``DELETE`` 语句（而非 ORM 逐行 ``db.delete``）：批量行数可能
        很大，逐行 flush 会触发 ``executemany`` 长事务持锁，叠加 FTS / 级联触发
        器易超 SQLite busy_timeout。DB 级 ``ondelete=CASCADE`` 仍会自动清理
        nodes / edges / quizzes。外层用 :func:`with_sqlite_lock_retry` 兜底
        瞬时锁冲突。

        Args:
            graph_type: 可选模式过滤，非法值抛 ``ValueError``。

        Returns:
            实际删除的图谱条数。
        """
        if graph_type is not None and graph_type not in GRAPH_TYPES:
            raise ValueError(
                f"非法图谱类型: {graph_type}（允许: {GRAPH_TYPES}）"
            )

        async def _bulk_delete() -> int:
            async with AsyncSessionLocal() as db:
                count_stmt = select(func.count()).select_from(GraphRow)
                if graph_type is not None:
                    count_stmt = count_stmt.where(GraphRow.type == graph_type)
                count = (await db.execute(count_stmt)).scalar_one()
                if count == 0:
                    return 0
                del_stmt = delete(GraphRow)
                if graph_type is not None:
                    del_stmt = del_stmt.where(GraphRow.type == graph_type)
                await db.execute(del_stmt)
                await db.commit()
                return count

        return await with_sqlite_lock_retry(_bulk_delete)

    # ------------------------------------------------------------------
    # Node CRUD
    # ------------------------------------------------------------------

    async def create_node(
        self,
        graph_id: str,
        node_type: str,
        title: str,
        *,
        summary: str = "",
        detail_payload: dict[str, Any] | None = None,
        is_gray: bool = False,
        user_fill: dict[str, Any] | None = None,
        source: str = NODE_SOURCE_USER,
        confidence: float = 1.0,
    ) -> dict[str, Any]:
        """创建节点。

        Args:
            graph_id: 所属图谱 ID。
            node_type: 节点子类型（Study 为学科，Work 为工作对象）。
            title: 节点标题（小卡片常显）。
            summary: 一句话概括。
            detail_payload: 详情字段 dict（不传则按类型模板初始化空值）。
            is_gray: 是否为延伸生成的灰色节点。
            user_fill: 用户留白 dict（不传则初始化默认结构）。
            source: 来源标记（agent / user / plugin / extension）。
            confidence: 置信度 0.0-1.0。

        Returns:
            新建节点的 dict。

        Raises:
            ValueError: 图谱不存在或节点类型与图谱模式不匹配。
        """
        async with AsyncSessionLocal() as db:
            # 校验图谱存在并获取模式
            graph = (
                await db.execute(select(GraphRow).where(GraphRow.id == graph_id))
            ).scalar_one_or_none()
            if graph is None:
                raise ValueError(f"图谱不存在: {graph_id}")

            if not is_valid_node_type(graph.type, node_type):
                raise ValueError(
                    f"节点类型 {node_type} 与图谱模式 {graph.type} 不匹配"
                )

            # 不传 detail_payload 时按模板初始化空值
            if detail_payload is None:
                detail_payload = default_detail_payload(graph.type, node_type)

            if user_fill is None:
                user_fill = default_user_fill()

            node_id = _new_id()
            row = NodeRow(
                id=node_id,
                graph_id=graph_id,
                type=node_type,
                title=title,
                summary=summary,
                detail_payload=_safe_json_dumps(detail_payload),
                is_gray=is_gray,
                user_fill=_safe_json_dumps(user_fill),
                source=source,
                confidence=max(0.0, min(1.0, float(confidence))),
                # 智能推荐字段创建时取默认值
                last_reviewed_at=None,
                review_count=0,
                mention_count=0,
                remind_at=None,
                is_starred=False,
            )
            db.add(row)
            await db.commit()
            return _node_to_dict(row)

    async def get_node(self, node_id: str) -> dict[str, Any] | None:
        """获取节点，不存在返回 None。"""
        async with AsyncSessionLocal() as db:
            stmt = select(NodeRow).where(NodeRow.id == node_id)
            row = (await db.execute(stmt)).scalar_one_or_none()
            if row is None:
                return None
            return _node_to_dict(row)

    async def list_nodes(
        self, graph_id: str, *, node_type: str | None = None
    ) -> list[dict[str, Any]]:
        """列出图谱下的节点，可按类型过滤。

        Args:
            graph_id: 图谱 ID。
            node_type: 可选节点类型过滤。

        Returns:
            节点 dict 列表，按 ``created_at`` 升序。
        """
        async with AsyncSessionLocal() as db:
            stmt = (
                select(NodeRow)
                .where(NodeRow.graph_id == graph_id)
                .order_by(NodeRow.created_at.asc())
            )
            if node_type is not None:
                stmt = stmt.where(NodeRow.type == node_type)
            result = await db.execute(stmt)
            return [_node_to_dict(r) for r in result.scalars().all()]

    async def update_node(
        self,
        node_id: str,
        *,
        title: str | None = None,
        summary: str | None = None,
        detail_payload: dict[str, Any] | None = None,
        is_gray: bool | None = None,
        user_fill: dict[str, Any] | None = None,
        node_type: str | None = None,
        confidence: float | None = None,
    ) -> dict[str, Any] | None:
        """更新节点字段（仅更新非 None 参数）。不存在返回 None。

        Raises:
            ValueError: 切换节点类型后与图谱模式不匹配。
        """
        async with AsyncSessionLocal() as db:
            stmt = select(NodeRow).where(NodeRow.id == node_id)
            row = (await db.execute(stmt)).scalar_one_or_none()
            if row is None:
                return None

            # 校验类型切换
            if node_type is not None and node_type != row.type:
                graph = (
                    await db.execute(
                        select(GraphRow).where(GraphRow.id == row.graph_id)
                    )
                ).scalar_one_or_none()
                if graph is not None and not is_valid_node_type(graph.type, node_type):
                    raise ValueError(
                        f"节点类型 {node_type} 与图谱模式 {graph.type} 不匹配"
                    )
                row.type = node_type

            if title is not None:
                row.title = title
            if summary is not None:
                row.summary = summary
            if detail_payload is not None:
                # 合并已有 detail_payload，避免部分更新丢失字段
                existing = _safe_json_loads(row.detail_payload, {})
                existing.update(detail_payload)
                row.detail_payload = _safe_json_dumps(existing)
            if is_gray is not None:
                row.is_gray = is_gray
            if user_fill is not None:
                # 合并已有 user_fill
                existing = _safe_json_loads(row.user_fill, {})
                existing.update(user_fill)
                row.user_fill = _safe_json_dumps(existing)
            if confidence is not None:
                row.confidence = max(0.0, min(1.0, float(confidence)))

            await db.commit()
            return _node_to_dict(row)

    async def delete_node(self, node_id: str) -> bool:
        """删除节点（级联清理相关边与测验）。

        Returns:
            删除成功返回 True，节点不存在返回 False。
        """
        async with AsyncSessionLocal() as db:
            stmt = select(NodeRow).where(NodeRow.id == node_id)
            row = (await db.execute(stmt)).scalar_one_or_none()
            if row is None:
                return False
            await db.delete(row)
            await db.commit()
            return True

    async def append_user_fill(
        self,
        node_id: str,
        fill_type: str,
        content: str,
    ) -> dict[str, Any] | None:
        """向节点 user_fill 的指定类型追加一条内容。

        Args:
            node_id: 节点 ID。
            fill_type: 留白类型（doubt/association/exam_point/error_point/note）。
            content: 留白内容。

        Returns:
            更新后的节点 dict。节点不存在返回 None。
        """
        from app.models.node_types import USER_FILL_TYPES

        if fill_type not in USER_FILL_TYPES:
            raise ValueError(
                f"非法留白类型: {fill_type}（允许: {USER_FILL_TYPES}）"
            )

        async with AsyncSessionLocal() as db:
            stmt = select(NodeRow).where(NodeRow.id == node_id)
            row = (await db.execute(stmt)).scalar_one_or_none()
            if row is None:
                return None
            user_fill = _safe_json_loads(row.user_fill, default_user_fill())
            # 确保所有类型 key 存在
            for t in USER_FILL_TYPES:
                user_fill.setdefault(t, [])
            user_fill.setdefault(fill_type, []).append(content)
            row.user_fill = _safe_json_dumps(user_fill)
            await db.commit()
            return _node_to_dict(row)

    # ------------------------------------------------------------------
    # 节点行为字段（复习追踪 / 提醒 / 星标 / 提及计数）
    # ------------------------------------------------------------------

    async def touch_node(self, node_id: str) -> dict[str, Any] | None:
        """复习追踪：更新 ``last_reviewed_at`` 为当前时间，``review_count`` +1。

        用户打开节点详情卡时调用，用于追踪复习行为与智能推荐权重。

        Returns:
            更新后的节点 dict。节点不存在返回 None。
        """
        async with AsyncSessionLocal() as db:
            stmt = select(NodeRow).where(NodeRow.id == node_id)
            row = (await db.execute(stmt)).scalar_one_or_none()
            if row is None:
                return None
            row.last_reviewed_at = _now()
            row.review_count = (row.review_count or 0) + 1
            await db.commit()
            return _node_to_dict(row)

    async def set_remind(
        self, node_id: str, remind_at: datetime | None
    ) -> dict[str, Any] | None:
        """设置节点提醒时间（Work 模式节点用）。

        Args:
            node_id: 节点 ID。
            remind_at: 提醒时间。传 None 等价于 :meth:`clear_remind`。

        Returns:
            更新后的节点 dict。节点不存在返回 None。
        """
        async with AsyncSessionLocal() as db:
            stmt = select(NodeRow).where(NodeRow.id == node_id)
            row = (await db.execute(stmt)).scalar_one_or_none()
            if row is None:
                return None
            row.remind_at = remind_at
            await db.commit()
            return _node_to_dict(row)

    async def clear_remind(self, node_id: str) -> dict[str, Any] | None:
        """清除节点提醒时间（置 null）。

        Returns:
            更新后的节点 dict。节点不存在返回 None。
        """
        async with AsyncSessionLocal() as db:
            stmt = select(NodeRow).where(NodeRow.id == node_id)
            row = (await db.execute(stmt)).scalar_one_or_none()
            if row is None:
                return None
            row.remind_at = None
            await db.commit()
            return _node_to_dict(row)

    async def set_star(
        self, node_id: str, is_starred: bool
    ) -> dict[str, Any] | None:
        """设置节点星标状态。

        Args:
            node_id: 节点 ID。
            is_starred: 是否星标。

        Returns:
            更新后的节点 dict。节点不存在返回 None。
        """
        async with AsyncSessionLocal() as db:
            stmt = select(NodeRow).where(NodeRow.id == node_id)
            row = (await db.execute(stmt)).scalar_one_or_none()
            if row is None:
                return None
            row.is_starred = bool(is_starred)
            await db.commit()
            return _node_to_dict(row)

    async def incr_mention(self, node_id: str) -> dict[str, Any] | None:
        """节点提及计数 +1。

        Agent 抽取 / 延伸 / 提问命中节点时调用，用于智能推荐权重计算。
        节点不存在时静默返回 None（不阻断 Agent 主流程）。

        Returns:
            更新后的节点 dict。节点不存在返回 None。
        """
        async with AsyncSessionLocal() as db:
            stmt = select(NodeRow).where(NodeRow.id == node_id)
            row = (await db.execute(stmt)).scalar_one_or_none()
            if row is None:
                return None
            row.mention_count = (row.mention_count or 0) + 1
            await db.commit()
            return _node_to_dict(row)

    # ------------------------------------------------------------------
    # Edge CRUD
    # ------------------------------------------------------------------

    async def create_edge(
        self,
        graph_id: str,
        src_id: str,
        dst_id: str,
        *,
        relation: str = EDGE_RELATED,
    ) -> dict[str, Any]:
        """创建无向边。

        Args:
            graph_id: 所属图谱 ID。
            src_id: 源节点 ID。
            dst_id: 目标节点 ID。
            relation: 边关系语义（默认 ``related``）。

        Returns:
            新建边的 dict。

        Raises:
            ValueError: 图谱或节点不存在，或节点不属于该图谱。
        """
        src_id, dst_id = sorted((src_id, dst_id))
        async with AsyncSessionLocal() as db:
            # 校验图谱存在
            graph = (
                await db.execute(select(GraphRow).where(GraphRow.id == graph_id))
            ).scalar_one_or_none()
            if graph is None:
                raise ValueError(f"图谱不存在: {graph_id}")

            # 校验两端节点存在且属于该图谱
            for nid in (src_id, dst_id):
                node = (
                    await db.execute(
                        select(NodeRow).where(
                            and_(NodeRow.id == nid, NodeRow.graph_id == graph_id)
                        )
                    )
                ).scalar_one_or_none()
                if node is None:
                    raise ValueError(f"节点 {nid} 不属于图谱 {graph_id}")

            # 去重：同图谱同两端同关系的边不重复创建
            existing = (
                await db.execute(
                    select(EdgeRow).where(
                        and_(
                            EdgeRow.graph_id == graph_id,
                            EdgeRow.src_id == src_id,
                            EdgeRow.dst_id == dst_id,
                            EdgeRow.relation == relation,
                        )
                    )
                )
            ).scalar_one_or_none()
            if existing is not None:
                return _edge_to_dict(existing)

            edge_id = _new_id()
            row = EdgeRow(
                id=edge_id,
                graph_id=graph_id,
                src_id=src_id,
                dst_id=dst_id,
                relation=relation,
            )
            db.add(row)
            await db.commit()
            return _edge_to_dict(row)

    async def list_edges(self, graph_id: str) -> list[dict[str, Any]]:
        """列出图谱下的全部边。"""
        async with AsyncSessionLocal() as db:
            stmt = (
                select(EdgeRow)
                .where(EdgeRow.graph_id == graph_id)
                .order_by(EdgeRow.created_at.asc())
            )
            result = await db.execute(stmt)
            return [_edge_to_dict(r) for r in result.scalars().all()]

    async def delete_edge(self, edge_id: str) -> bool:
        """删除边。不存在返回 False。"""
        async with AsyncSessionLocal() as db:
            stmt = select(EdgeRow).where(EdgeRow.id == edge_id)
            row = (await db.execute(stmt)).scalar_one_or_none()
            if row is None:
                return False
            await db.delete(row)
            await db.commit()
            return True

    async def delete_edges_of_node(self, node_id: str) -> int:
        """删除节点的全部相关边（节点删除前调用）。返回删除条数。"""
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                delete(EdgeRow).where(
                    or_(EdgeRow.src_id == node_id, EdgeRow.dst_id == node_id)
                )
            )
            await db.commit()
            return int(result.rowcount or 0)

    # ------------------------------------------------------------------
    # Observation CRUD
    # ------------------------------------------------------------------

    async def create_observation(
        self,
        conversation_markdown: str,
        *,
        platform: str = "manual",
        source: str = OBSERVATION_SOURCE_MANUAL,
        occurred_at: datetime | None = None,
        metadata: dict[str, Any] | None = None,
        graph_id: str | None = None,
        dedup_key: str | None = None,
    ) -> dict[str, Any]:
        """创建观察记录（原始对话）。

        Args:
            conversation_markdown: 对话原文 Markdown。
            platform: 来源平台（deepseek / qwen / doubao / kimi / yuanbao /
                wenxin / manual / import）。
            source: 来源标记（plugin / import / manual）。
            occurred_at: 对话发生时间（可空）。
            metadata: 附加元数据。
            graph_id: 关联图谱（可选）。

        Returns:
            新建观察的 dict。
        """
        if source not in OBSERVATION_SOURCES:
            raise ValueError(f"非法观察来源: {source}（允许: {OBSERVATION_SOURCES}）")

        observation_id = _new_id()
        async def _insert() -> dict[str, Any]:
            async with AsyncSessionLocal() as db:
                row = ObservationRow(
                    id=observation_id,
                    platform=platform,
                    occurred_at=occurred_at,
                    conversation_markdown=conversation_markdown,
                    metadata_json=_safe_json_dumps(metadata or {}),
                    dedup_key=dedup_key,
                    source=source,
                    graph_id=graph_id,
                    processed=False,
                )
                db.add(row)
                try:
                    await db.commit()
                except Exception:
                    await db.rollback()
                    raise
                return _observation_to_dict(row)

        return await with_sqlite_lock_retry(_insert)

    async def create_observations_batch(
        self,
        items: list[dict[str, Any]],
        *,
        platform: str = "manual",
        source: str = OBSERVATION_SOURCE_MANUAL,
        within_hours: int = 24,
    ) -> dict[str, Any]:
        """批量创建观察记录（单事务 + FTS5 触发器临时禁用）。

        用于手动导入大量对话时避免逐条 HTTP / 逐条 commit 的开销，把整批放进
        **一个事务**一次提交，并临时禁用 ``observations_ai`` 触发器、插入后用一条
        ``INSERT INTO observations_fts SELECT ...`` 批量回填全文索引，再重建触发器。

        SQLite 的 DDL 是事务性的：若事务回滚，``DROP TRIGGER`` 也会回滚，触发器
        自动恢复，因此即使中途失败也不会留下「触发器被删除」的破损状态。

        Args:
            items: 每项形如
                ``{conversation_markdown, occurred_at, metadata, dedup_key}``。
            platform: 来源平台。
            source: 来源标记（plugin / import / manual）。
            within_hours: 幂等去重时间窗口（小时）。

        Returns:
            ``{imported, deduplicated, failed, errors, imported_ids}``。
        """
        if source not in OBSERVATION_SOURCES:
            raise ValueError(f"非法观察来源: {source}（允许: {OBSERVATION_SOURCES}）")

        # 预收集所有非空 dedup_key，一次性查 24h 内已存在的，避免逐条查询
        all_keys = [it["dedup_key"] for it in items if it.get("dedup_key")]

        async def _bulk() -> dict[str, Any]:
            async with AsyncSessionLocal() as db:
                cutoff = _now() - timedelta(hours=max(1, int(within_hours)))
                existing_keys: set[str] = set()
                # 分块查询避免 IN 列表过长（SQLite 变量数上限）
                for i in range(0, len(all_keys), 500):
                    chunk = all_keys[i : i + 500]
                    stmt = select(ObservationRow.dedup_key).where(
                        ObservationRow.dedup_key.in_(chunk),
                        ObservationRow.created_at >= cutoff,
                    )
                    rows = await db.execute(stmt)
                    existing_keys.update(r[0] for r in rows)

                seen_in_batch: set[str] = set()
                rows_to_add: list[ObservationRow] = []
                imported_ids: list[str] = []
                deduplicated = 0

                for it in items:
                    dk = it.get("dedup_key")
                    if dk and (dk in existing_keys or dk in seen_in_batch):
                        deduplicated += 1
                        continue
                    if dk:
                        seen_in_batch.add(dk)
                    row_id = _new_id()
                    rows_to_add.append(
                        ObservationRow(
                            id=row_id,
                            platform=platform,
                            occurred_at=it.get("occurred_at"),
                            conversation_markdown=it["conversation_markdown"],
                            metadata_json=_safe_json_dumps(it.get("metadata") or {}),
                            dedup_key=dk,
                            source=source,
                            graph_id=None,
                            processed=False,
                        )
                    )
                    imported_ids.append(row_id)

                # 检测 observations_fts 是否存在（FTS5 不可用时表与触发器均未创建）
                fts_exists = (
                    await db.execute(
                        text(
                            "SELECT name FROM sqlite_master "
                            "WHERE type='table' AND name='observations_fts'"
                        )
                    )
                ).first() is not None

                if fts_exists:
                    # 临时禁用 AFTER INSERT 触发器，避免逐行回填 FTS（批量回填更快）
                    await db.execute(text("DROP TRIGGER IF EXISTS observations_ai"))

                db.add_all(rows_to_add)
                await db.flush()  # 写入但未提交，使后续 raw SQL 能读到新行

                if fts_exists and imported_ids:
                    # 一条 INSERT...SELECT 批量回填全文索引（分块避免绑定变量过多）
                    populate_sql = text(
                        "INSERT INTO observations_fts(row_id, conversation_markdown) "
                        "SELECT id, conversation_markdown FROM observations "
                        "WHERE id IN :ids"
                    ).bindparams(bindparam("ids", expanding=True))
                    for i in range(0, len(imported_ids), 500):
                        await db.execute(
                            populate_sql, {"ids": imported_ids[i : i + 500]}
                        )
                    # 重建触发器，恢复后续单条插入的自动同步
                    await db.execute(
                        text(
                            "CREATE TRIGGER IF NOT EXISTS observations_ai "
                            "AFTER INSERT ON observations BEGIN "
                            "INSERT INTO observations_fts(row_id, conversation_markdown) "
                            "VALUES (NEW.id, NEW.conversation_markdown); END"
                        )
                    )

                await db.commit()
                return {
                    "imported": len(imported_ids),
                    "deduplicated": deduplicated,
                    "failed": 0,
                    "errors": [],
                    "imported_ids": imported_ids,
                }

        # 批量为单事务、单写者，锁冲突极少；仍保留重试以应对极端情况
        return await with_sqlite_lock_retry(_bulk)

    async def update_observation_by_dedup_key(
        self,
        dedup_key: str,
        *,
        conversation_markdown: str,
        occurred_at: datetime | None,
        metadata: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        async def _update() -> dict[str, Any] | None:
            async with AsyncSessionLocal() as db:
                stmt = select(ObservationRow).where(ObservationRow.dedup_key == dedup_key)
                row = (await db.execute(stmt)).scalar_one_or_none()
                if row is None:
                    return None
                row.conversation_markdown = conversation_markdown
                row.occurred_at = occurred_at
                row.metadata_json = _safe_json_dumps(metadata or {})
                row.processed = False
                try:
                    await db.commit()
                except Exception:
                    await db.rollback()
                    raise
                return _observation_to_dict(row)

        return await with_sqlite_lock_retry(_update)

    async def get_observation(self, observation_id: str) -> dict[str, Any] | None:
        """获取观察记录。不存在返回 None。"""
        async with AsyncSessionLocal() as db:
            stmt = select(ObservationRow).where(ObservationRow.id == observation_id)
            row = (await db.execute(stmt)).scalar_one_or_none()
            if row is None:
                return None
            return _observation_to_dict(row)

    async def list_observations(
        self,
        *,
        graph_id: str | None = None,
        source: str | None = None,
        processed: bool | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """列出观察记录，支持按图谱 / 来源 / 处理状态过滤。

        Args:
            graph_id: 可选图谱过滤。
            source: 可选来源过滤。
            processed: 可选处理状态过滤（True 仅已处理，False 仅未处理，None 全部）。
            limit: 分页大小（默认 100，上限 10000，仅作防滥用兜底，不实质限制）。
            offset: 偏移量。

        Returns:
            观察 dict 列表，按 ``created_at`` 倒序（最新在前）。
        """
        limit = max(1, min(10000, int(limit)))
        offset = max(0, int(offset))
        async with AsyncSessionLocal() as db:
            stmt = select(ObservationRow).order_by(
                ObservationRow.created_at.desc()
            )
            if graph_id is not None:
                stmt = stmt.where(ObservationRow.graph_id == graph_id)
            if source is not None:
                stmt = stmt.where(ObservationRow.source == source)
            if processed is not None:
                stmt = stmt.where(ObservationRow.processed == processed)
            stmt = stmt.limit(limit).offset(offset)
            result = await db.execute(stmt)
            return [_observation_to_dict(r) for r in result.scalars().all()]

    async def count_observations(
        self,
        *,
        graph_id: str | None = None,
        source: str | None = None,
        processed: bool | None = None,
    ) -> int:
        """返回与 :meth:`list_observations` 相同过滤条件下的记录总数。

        供路由层分页接口返回 ``total``，前端据此计算页数与判断批量抽取规模。
        与 :meth:`list_observations` 共享 where 条件，但不应用 limit / offset。

        Args:
            graph_id: 可选图谱过滤。
            source: 可选来源过滤。
            processed: 可选处理状态过滤（True 仅已处理，False 仅未处理，None 全部）。

        Returns:
            符合过滤条件的记录总数。
        """
        async with AsyncSessionLocal() as db:
            stmt = select(func.count(ObservationRow.id))
            if graph_id is not None:
                stmt = stmt.where(ObservationRow.graph_id == graph_id)
            if source is not None:
                stmt = stmt.where(ObservationRow.source == source)
            if processed is not None:
                stmt = stmt.where(ObservationRow.processed == processed)
            total = await db.scalar(stmt)
            return int(total or 0)

    async def list_observations_by_source(
        self,
        source: str,
        *,
        limit: int = 20,
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        """列出指定来源的观察记录，按 ``created_at`` 倒序。

        相比 :meth:`list_observations`，本方法专用于按 ``source`` 单一维度
        过滤（如 ``source='plugin'``），签名更简洁，供「最近插件推送记录」
        等场景使用。

        Args:
            source: 来源标记（plugin / import / manual）。
            limit: 分页大小（默认 20，上限 500）。
            offset: 偏移量。

        Returns:
            观察 dict 列表，按 ``created_at`` 倒序（最新在前）。
        """
        limit = max(1, min(500, int(limit)))
        offset = max(0, int(offset))
        async with AsyncSessionLocal() as db:
            stmt = (
                select(ObservationRow)
                .where(ObservationRow.source == source)
                .order_by(ObservationRow.created_at.desc())
                .limit(limit)
                .offset(offset)
            )
            result = await db.execute(stmt)
            return [_observation_to_dict(r) for r in result.scalars().all()]

    async def find_observation_by_dedup_key(
        self,
        dedup_key: str,
        *,
        within_hours: int = 24,
    ) -> dict[str, Any] | None:
        """查找最近 ``within_hours`` 小时内同 ``dedup_key`` 的观察记录。

        ``dedup_key`` 存储在独立索引列中，历史数据由启动迁移从
        ``metadata_json._dedup_key`` 回填。

        Args:
            dedup_key: 幂等去重键（如 ``"chatgpt:conv-abc123"``）。
            within_hours: 时间窗口（小时），仅匹配该窗口内的记录，默认 24。

        Returns:
            命中的观察 dict；未命中返回 None。
        """
        within_hours = max(1, int(within_hours))
        cutoff = _now() - timedelta(hours=within_hours)
        async with AsyncSessionLocal() as db:
            stmt = (
                select(ObservationRow)
                .where(ObservationRow.dedup_key == dedup_key)
                .where(ObservationRow.created_at >= cutoff)
                .order_by(ObservationRow.created_at.desc())
                .limit(1)
            )
            row = (await db.execute(stmt, {"dk": dedup_key})).scalar_one_or_none()
            if row is None:
                return None
            return _observation_to_dict(row)

    async def mark_observation_processed(
        self,
        observation_id: str,
        *,
        graph_id: str | None = None,
    ) -> dict[str, Any] | None:
        """标记观察为已处理（Agent 抽取节点后调用）。

        Args:
            observation_id: 观察 ID。
            graph_id: 可选，同时更新关联图谱。

        Returns:
            更新后的观察 dict。不存在返回 None。
        """
        async with AsyncSessionLocal() as db:
            stmt = select(ObservationRow).where(ObservationRow.id == observation_id)
            row = (await db.execute(stmt)).scalar_one_or_none()
            if row is None:
                return None
            row.processed = True
            if graph_id is not None:
                row.graph_id = graph_id
            await db.commit()
            return _observation_to_dict(row)

    async def delete_observation(self, observation_id: str) -> bool:
        """删除观察记录。不存在返回 False。"""
        async with AsyncSessionLocal() as db:
            stmt = select(ObservationRow).where(ObservationRow.id == observation_id)
            row = (await db.execute(stmt)).scalar_one_or_none()
            if row is None:
                return False
            await db.delete(row)
            await db.commit()
            return True

    async def delete_observations_by_source(self, source: str | None) -> int:
        """按 ``source`` 批量删除观察记录。

        observations 表无 mode 字段，故按来源（``plugin`` / ``import`` /
        ``manual``）过滤；``source=None`` 删全部。observations 是抽取图谱的
        源材料，与图谱解耦（删图谱时 ``graph_id`` 被 SET NULL），故本方法
        不影响图谱数据。

        实现用单条 ``DELETE`` 语句（而非 ORM 逐行 ``db.delete``）：observations
        可能积累数千条，逐行 flush 会触发 ``executemany`` 长事务持锁，叠加
        ``observations_ad`` FTS 触发器（每行删一次 ``observations_fts``）易超
        SQLite busy_timeout（实测 3046 条触发 ``database is locked``）。单条
        bulk DELETE 在 SQLite 内部一次性执行 + 触发触发器，持锁时间大幅缩短；
        外层用 :func:`with_sqlite_lock_retry` 兜底瞬时锁冲突。

        Args:
            source: 可选来源过滤，非法值抛 ``ValueError``。

        Returns:
            实际删除的观察记录条数。
        """
        if source is not None and source not in OBSERVATION_SOURCES:
            raise ValueError(
                f"非法观察来源: {source}（允许: {OBSERVATION_SOURCES}）"
            )

        async def _bulk_delete() -> int:
            async with AsyncSessionLocal() as db:
                count_stmt = select(func.count()).select_from(ObservationRow)
                if source is not None:
                    count_stmt = count_stmt.where(ObservationRow.source == source)
                count = (await db.execute(count_stmt)).scalar_one()
                if count == 0:
                    return 0
                del_stmt = delete(ObservationRow)
                if source is not None:
                    del_stmt = del_stmt.where(ObservationRow.source == source)
                await db.execute(del_stmt)
                await db.commit()
                return count

        return await with_sqlite_lock_retry(_bulk_delete)

    async def search_observations(
        self, query: str, *, limit: int = 20
    ) -> list[dict[str, Any]]:
        """通过 FTS5 检索观察记录（供 Agent 抽取节点时复用历史对话）。

        Args:
            query: 检索词。
            limit: 返回条数上限。

        Returns:
            匹配的观察 dict 列表。FTS5 不可用时回退 LIKE 匹配。
        """
        limit = max(1, min(100, int(limit)))
        async with AsyncSessionLocal() as db:
            # 优先 FTS5
            try:
                fts_stmt = text(
                    "SELECT row_id FROM observations_fts "
                    "WHERE observations_fts MATCH :q LIMIT :limit"
                )
                fts_result = await db.execute(
                    fts_stmt,
                    {"q": query, "limit": limit},
                )
                ids = [r[0] for r in fts_result.all()]
                if ids:
                    stmt = (
                        select(ObservationRow)
                        .where(ObservationRow.id.in_(ids))
                        .order_by(ObservationRow.created_at.desc())
                    )
                    result = await db.execute(stmt)
                    return [_observation_to_dict(r) for r in result.scalars().all()]
            except Exception as exc:  # noqa: BLE001
                logger.debug("FTS5 检索 observations 失败，回退 LIKE: %s", exc)

            # 回退 LIKE 匹配
            stmt = (
                select(ObservationRow)
                .where(ObservationRow.conversation_markdown.like(f"%{query}%"))
                .order_by(ObservationRow.created_at.desc())
                .limit(limit)
            )
            result = await db.execute(stmt)
            return [_observation_to_dict(r) for r in result.scalars().all()]

    # ------------------------------------------------------------------
    # Quiz CRUD
    # ------------------------------------------------------------------

    async def create_quiz(
        self,
        graph_id: str,
        node_id: str,
        quiz_type: str,
        *,
        payload: dict[str, Any] | None = None,
        answer: str = "",
    ) -> dict[str, Any]:
        """创建测验题目。

        Args:
            graph_id: 所属图谱 ID。
            node_id: 关联节点 ID。
            quiz_type: 题型（single_choice / multi_choice / feynman）。
            payload: 题目 JSON（题干 + 选项 / 提示）。
            answer: 标准答案。

        Returns:
            新建测验的 dict。

        Raises:
            ValueError: 题型非法，或图谱 / 节点不存在。
        """
        if quiz_type not in QUIZ_TYPES:
            raise ValueError(f"非法题型: {quiz_type}（允许: {QUIZ_TYPES}）")

        async with AsyncSessionLocal() as db:
            # 校验图谱存在
            graph = (
                await db.execute(select(GraphRow).where(GraphRow.id == graph_id))
            ).scalar_one_or_none()
            if graph is None:
                raise ValueError(f"图谱不存在: {graph_id}")

            # 校验节点存在且属于该图谱
            node = (
                await db.execute(
                    select(NodeRow).where(
                        and_(NodeRow.id == node_id, NodeRow.graph_id == graph_id)
                    )
                )
            ).scalar_one_or_none()
            if node is None:
                raise ValueError(f"节点 {node_id} 不属于图谱 {graph_id}")

            quiz_id = _new_id()
            row = QuizRow(
                id=quiz_id,
                graph_id=graph_id,
                node_id=node_id,
                type=quiz_type,
                payload=_safe_json_dumps(payload or {}),
                answer=answer,
                result="{}",
                answered=False,
            )
            db.add(row)
            await db.commit()
            return _quiz_to_dict(row)

    async def get_quiz(self, quiz_id: str) -> dict[str, Any] | None:
        """获取测验题目。不存在返回 None。"""
        async with AsyncSessionLocal() as db:
            stmt = select(QuizRow).where(QuizRow.id == quiz_id)
            row = (await db.execute(stmt)).scalar_one_or_none()
            if row is None:
                return None
            return _quiz_to_dict(row)

    async def list_quizzes(
        self,
        *,
        graph_id: str | None = None,
        node_id: str | None = None,
        answered: bool | None = None,
    ) -> list[dict[str, Any]]:
        """列出测验题目，可按图谱 / 节点 / 作答状态过滤。

        Args:
            graph_id: 可选图谱过滤。
            node_id: 可选节点过滤。
            answered: 可选作答状态过滤（True 仅已答，False 仅未答，None 全部）。

        Returns:
            测验 dict 列表，按 ``created_at`` 倒序。
        """
        async with AsyncSessionLocal() as db:
            stmt = select(QuizRow).order_by(QuizRow.created_at.desc())
            if graph_id is not None:
                stmt = stmt.where(QuizRow.graph_id == graph_id)
            if node_id is not None:
                stmt = stmt.where(QuizRow.node_id == node_id)
            if answered is not None:
                stmt = stmt.where(QuizRow.answered == answered)
            result = await db.execute(stmt)
            return [_quiz_to_dict(r) for r in result.scalars().all()]

    async def update_quiz_result(
        self,
        quiz_id: str,
        result: dict[str, Any],
        *,
        answer: str | None = None,
    ) -> dict[str, Any] | None:
        """更新测验作答结果（用户作答后调用）。

        Args:
            quiz_id: 测验 ID。
            result: 作答结果 JSON（用户答案 + 得分 + 解析 + Agent 反馈）。
            answer: 可选，更新标准答案。

        Returns:
            更新后的测验 dict。不存在返回 None。
        """
        async with AsyncSessionLocal() as db:
            stmt = select(QuizRow).where(QuizRow.id == quiz_id)
            row = (await db.execute(stmt)).scalar_one_or_none()
            if row is None:
                return None
            row.result = _safe_json_dumps(result)
            row.answered = True
            row.answered_at = _now()
            if answer is not None:
                row.answer = answer
            await db.commit()
            return _quiz_to_dict(row)

    async def delete_quiz(self, quiz_id: str) -> bool:
        """删除测验题目。不存在返回 False。"""
        async with AsyncSessionLocal() as db:
            stmt = select(QuizRow).where(QuizRow.id == quiz_id)
            row = (await db.execute(stmt)).scalar_one_or_none()
            if row is None:
                return False
            await db.delete(row)
            await db.commit()
            return True

    # ------------------------------------------------------------------
    # 聚合查询
    # ------------------------------------------------------------------

    async def get_graph_stats(self, graph_id: str) -> dict[str, int]:
        """获取图谱统计：节点数 / 边数 / 测验数。"""
        async with AsyncSessionLocal() as db:
            node_count = (
                await db.execute(
                    select(func.count(NodeRow.id)).where(NodeRow.graph_id == graph_id)
                )
            ).scalar() or 0
            edge_count = (
                await db.execute(
                    select(func.count(EdgeRow.id)).where(EdgeRow.graph_id == graph_id)
                )
            ).scalar() or 0
            quiz_count = (
                await db.execute(
                    select(func.count(QuizRow.id)).where(QuizRow.graph_id == graph_id)
                )
            ).scalar() or 0
            return {
                "node_count": int(node_count),
                "edge_count": int(edge_count),
                "quiz_count": int(quiz_count),
            }

    async def get_full_graph(self, graph_id: str) -> dict[str, Any] | None:
        """获取完整图谱（含节点与边），供前端可视化一次性加载。

        使用 ``selectinload`` 显式预加载 ``nodes`` / ``edges`` 关系，避免异步
        上下文中触发懒加载（会抛 ``MissingGreenlet``）。

        Returns:
            ``{graph, nodes, edges, stats}`` 形式的 dict。图谱不存在返回 None。
        """
        async with AsyncSessionLocal() as db:
            stmt = (
                select(GraphRow)
                .where(GraphRow.id == graph_id)
                .options(selectinload(GraphRow.nodes), selectinload(GraphRow.edges))
            )
            graph = (await db.execute(stmt)).scalar_one_or_none()
            if graph is None:
                return None
            # 关系已通过 selectinload 预加载，可安全访问
            nodes = list(graph.nodes)
            edges = list(graph.edges)
            stats = await self.get_graph_stats(graph_id)
            return {
                "graph": _graph_to_dict(graph),
                "nodes": [_node_to_dict(n) for n in nodes],
                "edges": [_edge_to_dict(e) for e in edges],
                "stats": stats,
            }


#: 全局单例（与步影 ``tag_store`` / ``knowledge_store`` 风格一致）
graph_store = GraphStore()
