"""标签库与基于标签的 RAG 检索（替代向量检索）。

设计目标：
- 移除 ChromaDB 向量检索，改用「标签 + 关键词 + 描述句」三路检索
- 标签库全局唯一，SummarizeAgent 生成标签时参考本库去重（同义归一）
- 检索结果按综合评分排序，支持分页

核心接口：
- :meth:`TagStore.get_all_tags`：列出全部标签名（供 SummarizeAgent / SearchAgent 参考）
- :meth:`TagStore.assign_tags_to_file`：为文件关联标签（自动入库新标签）
- :meth:`TagStore.remove_tags_from_file`：移除文件的标签关联
- :meth:`TagStore.get_file_tags`：获取文件标签
- :meth:`TagStore.search`：三路检索 + 综合排序 + 分页

检索算法（:meth:`TagStore.search`）：

输入为 SearchAgent 的结构化输出::

    {
        "tags": ["销售", "季度报告"],          # 相关标签
        "keywords": ["销售额", "同比增长"],      # 关键词
        "description": "5月的销售额为..."        # 描述性句子（文档中可能的内容）
    }

检索路径：
1. **标签命中**：文件标签与查询标签交集，命中数 × 3 分
2. **关键词命中**：在 summary / original_name 中 LIKE 匹配，每个命中 × 2 分
3. **描述句匹配**：用 FTS5 MATCH（如可用）或 LIKE 在 summary 中匹配，命中 × 4 分
4. **时间近因**：indexed_at 越近加分越多（最近 7 天 +1，30 天 +0.5）

合并去重后按总分降序，支持 ``page`` / ``page_size`` 分页。

本项目从步影 backend/app/services/tag_store.py 适配拷贝而来，依赖
``app.db.AsyncSessionLocal`` 与 ``app.models.db_models``（Tag / FileTag /
FileMetadata）均已就位，可被路由层与 services 层按需调用。
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import and_, delete, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import AsyncSessionLocal
from app.models.db_models import FileMetadata as FileMetadataRow
from app.models.db_models import FileTag, Tag

logger = logging.getLogger(__name__)

# 检索结果 snippet 截断长度
_SNIPPET_LIMIT = 200
# 默认分页大小
_DEFAULT_PAGE_SIZE = 10
# 最大分页大小
_MAX_PAGE_SIZE = 50


def _now() -> datetime:
    return datetime.now(UTC)


class TagStore:
    """标签库与标签检索管理器。"""

    # ------------------------------------------------------------------
    # 标签库查询
    # ------------------------------------------------------------------

    async def get_all_tags(self) -> list[str]:
        """列出全部标签名（按创建时间倒序，便于 agent 参考最新趋势）。"""
        async with AsyncSessionLocal() as db:
            result = await db.execute(select(Tag.name).order_by(Tag.created_at.desc()))
            return [r[0] for r in result.all()]

    async def get_all_tags_with_count(self) -> list[dict[str, Any]]:
        """列出全部标签 + 各自关联的文件数。"""
        async with AsyncSessionLocal() as db:
            stmt = (
                select(
                    Tag.id,
                    Tag.name,
                    func.count(FileTag.file_id).label("file_count"),
                )
                .outerjoin(FileTag, FileTag.tag_id == Tag.id)
                .group_by(Tag.id, Tag.name)
                .order_by(Tag.created_at.desc())
            )
            result = await db.execute(stmt)
            return [
                {"id": r[0], "name": r[1], "file_count": int(r[2] or 0)}
                for r in result.all()
            ]

    # ------------------------------------------------------------------
    # 文件标签管理
    # ------------------------------------------------------------------

    async def assign_tags_to_file(
        self, file_id: str, tag_names: list[str], db: AsyncSession | None = None
    ) -> list[str]:
        """为文件关联标签（自动入库新标签，去重）。

        Args:
            file_id: 文件 ID。
            tag_names: 标签名列表（会被规整：去空白、去重、转小写存储但保留原大小写显示）。
            db: 可选外部 session（用于在事务内执行）。

        Returns:
            实际关联的标签名列表。
        """
        # 规整标签：去空白、去重、过滤空
        seen: set[str] = set()
        clean_names: list[str] = []
        for name in tag_names or []:
            n = (name or "").strip()
            if not n:
                continue
            key = n.lower()
            if key in seen:
                continue
            seen.add(key)
            clean_names.append(n)
        if not clean_names:
            return []

        own_session = db is None
        if own_session:
            db = AsyncSessionLocal()
        try:
            assert db is not None
            # 1. 查询已存在的标签（按 lower(name) 匹配，保证大小写不敏感去重）
            existing: dict[str, str] = {}  # lower(name) -> tag_id
            stmt = select(Tag).where(
                or_(*[func.lower(Tag.name) == n.lower() for n in clean_names])
            )
            result = await db.execute(stmt)
            for tag in result.scalars().all():
                existing[tag.name.lower()] = tag.id

            # 2. 创建新标签
            tag_id_by_name: dict[str, str] = {}
            for n in clean_names:
                key = n.lower()
                if key in existing:
                    tag_id_by_name[n] = existing[key]
                else:
                    new_id = uuid.uuid4().hex
                    new_tag = Tag(id=new_id, name=n)
                    db.add(new_tag)
                    tag_id_by_name[n] = new_id
                    existing[key] = new_id

            # 3. 确保新标签已落库（避免后续 file_tags 外键约束失败）
            await db.flush()

            # 4. 查询已存在的关联，避免重复插入
            tag_ids = list(set(tag_id_by_name.values()))
            existing_links: set[str] = set()  # tag_id 已关联
            if tag_ids:
                link_stmt = select(FileTag.tag_id).where(
                    and_(FileTag.file_id == file_id, FileTag.tag_id.in_(tag_ids))
                )
                link_result = await db.execute(link_stmt)
                existing_links = {r[0] for r in link_result.all()}

            # 5. 插入新关联
            for _n, tid in tag_id_by_name.items():
                if tid not in existing_links:
                    db.add(FileTag(file_id=file_id, tag_id=tid))

            if own_session:
                await db.commit()

            return list(tag_id_by_name.keys())
        except Exception:
            if own_session:
                await db.rollback()
            raise
        finally:
            if own_session:
                await db.close()

    async def remove_tags_from_file(self, file_id: str) -> int:
        """移除文件的全部标签关联（文件删除时调用）。返回移除条数。"""
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                delete(FileTag).where(FileTag.file_id == file_id)
            )
            await db.commit()
            return int(result.rowcount or 0)

    async def get_file_tags(self, file_id: str) -> list[str]:
        """获取文件标签名列表。"""
        async with AsyncSessionLocal() as db:
            stmt = (
                select(Tag.name)
                .join(FileTag, FileTag.tag_id == Tag.id)
                .where(FileTag.file_id == file_id)
                .order_by(Tag.name)
            )
            result = await db.execute(stmt)
            return [r[0] for r in result.all()]

    async def rename_tag(self, old_name: str, new_name: str) -> bool:
        """重命名标签（保持关联不变）。"""
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(Tag).where(func.lower(Tag.name) == old_name.lower())
            )
            tag = result.scalar_one_or_none()
            if tag is None:
                return False
            tag.name = new_name.strip()
            await db.commit()
            return True

    async def delete_tag(self, name: str) -> bool:
        """删除标签（同步移除所有关联）。"""
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                select(Tag).where(func.lower(Tag.name) == name.lower())
            )
            tag = result.scalar_one_or_none()
            if tag is None:
                return False
            await db.delete(tag)
            await db.commit()
            return True

    # ------------------------------------------------------------------
    # 三路检索（标签 + 关键词 + 描述句）
    # ------------------------------------------------------------------

    async def search(
        self,
        tags: list[str] | None = None,
        keywords: list[str] | None = None,
        description: str | None = None,
        page: int = 1,
        page_size: int = _DEFAULT_PAGE_SIZE,
    ) -> dict[str, Any]:
        """三路检索 + 综合排序 + 分页。

        Args:
            tags: 相关标签列表。
            keywords: 关键词列表（在 summary / original_name 中匹配）。
            description: 描述性句子（文档中可能的内容，非查询需求）。
            page: 页码（从 1 开始）。
            page_size: 每页条数（默认 10，最大 50）。

        Returns:
            ::

                {
                    "results": [
                        {
                            "file_id": "...",
                            "original_name": "...",
                            "summary": "...",
                            "tags": ["..."],
                            "score": 12.5,
                            "tag_hits": 2,
                            "keyword_hits": 1,
                            "description_hit": true,
                            "snippet": "..."
                        }
                    ],
                    "total": 25,
                    "page": 1,
                    "page_size": 10,
                    "has_more": true,
                }
        """
        tags = [t.strip() for t in (tags or []) if t and t.strip()]
        keywords = [k.strip() for k in (keywords or []) if k and k.strip()]
        description = (description or "").strip()
        page = max(1, int(page))
        page_size = max(1, min(_MAX_PAGE_SIZE, int(page_size)))

        async with AsyncSessionLocal() as db:
            # 1. 计算每个文件的得分
            scored: list[dict[str, Any]] = await self._score_files(
                db, tags, keywords, description
            )

            # 2. 排序（分数降序，同分按 indexed_at 降序）
            scored.sort(key=lambda x: (x["score"], x.get("_indexed_at", 0)), reverse=True)

            total = len(scored)
            start = (page - 1) * page_size
            end = start + page_size
            page_items = scored[start:end]

            # 3. 加载文件元数据 + 标签
            results: list[dict[str, Any]] = []
            for item in page_items:
                file_id = item["file_id"]
                row = await db.get(FileMetadataRow, file_id)
                if row is None:
                    continue
                file_tags = await self.get_file_tags(file_id)
                summary_text = row.summary or ""
                results.append(
                    {
                        "file_id": file_id,
                        "original_name": row.original_name,
                        "summary": summary_text,
                        "tags": file_tags,
                        "score": round(item["score"], 2),
                        "tag_hits": item.get("tag_hits", 0),
                        "keyword_hits": item.get("keyword_hits", 0),
                        "description_hit": item.get("description_hit", False),
                        "snippet": summary_text[:_SNIPPET_LIMIT],
                        "saved_path": row.saved_path,
                        "mime_type": row.mime_type,
                        "indexed_at": row.indexed_at,
                    }
                )

        return {
            "results": results,
            "total": total,
            "page": page,
            "page_size": page_size,
            "has_more": end < total,
        }

    async def _score_files(
        self,
        db: AsyncSession,
        tags: list[str],
        keywords: list[str],
        description: str,
    ) -> list[dict[str, Any]]:
        """计算所有文件的得分。

        评分规则：
        - 标签命中：每命中 1 个 × 3 分
        - 关键词命中：每命中 1 个 × 2 分（在 summary / original_name 中 LIKE）
        - 描述句命中：FTS5 MATCH 或 LIKE 命中 × 4 分
        - 时间近因：最近 7 天 +1，30 天 +0.5
        """
        # 收集所有候选 file_id 与得分
        scores: dict[str, dict[str, Any]] = {}

        async def _ensure(file_id: str) -> dict[str, Any]:
            if file_id not in scores:
                scores[file_id] = {
                    "file_id": file_id,
                    "score": 0.0,
                    "tag_hits": 0,
                    "keyword_hits": 0,
                    "description_hit": False,
                    "_indexed_at": 0,
                }
            return scores[file_id]

        # 1. 标签命中
        if tags:
            tag_lower = [t.lower() for t in tags]
            stmt = (
                select(FileTag.file_id, func.count().label("hits"))
                .join(Tag, Tag.id == FileTag.tag_id)
                .where(or_(*[func.lower(Tag.name) == t for t in tag_lower]))
                .group_by(FileTag.file_id)
            )
            result = await db.execute(stmt)
            for row in result.all():
                file_id = row[0]
                hits = int(row[1] or 0)
                entry = await _ensure(file_id)
                entry["score"] += hits * 3.0
                entry["tag_hits"] = hits

        # 2. 关键词命中（summary / original_name LIKE）
        if keywords:
            for kw in keywords:
                like_pattern = f"%{kw}%"
                stmt = select(FileMetadataRow.id).where(
                    or_(
                        FileMetadataRow.summary.like(like_pattern),
                        FileMetadataRow.original_name.like(like_pattern),
                    )
                )
                result = await db.execute(stmt)
                for r in result.all():
                    file_id = r[0]
                    entry = await _ensure(file_id)
                    entry["score"] += 2.0
                    entry["keyword_hits"] += 1

        # 3. 描述句命中（FTS5 MATCH 或 LIKE）
        if description:
            hit_ids = await self._match_description(db, description)
            for file_id in hit_ids:
                entry = await _ensure(file_id)
                entry["score"] += 4.0
                entry["description_hit"] = True

        # 4. 时间近因（仅对已有得分的文件加分）
        if scores:
            now = _now()
            week_ago = now - timedelta(days=7)
            month_ago = now - timedelta(days=30)
            file_ids = list(scores.keys())
            stmt = select(FileMetadataRow.id, FileMetadataRow.indexed_at).where(
                FileMetadataRow.id.in_(file_ids)
            )
            result = await db.execute(stmt)
            for row in result.all():
                file_id = row[0]
                idx = row[1]
                entry = scores.get(file_id)
                if entry is None or idx is None:
                    continue
                # SQLite 可能将 datetime 存为 TEXT，统一解析为 offset-aware UTC
                if isinstance(idx, str):
                    try:
                        idx = datetime.fromisoformat(idx.replace("Z", "+00:00"))
                    except ValueError:
                        continue
                if idx.tzinfo is None:
                    idx = idx.replace(tzinfo=UTC)
                ts = idx.timestamp() if hasattr(idx, "timestamp") else 0
                entry["_indexed_at"] = ts
                if idx >= week_ago:
                    entry["score"] += 1.0
                elif idx >= month_ago:
                    entry["score"] += 0.5

        return list(scores.values())

    async def _match_description(
        self, db: AsyncSession, description: str
    ) -> list[str]:
        """用 FTS5 MATCH 在 file_metadata_fts 中匹配描述句。

        FTS5 不可用时回退到 summary LIKE（取描述句中的核心词）。
        """
        # 尝试 FTS5 MATCH
        try:
            # FTS5 查询语法：空格分隔为 AND，需转义特殊字符
            # 简化：取描述句前若干个词，用空格连接（FTS5 默认 AND）
            words = [w for w in description.replace('"', "").split() if w]
            if not words:
                return []
            # 取前 5 个词避免查询过严
            query = " ".join(words[:5])
            stmt = text(
                "SELECT fm.id FROM file_metadata fm "
                "JOIN file_metadata_fts fts ON fts.row_id = fm.id "
                "WHERE file_metadata_fts MATCH :q"
            )
            result = await db.execute(stmt, {"q": query})
            return [r[0] for r in result.all()]
        except Exception as exc:  # noqa: BLE001
            logger.debug("FTS5 MATCH 失败，回退 LIKE: %s", exc)
            # 回退：用描述句的核心词 LIKE 匹配 summary
            words = [w for w in description.split() if len(w) >= 2]
            if not words:
                return []
            like_patterns = [f"%{w}%" for w in words[:3]]
            stmt = select(FileMetadataRow.id).where(
                or_(*[FileMetadataRow.summary.like(p) for p in like_patterns])
            )
            result = await db.execute(stmt)
            return [r[0] for r in result.all()]


# 全局单例
tag_store = TagStore()
