"""Settings 表读写助手。

- 普通字段：JSON 序列化后存入 ``settings.value``
- 敏感字段（``llm.api_key`` / ``asr.mimo_api_key``）：经 crypto 加密后再 JSON 序列化

约定 key 命名空间见 ``app.models.db_models.Setting`` 文档字符串。
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.db_models import Setting
from app.services.crypto import decrypt, encrypt

# 需要加密存储的 key 集合
ENCRYPTED_KEYS: frozenset[str] = frozenset(
    {
        "llm.api_key",
        "asr.mimo_api_key",
    }
)


async def get_setting(db: AsyncSession, key: str, default: Any) -> Any:
    """读取普通设置（JSON 反序列化），不存在则返回 default。"""
    row = await db.get(Setting, key)
    if row is None or row.value is None:
        return default
    try:
        return json.loads(row.value)
    except (json.JSONDecodeError, TypeError):
        return default


async def set_setting(db: AsyncSession, key: str, value: Any) -> None:
    """写入普通设置（JSON 序列化）。"""
    serialized = json.dumps(value, ensure_ascii=False)
    row = await db.get(Setting, key)
    if row is None:
        db.add(Setting(key=key, value=serialized))
    else:
        row.value = serialized


async def get_secret(db: AsyncSession, key: str, default: str) -> str:
    """读取加密字段，返回明文。不存在或解密失败返回 default（明文）。"""
    row = await db.get(Setting, key)
    if row is None or not row.value:
        return default
    try:
        token = json.loads(row.value)
    except (json.JSONDecodeError, TypeError):
        return default
    if not isinstance(token, str) or not token:
        return default
    plain = decrypt(token)
    return plain if plain else default


async def set_secret(db: AsyncSession, key: str, plaintext: str) -> None:
    """写入加密字段：加密后 JSON 序列化存储。"""
    token = encrypt(plaintext)
    await set_setting(db, key, token)


def mask_secret(value: str) -> str:
    """敏感字段脱敏：``sk-***1234`` 形式（前 3 + *** + 后 4）。

    过短（<=8）的值整体替换为 ``*``，避免泄露长度信息。
    """
    if not value:
        return ""
    if len(value) <= 8:
        return "*" * len(value)
    return f"{value[:3]}***{value[-4:]}"
