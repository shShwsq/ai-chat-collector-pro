"""多模态输入处理（Task 2 适配移植）。

KWA 适配说明（相对步影原版）：
- 仅移植 ``image_handler.encode_image_for_llm``（图片 → base64 data URL）。
- 步影原版的 ``audio_handler``（ffmpeg 音频转码）与 ``document_parser``
  （PDF/Word 解析）暂不移植：KWA 当前无 ASR 流水线与文档解析路由需求，
  Pillow 已在 KWA ``pyproject.toml`` 依赖中，图片处理能力即可覆盖主要多模态场景。
- 后续如需文档解析，可补充 ``document_parser.py``（依赖 pypdf / python-docx，
  KWA 已有这两个依赖）。
"""

from __future__ import annotations

from app.services.multimodal.image_handler import encode_image_for_llm

__all__ = [
    "encode_image_for_llm",
]
