"""智能推荐路由（Task 5）。

提供基于学习模式与工作模式的节点推荐接口，挂载在 ``/api`` 前缀下：

- ``GET /api/graphs/{graph_id}/recommendations?mode=study|work&limit=20``
  按模式计算推荐分并返回排序后的节点列表。

学习模式（study）推荐分算法（综合分 0-100，三项指标）：

1. **遗忘分（forgetting_score, 0-40）**：基于 ``last_reviewed_at`` 距今天数
   ``days_since`` 与 ``review_count``。
   - 从未复习（``last_reviewed_at`` 为 null）：满分 40
   - 否则：``min(40, days_since * 2 * (1 - review_count * 0.1))``，最低 0 分
   - ``review_count`` 越多衰减越慢（已熟练），``days_since`` 越久分越高
2. **热度分（heat_score, 0-20）**：基于 ``mention_count``。
   - ``score = max(0, 20 - mention_count * 2)``（热度越低分越高）
   - ``mention_count > 10`` 时给 5 分保底（热门也值得回顾）
3. **错误率分（error_score, 0-40）**：基于 Quiz 表统计该节点相关题目的错误率。
   - 错误率 = 错误题数 / 总题数，``score = error_rate * 40``
   - 没有测验记录：给 15 分（未测验过的节点值得测一次）

综合分 = forgetting_score + heat_score + error_score，按综合分降序排序。
每项推荐附 ``reason`` 字符串，说明哪项指标贡献最大。

工作模式（work）排序：

1. **到期（remind_at <= now）**：置顶，``is_overdue: true``
2. **24h 内临近（remind_at <= now + 24h）**：次之，``is_upcoming: true``
3. **星标节点（is_starred=true）**：再次之
4. **按类型权重**：承诺(commitment) > 风险(risk) > 事件(event) > 其他

每项附 ``reason`` 字符串（如"提醒已到期"、"承诺待跟进"、"星标关注"）。

设计要点：

1. **不修改 graph_store / db_models**：仅组合调用既有 ``list_nodes`` /
   ``list_quizzes`` / ``get_graph``，与 extensions.py / quiz.py 路由风格一致。
2. **复用 ``_node_to_dict`` 序列化**：``graph_store.list_nodes`` 返回的节点
   dict 已含 5 个推荐字段（last_reviewed_at / review_count / mention_count /
   remind_at / is_starred），直接嵌入返回结构。
3. **纯 Python 算法**：推荐分计算不依赖额外库，便于离线测试。
4. **时间统一 aware UTC**：数据库读回的 datetime 可能为 naive，统一在
   :func:`_to_aware_utc` 中补 ``timezone.utc``，避免排序时 naive/aware 混用
   抛 ``TypeError``。
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from app.models.node_types import (
    GRAPH_TYPE_STUDY,
    GRAPH_TYPE_WORK,
    WORK_OBJECT_COMMITMENT,
    WORK_OBJECT_EVENT,
    WORK_OBJECT_RISK,
)
from app.services.graph_store import GraphStore, graph_store

logger = logging.getLogger(__name__)

router = APIRouter()


# ============================================================================
# 依赖注入与错误辅助
# ============================================================================


def get_graph_store_dep() -> GraphStore:
    """依赖注入：返回全局 GraphStore 单例。"""
    return graph_store


def _not_found(detail: str) -> HTTPException:
    return HTTPException(status_code=404, detail=detail)


def _bad_request(detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


# ============================================================================
# 工具函数
# ============================================================================


def _to_aware_utc(value: datetime | None) -> datetime | None:
    """将 datetime 统一为 aware UTC。

    SQLite 默认返回 naive datetime（即使存入时带 tzinfo），排序时若与 aware
    datetime 混用会抛 ``TypeError``。这里统一假设 naive 为 UTC。
    """
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _days_since(last_reviewed_at: datetime | None, now: datetime) -> int | None:
    """计算距今天数（向下取整）。``last_reviewed_at`` 为 None 返回 None。"""
    if last_reviewed_at is None:
        return None
    last = _to_aware_utc(last_reviewed_at)
    if last is None:
        return None
    delta = now - last
    return max(0, int(delta.total_seconds() // 86400))


# ============================================================================
# 学习模式推荐分计算
# ============================================================================


def _forgetting_score(
    days_since_review: int | None, review_count: int
) -> tuple[float, str]:
    """遗忘分（0-40）。

    - 从未复习（``days_since_review`` 为 None）：满分 40
    - 否则：``min(40, days_since * 2 * (1 - review_count * 0.1))``，最低 0 分
      ``review_count`` 越多衰减越慢（已熟练），``days_since`` 越久分越高

    Returns:
        ``(score, reason_fragment)`` - reason 描述此分项的特征。
    """
    if days_since_review is None:
        return 40.0, "从未复习"
    # review_count 越多衰减越慢（已熟练），review_count >= 10 时 decay 为 0
    decay_factor = max(0.0, 1.0 - review_count * 0.1)
    score = min(40.0, days_since_review * 2.0 * decay_factor)
    score = max(0.0, score)
    return score, f"久未复习（{days_since_review}天）"


def _heat_score(mention_count: int) -> tuple[float, str]:
    """热度分（0-20）。

    低热度节点适度提分（鼓励关注冷门），热度很高（>10）保底 5 分。
    """
    if mention_count > 10:
        return 5.0, "热门节点回顾"
    score = max(0.0, 20.0 - mention_count * 2.0)
    if mention_count == 0:
        return score, "冷门知识点"
    return score, f"低热度（提及{mention_count}次）"


def _is_quiz_wrong(quiz: dict[str, Any]) -> bool:
    """判断一道已答 quiz 是否为错误。

    - 选择题（single_choice / multi_choice）：``result.correct`` 为 False
    - 费曼题（feynman）：``result.score`` < 60（百分制及格线）
    - 未作答或解析失败：不计为错误
    """
    if not quiz.get("answered"):
        return False
    result = quiz.get("result") or {}
    qtype = quiz.get("type", "")
    if qtype in ("single_choice", "multi_choice"):
        # result.correct 严格为 False 才算错（缺字段或 True 都不算）
        return result.get("correct") is False
    if qtype == "feynman":
        try:
            score = float(result.get("score", 0))
        except (TypeError, ValueError):
            score = 0.0
        return score < 60.0
    return False


def _error_score(
    quizzes: list[dict[str, Any]],
) -> tuple[float, float, str]:
    """错误率分（0-40）。

    - 没有测验记录：给 15 分（未测验过的节点值得测一次）
    - 否则：错误率 = 错误题数 / 总题数，``score = error_rate * 40``

    Returns:
        ``(score, error_rate, reason_fragment)``
    """
    total = len(quizzes)
    if total == 0:
        return 15.0, 0.0, "尚未测验"
    wrong = sum(1 for q in quizzes if _is_quiz_wrong(q))
    error_rate = wrong / total
    score = error_rate * 40.0
    if wrong == 0:
        return score, error_rate, "测验全对"
    pct = int(round(error_rate * 100))
    return score, error_rate, f"测验错误率高（{pct}%）"


def _study_recommend(
    nodes: list[dict[str, Any]],
    quizzes: list[dict[str, Any]],
    now: datetime,
) -> list[dict[str, Any]]:
    """计算 study 模式每个节点的推荐分并排序。"""
    # 按 node_id 聚合 quiz，避免对每个节点重复遍历全表
    quizzes_by_node: dict[str, list[dict[str, Any]]] = {}
    for q in quizzes:
        nid = q.get("node_id") or ""
        quizzes_by_node.setdefault(nid, []).append(q)

    items: list[dict[str, Any]] = []
    for node in nodes:
        last_reviewed = node.get("last_reviewed_at")
        review_count = int(node.get("review_count") or 0)
        mention_count = int(node.get("mention_count") or 0)
        days = _days_since(last_reviewed, now)

        f_score, f_reason = _forgetting_score(days, review_count)
        h_score, h_reason = _heat_score(mention_count)
        node_quizzes = quizzes_by_node.get(node.get("id") or "", [])
        e_score, error_rate, e_reason = _error_score(node_quizzes)

        total_score = f_score + h_score + e_score

        # reason 取贡献最大的项（并列时按遗忘→热度→错误率优先级）
        contributions = [
            (f_score, f_reason),
            (h_score, h_reason),
            (e_score, e_reason),
        ]
        contributions.sort(key=lambda x: x[0], reverse=True)
        primary_reason = contributions[0][1]

        items.append(
            {
                "node": node,
                "score": round(total_score, 2),
                "reason": primary_reason,
                "is_overdue": False,
                "is_upcoming": False,
                "error_rate": round(error_rate, 4),
                "days_since_review": days if days is not None else None,
            }
        )

    # 按综合分降序；分数相同按节点创建时间升序（老节点优先复习）
    items.sort(
        key=lambda x: (
            -x["score"],
            x["node"].get("created_at") or datetime.min,
        )
    )
    return items


# ============================================================================
# 工作模式排序
# ============================================================================


# Work 模式节点类型权重（commitment > risk > event > 其他）
_WORK_TYPE_WEIGHT: dict[str, int] = {
    WORK_OBJECT_COMMITMENT: 4,
    WORK_OBJECT_RISK: 3,
    WORK_OBJECT_EVENT: 2,
}

_WORK_TYPE_REASON: dict[str, str] = {
    WORK_OBJECT_COMMITMENT: "承诺待跟进",
    WORK_OBJECT_RISK: "风险待跟进",
    WORK_OBJECT_EVENT: "事件待跟进",
}


def _work_recommend(
    nodes: list[dict[str, Any]],
    now: datetime,
) -> list[dict[str, Any]]:
    """工作模式按到期 / 星标 / 类型权重排序。"""
    items: list[dict[str, Any]] = []
    horizon = now + timedelta(hours=24)

    for node in nodes:
        remind_at = node.get("remind_at")
        is_starred = bool(node.get("is_starred"))
        node_type = node.get("type", "")

        remind_aware = _to_aware_utc(remind_at)

        is_overdue = False
        is_upcoming = False
        reason = ""

        if remind_aware is not None and remind_aware <= now:
            is_overdue = True
            reason = "提醒已到期"
        elif remind_aware is not None and remind_aware <= horizon:
            is_upcoming = True
            hours_left = max(0, int((remind_aware - now).total_seconds() // 3600))
            reason = f"24小时内到期（剩{hours_left}h）"
        elif is_starred:
            reason = "星标关注"
        else:
            reason = _WORK_TYPE_REASON.get(node_type, "工作对象")

        # 排序键（越小越靠前）：
        # 1. overdue（0=已到期置顶，1=否）
        # 2. upcoming（0=临近，1=否）
        # 3. starred（0=星标，1=否）
        # 4. type_weight 取负（越大越靠前）
        # 5. remind_at 早的优先（无 remind_at 视为最晚）
        # 6. created_at 升序兜底
        type_weight = _WORK_TYPE_WEIGHT.get(node_type, 0)
        remind_sort = (
            remind_aware
            if remind_aware is not None
            else datetime.max.replace(tzinfo=UTC)
        )
        created_at = node.get("created_at") or datetime.min

        sort_key = (
            0 if is_overdue else 1,
            0 if is_upcoming else 1,
            0 if is_starred else 1,
            -type_weight,
            remind_sort,
            created_at,
        )

        items.append(
            {
                "node": node,
                "score": 0,  # work 模式不计算综合分，但保留字段统一返回结构
                "reason": reason,
                "is_overdue": is_overdue,
                "is_upcoming": is_upcoming,
                "error_rate": 0.0,
                "days_since_review": None,
                "_sort_key": sort_key,
            }
        )

    items.sort(key=lambda x: x["_sort_key"])
    # 清理临时字段，不暴露给前端
    for item in items:
        item.pop("_sort_key", None)
    return items


# ============================================================================
# 路由
# ============================================================================


@router.get("/graphs/{graph_id}/recommendations", response_model=dict)
async def get_recommendations(
    graph_id: str,
    mode: str = Query(
        "study", description="推荐模式：study / work（需与图谱 type 匹配）"
    ),
    limit: int = Query(20, ge=1, le=100, description="返回条数，1-100"),
    store: GraphStore = Depends(get_graph_store_dep),
) -> dict[str, Any]:
    """获取图谱的智能推荐节点列表。

    - ``mode=study``：基于遗忘分 + 热度分 + 错误率分综合排序
    - ``mode=work``：基于到期 / 星标 / 类型权重排序

    校验图谱存在（404）且 ``type`` 与 ``mode`` 匹配（study 图谱只能
    ``mode=study``，work 图谱只能 ``mode=work``，否则 400）。
    """
    graph = await store.get_graph(graph_id)
    if graph is None:
        raise _not_found(f"图谱不存在: {graph_id}")

    if mode not in (GRAPH_TYPE_STUDY, GRAPH_TYPE_WORK):
        raise _bad_request(f"非法推荐模式: {mode}（允许: study / work）")

    graph_type = graph.get("type")
    if graph_type != mode:
        raise _bad_request(
            f"图谱类型 {graph_type} 与推荐模式 {mode} 不匹配"
        )

    nodes = await store.list_nodes(graph_id)
    now = datetime.now(UTC)

    if mode == GRAPH_TYPE_STUDY:
        quizzes = await store.list_quizzes(graph_id=graph_id)
        items = _study_recommend(nodes, quizzes, now)
    else:
        items = _work_recommend(nodes, now)

    total = len(items)
    items = items[:limit]
    return {"items": items, "total": total}
