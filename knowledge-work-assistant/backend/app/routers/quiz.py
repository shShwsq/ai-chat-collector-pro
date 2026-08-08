"""Study 测验路由（Task 12）。

提供测验生成、作答判分、历史查询接口，挂载在 ``/api`` 前缀下：

- ``POST /api/graphs/{graph_id}/quiz/generate``
  生成一道测验题。body: ``{node_ids?, quiz_type, count?}``。
  调用 ``graph_agent.generate_quiz`` 生成题目，再 ``graph_store.create_quiz``
  持久化（选择题 ``answer`` 字段暂存 ``correct_answers``，``result`` 空）。
- ``POST /api/graphs/{graph_id}/quiz/{quiz_id}/answer``
  作答并判分。body: ``{answer}``。
  选择题：本地对比 ``correct_answers`` 即时判分，返回 ``{correct, explanation, result}``。
  费曼题：调用 ``graph_agent.grade_feynman`` 语义判分，返回
  ``{score, understanding_level, feedback, missed_points}``。
  判分结果经 ``graph_store.update_quiz_result`` 落库，关联 node_id 便于复盘。
- ``GET  /api/graphs/{graph_id}/quiz``
  列出该图谱的测验历史（按创建时间倒序）。
- ``GET  /api/graphs/{graph_id}/quiz/{quiz_id}``
  获取单题详情。

设计要点：

1. **不修改 graph_store / graph_agent**：仅组合调用既有方法，与 extensions.py /
   extraction.py 路由风格一致。
2. **答案隔离**：``quiz.payload`` 在库中完整存储题目（含 ``correct_answers`` /
   ``reference_points``），但通过 :func:`_sanitize_quiz_for_client` 在返回前端时
   剥离答案字段，避免泄题。作答后再由 answer 接口返回正确答案与解析。
3. **选择题本地判分**：用户 ``answer`` 为选项 id 数组（如 ``["A","C"]``），
   与 ``correct_answers`` 集合比对；多选题部分对算错（严格集合相等）。
4. **费曼语义判分**：直接转交 ``graph_agent.grade_feynman``，LLM 不可用时
   Agent 内部已降级为关键词覆盖率判分。
5. **降级透明**：``generate_quiz`` 在 LLM 不可用时返回 ``degraded=True`` 占位
   题目，本层照常落库，前端据此提示用户「题目生成服务暂不可用」。
6. **count 参数**：当前 Agent 一次只生成一道题，``count`` 仅做参数校验
   （>1 时返回提示），不实际批量生成，保持接口简单。
"""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.models.schemas import QuizResponse
from app.services.graph_agent import GraphAgent, get_graph_agent
from app.services.graph_store import GraphStore, graph_store

logger = logging.getLogger(__name__)

router = APIRouter()


# ============================================================================
# 依赖注入
# ============================================================================


def get_graph_store_dep() -> GraphStore:
    """依赖注入：返回全局 GraphStore 单例。"""
    return graph_store


def get_agent() -> GraphAgent:
    """依赖注入：返回全局 GraphAgent 单例。"""
    return get_graph_agent()


def _not_found(detail: str) -> HTTPException:
    return HTTPException(status_code=404, detail=detail)


def _bad_request(detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


# ============================================================================
# 请求 / 响应模型
# ============================================================================


class QuizGenerateRequest(BaseModel):
    """生成测验请求。"""

    node_ids: list[str] | None = Field(
        None, description="限定题目涉及的节点 ID 列表；None 则从全图随机选取"
    )
    quiz_type: str = Field(
        "single_choice",
        description="题型：single_choice / multi_choice / feynman",
    )
    count: int | None = Field(
        None, ge=1, le=1, description="题目数量，当前固定为 1（>1 暂未支持批量）"
    )


class QuizAnswerRequest(BaseModel):
    """作答请求。

    - 选择题：``answer`` 为选项 id 数组，如 ``["A"]``（单选）或 ``["A","C"]``（多选）。
    - 费曼题：``answer`` 为用户解释文本。
    """

    answer: Any = Field(
        ...,
        description="用户答案：选择题为选项 id 数组，费曼题为解释文本",
    )


# ============================================================================
# 工具函数
# ============================================================================


# payload 中存放的答案相关键（返回前端时剥离，避免泄题）
_PAYLOAD_KEY_CORRECT = "correct_answers"
_PAYLOAD_KEY_REFERENCE = "reference_points"


def _sanitize_quiz_for_client(quiz: dict[str, Any]) -> dict[str, Any]:
    """剥离 quiz 中的答案字段，避免泄露给前端。

    - 选择题：从 ``payload`` 移除 ``correct_answers``，并清空 ``answer`` 字段。
    - 费曼题：从 ``payload`` 移除 ``reference_points``（作答前不可见参考要点）。
    - ``result`` 字段为作答结果，作答后保留（含正确答案与解析，供复盘）。
    """
    payload = quiz.get("payload") or {}
    sanitized_payload = dict(payload)
    qtype = quiz.get("type", "")
    if qtype in ("single_choice", "multi_choice"):
        sanitized_payload.pop(_PAYLOAD_KEY_CORRECT, None)
    elif qtype == "feynman":
        sanitized_payload.pop(_PAYLOAD_KEY_REFERENCE, None)

    out = dict(quiz)
    out["payload"] = sanitized_payload
    # 选择题 answer 字段存了 correct_answers，作答前清空
    if qtype in ("single_choice", "multi_choice") and not quiz.get("answered"):
        out["answer"] = ""
    return out


def _normalize_choice_answer(answer: Any) -> list[str]:
    """把用户答案归一化为选项 id 字符串数组。

    接受：
    - 选项 id 数组：``["A","C"]``
    - 选项索引数组：``[0,2]``
    - 单个 id 字符串：``"A"``
    - 单个索引整数：``0``
    """
    if answer is None:
        return []
    if isinstance(answer, str):
        s = answer.strip()
        if not s:
            return []
        # 尝试解析 JSON 数组字符串
        if s.startswith("["):
            try:
                parsed = json.loads(s)
                return _normalize_choice_answer(parsed)
            except (json.JSONDecodeError, TypeError):
                pass
        return [s]
    if isinstance(answer, (int, float)):
        # 索引：转成对应字母（0 -> A, 1 -> B ...）
        idx = int(answer)
        if 0 <= idx < 26:
            return [chr(ord("A") + idx)]
        return [str(idx)]
    if isinstance(answer, list):
        out: list[str] = []
        for item in answer:
            if isinstance(item, str):
                s = item.strip()
                if s:
                    out.append(s)
            elif isinstance(item, (int, float)) and not isinstance(item, bool):
                idx = int(item)
                if 0 <= idx < 26:
                    out.append(chr(ord("A") + idx))
                else:
                    out.append(str(idx))
        return out
    return []


# ============================================================================
# 路由
# ============================================================================


@router.post(
    "/graphs/{graph_id}/quiz/generate",
    response_model=QuizResponse,
    status_code=201,
)
async def generate_quiz(
    graph_id: str,
    body: QuizGenerateRequest,
    store: GraphStore = Depends(get_graph_store_dep),
    agent: GraphAgent = Depends(get_agent),
) -> QuizResponse:
    """生成一道测验题并持久化。

    流程：
    1. 校验图谱存在。
    2. 调用 ``graph_agent.generate_quiz(graph_id, node_ids, quiz_type)``
       生成题目（LLM 不可用时返回降级占位题）。
    3. 调用 ``graph_store.create_quiz`` 落库：
       - 选择题：``payload`` 存 question/options/explanation/correct_answers，
         ``answer`` 字段同时存 ``correct_answers`` JSON（便于本地判分快速读取）。
       - 费曼题：``payload`` 存 prompt/reference_points，``answer`` 空。
    4. 返回 quiz 详情（剥离 ``correct_answers`` / ``reference_points`` 避免泄题）。
    """
    graph = await store.get_graph(graph_id)
    if graph is None:
        raise _not_found(f"图谱不存在: {graph_id}")

    # 题型校验（与 graph_store.create_quiz 一致）
    valid_types = ("single_choice", "multi_choice", "feynman")
    if body.quiz_type not in valid_types:
        raise _bad_request(
            f"非法题型: {body.quiz_type}（允许: {list(valid_types)}）"
        )

    # count 参数：当前仅支持 1 道
    if body.count is not None and body.count != 1:
        raise _bad_request("当前仅支持一次生成 1 道题（count 暂未支持批量）")

    # 调用 Agent 生成题目
    try:
        quiz_data = await agent.generate_quiz(
            graph_id=graph_id,
            node_ids=body.node_ids,
            quiz_type=body.quiz_type,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("quiz generate: agent 异常: %s", exc)
        quiz_data = {
            "type": body.quiz_type,
            "degraded": True,
            "degrade_reason": f"Agent 调用异常: {exc}",
            "node_id": "",
        }

    qtype = quiz_data.get("type", body.quiz_type)
    degraded = bool(quiz_data.get("degraded"))
    node_id = quiz_data.get("node_id", "") or ""

    # 降级且无 node_id 时：尝试取图谱首个节点作为关联，便于落库（create_quiz 要求 node 存在）
    if not node_id:
        nodes = await store.list_nodes(graph_id)
        if nodes:
            node_id = nodes[0].get("id", "")
        else:
            # 图谱无节点：返回降级提示，不落库
            raise _bad_request(
                "图谱下无节点，无法生成测验。请先添加或抽取节点后再试。"
            )

    # 构造 payload 与 answer
    if qtype == "feynman":
        payload = {
            "prompt": quiz_data.get("prompt", ""),
            "reference_points": quiz_data.get("reference_points", []),
            # 降级信息也存入 payload，供前端展示
            "degraded": degraded,
            "degrade_reason": quiz_data.get("degrade_reason", ""),
        }
        answer = ""
    else:
        # 选择题：correct_answers 存 payload（供前端作答前剥离）+ answer 字段（便于判分快速读取）
        correct_answers = quiz_data.get("correct_answers", []) or []
        payload = {
            "question": quiz_data.get("question", ""),
            "options": quiz_data.get("options", []) or [],
            "explanation": quiz_data.get("explanation", ""),
            "correct_answers": correct_answers,
            "degraded": degraded,
            "degrade_reason": quiz_data.get("degrade_reason", ""),
        }
        answer = json.dumps(correct_answers, ensure_ascii=False)

    # 落库
    try:
        quiz = await store.create_quiz(
            graph_id=graph_id,
            node_id=node_id,
            quiz_type=qtype,
            payload=payload,
            answer=answer,
        )
    except ValueError as exc:
        msg = str(exc)
        if "不存在" in msg:
            raise _not_found(msg) from exc
        raise _bad_request(msg) from exc

    return QuizResponse(**_sanitize_quiz_for_client(quiz))


@router.post(
    "/graphs/{graph_id}/quiz/{quiz_id}/answer",
    response_model=dict,
)
async def answer_quiz(
    graph_id: str,
    quiz_id: str,
    body: QuizAnswerRequest,
    store: GraphStore = Depends(get_graph_store_dep),
    agent: GraphAgent = Depends(get_agent),
) -> dict[str, Any]:
    """作答并判分。

    - 选择题：本地对比 ``correct_answers``，返回
      ``{correct, correct_answers, user_answer, explanation, result, degraded}``。
    - 费曼题：调用 ``graph_agent.grade_feynman``，返回
      ``{score, understanding_level, feedback, missed_points, reference_points, degraded}``。

    判分结果经 ``graph_store.update_quiz_result`` 落库，``result`` 字段含
    用户答案 + 得分 + 解析，便于复盘。
    """
    quiz = await store.get_quiz(quiz_id)
    if quiz is None or quiz.get("graph_id") != graph_id:
        raise _not_found(
            f"测验不存在或不属于图谱 {graph_id}: {quiz_id}"
        )

    qtype = quiz.get("type", "")

    if qtype == "feynman":
        return await _answer_feynman(quiz, body, store, agent)

    if qtype in ("single_choice", "multi_choice"):
        return await _answer_choice(quiz, body, store)

    raise _bad_request(f"不支持的题型: {qtype}")


async def _answer_choice(
    quiz: dict[str, Any],
    body: QuizAnswerRequest,
    store: GraphStore,
) -> dict[str, Any]:
    """选择题本地判分。"""
    payload = quiz.get("payload") or {}
    options = payload.get("options") or []
    # 优先从 payload 读 correct_answers；若空则尝试从 answer 字段解析（兼容旧数据）
    correct_answers = payload.get("correct_answers") or []
    if not correct_answers and quiz.get("answer"):
        try:
            correct_answers = json.loads(quiz["answer"])
        except (json.JSONDecodeError, TypeError):
            correct_answers = []
    correct_set = {str(c).strip() for c in correct_answers if c}

    user_answer = _normalize_choice_answer(body.answer)
    user_set = {a for a in user_answer}

    # 严格集合相等判分（多选题部分对算错）
    is_multi = quiz.get("type") == "multi_choice"
    if is_multi:
        correct = user_set == correct_set and len(user_set) > 0
    else:
        # 单选：用户选了一个且等于正确答案
        correct = len(user_set) == 1 and user_set == correct_set

    explanation = payload.get("explanation", "") or ""
    degraded = bool(payload.get("degraded"))

    result = {
        "user_answer": user_answer,
        "correct_answers": list(correct_answers),
        "correct": correct,
        "explanation": explanation,
        "degraded": degraded,
    }

    # 落库
    updated = await store.update_quiz_result(quiz["id"], result)
    if updated is None:
        raise _not_found(f"测验不存在: {quiz['id']}")

    # 返回给前端：含正确答案与解析（作答后可披露）
    return {
        "quiz_id": quiz["id"],
        "type": quiz.get("type", ""),
        "node_id": quiz.get("node_id", ""),
        "correct": correct,
        "user_answer": user_answer,
        "correct_answers": list(correct_answers),
        "explanation": explanation,
        "options": options,
        "degraded": degraded,
        "result": result,
    }


async def _answer_feynman(
    quiz: dict[str, Any],
    body: QuizAnswerRequest,
    store: GraphStore,
    agent: GraphAgent,
) -> dict[str, Any]:
    """费曼题语义判分（转交 Agent）。"""
    user_answer = body.answer
    if isinstance(user_answer, list):
        # 费曼题应为字符串，但兼容前端传数组拼接
        user_answer = "\n".join(str(x) for x in user_answer)
    elif not isinstance(user_answer, str):
        user_answer = str(user_answer) if user_answer is not None else ""

    user_answer = user_answer.strip()
    if not user_answer:
        raise _bad_request("费曼题作答不能为空")

    # 调用 Agent 判分（LLM 不可用时内部降级为关键词覆盖率判分）
    try:
        grade = await agent.grade_feynman(quiz["id"], user_answer)
    except Exception as exc:  # noqa: BLE001
        logger.warning("quiz answer: grade_feynman 异常: %s", exc)
        grade = {
            "score": 0,
            "understanding_level": "poor",
            "feedback": f"判分服务异常: {exc}",
            "missed_points": [],
            "degraded": True,
            "degrade_reason": str(exc),
        }

    payload = quiz.get("payload") or {}
    reference_points = payload.get("reference_points") or []

    result = {
        "user_answer": user_answer,
        "score": grade.get("score", 0),
        "understanding_level": grade.get("understanding_level", "poor"),
        "feedback": grade.get("feedback", ""),
        "missed_points": grade.get("missed_points", []),
        "reference_points": reference_points,
        "degraded": grade.get("degraded", False),
        "degrade_reason": grade.get("degrade_reason", ""),
    }

    updated = await store.update_quiz_result(quiz["id"], result)
    if updated is None:
        raise _not_found(f"测验不存在: {quiz['id']}")

    return {
        "quiz_id": quiz["id"],
        "type": quiz.get("type", ""),
        "node_id": quiz.get("node_id", ""),
        "score": grade.get("score", 0),
        "understanding_level": grade.get("understanding_level", "poor"),
        "feedback": grade.get("feedback", ""),
        "missed_points": grade.get("missed_points", []),
        "reference_points": reference_points,
        "prompt": payload.get("prompt", ""),
        "degraded": grade.get("degraded", False),
        "degrade_reason": grade.get("degrade_reason", ""),
        "result": result,
    }


@router.get("/graphs/{graph_id}/quiz", response_model=list[QuizResponse])
async def list_quizzes(
    graph_id: str,
    answered: bool | None = Query(
        None, description="作答状态过滤：True 仅已答，False 仅未答，None 全部"
    ),
    store: GraphStore = Depends(get_graph_store_dep),
) -> list[QuizResponse]:
    """列出该图谱的测验历史，按创建时间倒序。"""
    if await store.get_graph(graph_id) is None:
        raise _not_found(f"图谱不存在: {graph_id}")
    items = await store.list_quizzes(graph_id=graph_id, answered=answered)
    return [QuizResponse(**_sanitize_quiz_for_client(q)) for q in items]


@router.get(
    "/graphs/{graph_id}/quiz/{quiz_id}", response_model=QuizResponse
)
async def get_quiz(
    graph_id: str,
    quiz_id: str,
    store: GraphStore = Depends(get_graph_store_dep),
) -> QuizResponse:
    """获取单题详情（剥离答案字段，避免泄题）。"""
    quiz = await store.get_quiz(quiz_id)
    if quiz is None or quiz.get("graph_id") != graph_id:
        raise _not_found(
            f"测验不存在或不属于图谱 {graph_id}: {quiz_id}"
        )
    return QuizResponse(**_sanitize_quiz_for_client(quiz))
