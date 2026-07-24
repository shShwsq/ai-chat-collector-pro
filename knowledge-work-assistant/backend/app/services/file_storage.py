"""原文件本地存储管理。

负责将上传文件落盘到 ``settings.data_dir / files / {file_id}_{original_name}``，
并提供路径构造 / 删除 / 存在性检查。与 :class:`KnowledgeStore`（标签检索）
分工配合：

- :class:`FileStorage` 管理原文件字节（落盘 / 删除 / 路径）
- :class:`KnowledgeStore` 管理标签与摘要（打标签 / 检索 / 删除）

设计要点：

- 文件名经 :func:`_sanitize` 处理（仅保留 basename + 替换非法字符），避免路径穿越
- ``save`` 为 ``async`` 以适配 :meth:`UploadFile.read` 异步 IO；写盘为本地同步 IO
- ``get_path`` / ``delete`` / ``exists`` 为同步方法（本地磁盘 IO，调用快）
- 全局单例 :data:`file_storage` 供路由层共享

本项目从步影 backend/app/services/file_storage.py 适配拷贝而来，
数据目录指向本项目 backend/data/files/（由 config.ensure_dirs 创建）。
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from fastapi import UploadFile

from app.config import settings

logger = logging.getLogger(__name__)

# 文件名中需要替换的非法字符（路径分隔符 / 控制字符 / Windows 保留字符）
_INVALID_NAME_CHARS = re.compile(r'[\\/:*?"<>|\r\n\t]')


def _sanitize(name: str) -> str:
    """去掉文件名中可能引发路径问题的字符（仅保留 basename）。

    - 取 basename 防路径穿越（``../`` / 绝对路径）
    - 替换路径分隔符与 Windows 保留字符为 ``_``
    - 空名兜底为 ``"file"``
    """
    base = Path(name or "").name
    cleaned = _INVALID_NAME_CHARS.sub("_", base)
    return cleaned or "file"


class FileStorage:
    """原文件本地存储。

    Args:
        base_dir: 文件存放根目录，默认 ``settings.data_dir / "files"``。
    """

    def __init__(self, base_dir: Path = settings.data_dir / "files") -> None:
        self.base_dir: Path = Path(base_dir)
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def _filename(self, file_id: str, original_name: str) -> str:
        """构造存储文件名：``{file_id}_{sanitized_original_name}``。"""
        return f"{file_id}_{_sanitize(original_name or file_id)}"

    async def save(self, file: UploadFile, file_id: str) -> Path:
        """保存上传文件到 ``base_dir / {file_id}_{filename}``，返回保存路径。

        Args:
            file: FastAPI ``UploadFile``，内容会被读取并写盘。
            file_id: 文件唯一 ID（作为文件名前缀，避免重名冲突）。

        Returns:
            保存后的绝对路径。
        """
        original_name = file.filename or file_id
        path = self.base_dir / self._filename(file_id, original_name)
        content = await file.read()
        path.write_bytes(content)
        logger.info(
            "FileStorage.save file_id=%s path=%s size=%d",
            file_id,
            path,
            len(content),
        )
        return path

    def get_path(self, file_id: str, original_name: str) -> Path:
        """根据 ``file_id`` + ``original_name`` 构造存储路径（不检查存在性）。"""
        return self.base_dir / self._filename(file_id, original_name)

    def delete(self, file_id: str, original_name: str) -> bool:
        """删除文件，返回是否实际删除。

        Args:
            file_id: 文件唯一 ID。
            original_name: 原始文件名（用于定位存储路径）。

        Returns:
            文件存在且删除成功返回 ``True``；不存在或删除失败返回 ``False``。
        """
        path = self.get_path(file_id, original_name)
        try:
            if path.exists() and path.is_file():
                path.unlink()
                logger.info("FileStorage.delete file_id=%s path=%s", file_id, path)
                return True
            return False
        except OSError as exc:
            logger.warning("FileStorage.delete 失败 file_id=%s: %s", file_id, exc)
            return False

    def exists(self, file_id: str, original_name: str) -> bool:
        """检查文件是否存在。"""
        return self.get_path(file_id, original_name).exists()


# 全局单例
file_storage = FileStorage()
