"""敏感字段加密：基于 cryptography Fernet 对称加密。

加密 key 来源优先级：
1. 环境变量 ``APP_ENCRYPTION_KEY``
2. ``settings.data_dir / .encryption_key``（不存在则生成一次并落盘）

对外暴露两个顶层函数：
- ``encrypt(plaintext: str) -> str``：明文 -> token 字符串
- ``decrypt(ciphertext: str) -> str``：token 字符串 -> 明文

注意：``.encryption_key`` 文件位于 ``settings.data_dir``（本项目 backend/data/）下，
已被 ``.gitignore`` 中的 ``data/`` 规则覆盖，不会被 git 跟踪。
"""

from __future__ import annotations

from pathlib import Path
from threading import Lock

from cryptography.fernet import Fernet, InvalidToken

from app.config import settings

_KEY_FILE_NAME = ".encryption_key"
_fernet: Fernet | None = None
_lock = Lock()


def _load_or_create_key() -> bytes:
    """加载或生成 Fernet 加密 key。"""
    env_key = settings.encryption_key.strip() if settings.encryption_key else ""
    if env_key:
        return env_key.encode("utf-8")

    key_file: Path = settings.data_dir / _KEY_FILE_NAME
    if key_file.exists():
        return key_file.read_text(encoding="utf-8").strip().encode("utf-8")

    # 生成新 key 并落盘
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    key = Fernet.generate_key()
    key_file.write_text(key.decode("utf-8"), encoding="utf-8")
    # POSIX 上限制为 0o600；Windows chmod 不强制，简化处理
    try:
        key_file.chmod(0o600)
    except OSError:
        pass
    return key


def _get_fernet() -> Fernet:
    """惰性初始化 Fernet 单例。"""
    global _fernet
    if _fernet is None:
        with _lock:
            if _fernet is None:
                _fernet = Fernet(_load_or_create_key())
    return _fernet


def encrypt(plaintext: str) -> str:
    """加密明文，返回 token 字符串。空串原样返回（不加密）。"""
    if plaintext == "":
        return ""
    return _get_fernet().encrypt(plaintext.encode("utf-8")).decode("utf-8")


def decrypt(ciphertext: str) -> str:
    """解密 token 字符串，返回明文。

    空串或无法识别的 token 一律返回空串，避免单条坏数据导致整体接口 500。
    """
    if not ciphertext:
        return ""
    try:
        return _get_fernet().decrypt(ciphertext.encode("utf-8")).decode("utf-8")
    except (InvalidToken, ValueError):
        return ""
