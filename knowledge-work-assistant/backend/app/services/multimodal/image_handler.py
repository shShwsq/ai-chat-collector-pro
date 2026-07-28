"""图片处理器（Task 2 适配移植）。

将上传的图片文件转换为可直接送入 OpenAI 多模态消息的 base64 data URL：

- 用 Pillow 打开图片，统一转为 RGB（避免 RGBA / 调色板模式在 JPEG 编码时出错）
- 若宽或高超过 ``max_size``，按比例缩小（节省 token 与传输体积）
- 编码为 ``data:{mime};base64,...`` data URL，供 ``image_url`` 字段直接使用

同步 IO / CPU（Pillow 解码与编码均为同步）用 :func:`asyncio.to_thread` 包装，
避免阻塞事件循环。

本模块从步影 backend/app/services/multimodal/image_handler.py 适配拷贝而来，
KWA 的 ``pyproject.toml`` 已包含 ``Pillow>=10.3.0`` 依赖，无需修改。
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# 图片缩放上限（宽或高的最大像素），超出按比例缩小
_DEFAULT_MAX_SIZE = 1024

# MIME → Pillow 保存格式与质量参数
# 仅保留 Web 友好格式，避免发送 BMP / TIFF 等大体积分辨率格式给 LLM
_FORMAT_BY_MIME: dict[str, tuple[str, str]] = {
    "image/jpeg": ("JPEG", ".jpg"),
    "image/jpg": ("JPEG", ".jpg"),
    "image/png": ("PNG", ".png"),
    "image/webp": ("WEBP", ".webp"),
    "image/gif": ("GIF", ".gif"),
}
# 默认回退到 PNG（无损，支持透明）
_DEFAULT_FORMAT: tuple[str, str] = ("PNG", ".png")


def _encode_image_sync(
    file_path: str,
    max_size: int,
) -> dict[str, Any]:
    """同步：Pillow 打开 → 缩放 → base64 data URL。"""
    try:
        from PIL import Image  # Pillow
    except ImportError as exc:  # pragma: no cover - 依赖缺失异常
        return {
            "data_url": "",
            "width": 0,
            "height": 0,
            "original_size": 0,
            "resized": False,
            "error": f"Pillow 未安装: {exc}",
        }

    path = Path(file_path)
    if not path.exists() or not path.is_file():
        return {
            "data_url": "",
            "width": 0,
            "height": 0,
            "original_size": 0,
            "resized": False,
            "error": f"文件不存在: {file_path}",
        }

    original_size = path.stat().st_size
    try:
        with Image.open(path) as img:
            original_width, original_height = img.size
            # 计算缩放比例（仅缩小，不放大）
            scale = 1.0
            if max_size > 0 and (
                original_width > max_size or original_height > max_size
            ):
                scale = min(
                    max_size / original_width,
                    max_size / original_height,
                )
            new_width = max(1, int(original_width * scale))
            new_height = max(1, int(original_height * scale))
            resized = scale < 1.0

            if resized:
                # LANCZOS 高质量下采样
                img = img.resize(
                    (new_width, new_height), Image.Resampling.LANCZOS
                )

            # 统一为 RGB（JPEG 不支持 RGBA / 调色板）
            # 保留 GIF / PNG 的透明通道时跳过转换
            output_mime = _detect_image_mime(path, img)
            save_format, _ = _FORMAT_BY_MIME.get(
                output_mime, _DEFAULT_FORMAT
            )
            if save_format == "JPEG" and img.mode != "RGB":
                img = img.convert("RGB")

            buf = io.BytesIO()
            img.save(buf, format=save_format)
            data = buf.getvalue()
    except Exception as exc:  # noqa: BLE001 - Pillow 解码容错
        logger.warning("图片编码失败 %s: %s", file_path, exc)
        return {
            "data_url": "",
            "width": 0,
            "height": 0,
            "original_size": original_size,
            "resized": False,
            "error": f"图片处理失败: {exc}",
        }

    b64 = base64.b64encode(data).decode("ascii")
    data_url = f"data:{output_mime};base64,{b64}"
    return {
        "data_url": data_url,
        "width": new_width,
        "height": new_height,
        "original_size": original_size,
        "resized": resized,
        "error": None,
    }


def _detect_image_mime(path: Path, img: Any) -> str:
    """根据扩展名 / Pillow format 推断 MIME，仅保留 Web 友好格式。

    若为 BMP / TIFF 等大体积分辨率格式，回退为 PNG（LLM 普遍支持 PNG）。
    """
    suffix = path.suffix.lower()
    mime_by_suffix = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".gif": "image/gif",
    }
    if suffix in mime_by_suffix:
        return mime_by_suffix[suffix]
    fmt = (getattr(img, "format", "") or "").upper()
    fmt_map = {
        "JPEG": "image/jpeg",
        "PNG": "image/png",
        "WEBP": "image/webp",
        "GIF": "image/gif",
    }
    if fmt in fmt_map:
        return fmt_map[fmt]
    return "image/png"  # 兜底


async def encode_image_for_llm(
    file_path: str,
    max_size: int = _DEFAULT_MAX_SIZE,
) -> dict[str, Any]:
    """将图片文件编码为 OpenAI 多模态消息可用的 data URL。

    Args:
        file_path: 图片文件路径。
        max_size: 宽 / 高最大像素（超出按比例缩小，仅缩小不放大）。默认 1024。

    Returns:
        ``{
            "data_url": str,         # data:{mime};base64,... 格式
            "width": int,            # 处理后宽
            "height": int,           # 处理后高
            "original_size": int,    # 原始文件字节数
            "resized": bool,         # 是否发生缩放
            "error": str | None,     # 失败原因（成功为 None）
        }``
    """
    return await asyncio.to_thread(_encode_image_sync, file_path, max_size)
