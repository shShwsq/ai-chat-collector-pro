"""知识库检索（基于标签的 RAG，替代向量检索）。

本模块为标签检索的薄封装，真实逻辑在 :mod:`app.services.tag_store`。

历史接口（保留以兼容旧调用方）：
- :meth:`KnowledgeStore.add_file`：现改为返回 True（标签关联由 SummarizeAgent
  通过 :data:`tag_store.assign_tags_to_file` 完成）
- :meth:`KnowledgeStore.search`：转为委托 :data:`tag_store.search`
- :meth:`KnowledgeStore.delete_file`：委托 :data:`tag_store.remove_tags_from_file`
- :meth:`KnowledgeStore.list_files`：返回空（用 ``/knowledge/files`` 路由查询 DB）

新检索流程（见 :mod:`app.services.tag_store`）：
1. SummarizeAgent 生成摘要时同步生成 3-5 个标签，并写入标签库（去重）
2. SearchAgent 输出 tags / keywords / description（描述句为文档中可能的内容）
3. tag_store.search 三路检索 + 综合排序 + 分页

本项目从步影 backend/app/services/knowledge_store.py 适配拷贝而来，
依赖 :data:`app.services.tag_store.tag_store` 已就位。
"""

from __future__ import annotations

import logging
from typing import Any

from app.services.tag_store import tag_store

logger = logging.getLogger(__name__)


class KnowledgeStore:
    """知识库检索（基于标签的 RAG）。

    保留旧接口签名以兼容 SummarizeAgent / SearchAgent / 路由层，
    内部委托 :data:`app.services.tag_store.tag_store`。
    """

    async def add_file(
        self,
        file_id: str,
        content: str = "",
        summary: str = "",
        metadata: dict[str, Any] | None = None,
        tags: list[str] | None = None,
    ) -> bool:
        """索引文件（标签关联）。

        SummarizeAgent 生成 summary + tags 后调用本方法。
        本方法将 tags 关联到 file_id（自动入库新标签，去重）。
        content / summary 参数保留以兼容旧调用方，但不再用于向量检索。

        Args:
            file_id: 文件 ID。
            content: 文件内容（保留参数，未使用）。
            summary: 文件摘要（保留参数，未使用；摘要由 SummarizeAgent 直接写入 DB）。
            metadata: 附加元数据（保留参数，未使用）。
            tags: 标签列表（核心参数，写入标签库 + 关联表）。

        Returns:
            是否成功关联标签。
        """
        if not file_id:
            return False
        if not tags:
            logger.info("add_file 未提供 tags，跳过索引 file_id=%s", file_id)
            return True
        try:
            await tag_store.assign_tags_to_file(file_id, tags)
            logger.info(
                "add_file 成功 file_id=%s tags=%d", file_id, len(tags)
            )
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("add_file 失败 file_id=%s: %s", file_id, exc)
            return False

    async def search(
        self,
        query: str = "",
        top_k: int = 10,
        tags: list[str] | None = None,
        keywords: list[str] | None = None,
        description: str = "",
        page: int = 1,
        page_size: int | None = None,
    ) -> list[dict[str, Any]]:
        """检索知识库。

        兼容旧签名 ``search(query, top_k)`` 与新签名
        ``search(tags=, keywords=, description=, page=, page_size=)``。

        旧签名（仅 query + top_k）：当 query 非空但 tags/keywords/description 都为空时，
        将 query 作为 keyword 单独检索，page_size = top_k。

        新签名（tags/keywords/description 任一非空）：三路检索，page_size 默认 10。

        Returns:
            结果列表（每项含 file_id / original_name / summary / tags / score 等）。
        """
        has_new_params = any([tags, keywords, description])
        if not has_new_params and query:
            # 旧签名兼容：query 作为 keyword
            keywords = [query]
            if page_size is None:
                page_size = max(1, top_k)

        if page_size is None:
            page_size = 10

        try:
            result = await tag_store.search(
                tags=tags,
                keywords=keywords,
                description=description,
                page=page,
                page_size=page_size,
            )
            return result.get("results", [])
        except Exception as exc:  # noqa: BLE001
            logger.warning("search 失败 query=%r: %s", query, exc)
            return []

    async def delete_file(self, file_id: str) -> bool:
        """删除文件的全部标签关联。"""
        try:
            await tag_store.remove_tags_from_file(file_id)
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("delete_file 失败 file_id=%s: %s", file_id, exc)
            return False

    async def list_files(self, limit: int = 100) -> list[dict[str, Any]]:
        """列出已索引文件（已由 ``/knowledge/files`` 路由直接查询 DB 替代）。

        本方法保留以兼容旧调用方，返回空列表。
        """
        return []

    async def count(self) -> int:
        """返回标签库中标签总数（近似知识库规模）。"""
        tags = await tag_store.get_all_tags()
        return len(tags)


# 全局单例
knowledge_store = KnowledgeStore()
