"""应用配置。

基于 pydantic-settings 从环境变量 / .env 文件加载配置。
包含 LLM、数据库、数据目录、CORS 等占位项，后续按需扩展。

本项目端口约定：
- 后端 FastAPI 监听 **8788**（避免和步影 8787 冲突）
- 前端 Vite dev server 监听 **5174**（避免和步影 5173 冲突）
"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ===== 运行环境 =====
    app_env: str = "development"

    # ===== CORS 允许来源 =====
    # 默认允许前端 Vite dev server（5174）与 Electron 的 file:// 来源
    cors_origins: list[str] = [
        "http://localhost:5174",
        "file://",
    ]

    # ===== LLM 配置 =====
    llm_base_url: str = "https://api.openai.com/v1"
    llm_api_key: str = ""
    llm_model: str = "gpt-4o-mini"
    llm_context_window: int = 128000

    # ===== 数据与存储 =====
    # 数据目录指向本项目自己的 backend/data/
    data_dir: Path = Path("./data")
    database_url: str = "sqlite+aiosqlite:///./data/app.db"

    # ===== 后端监听端口（仅用于 python -m app.main 直接启动；uvicorn 命令用 --port 8788）=====
    backend_port: int = 8788

    # ===== 加密 key（敏感字段加密存储）=====
    # 留空时由 services.crypto 自动生成并落盘到 data_dir/.encryption_key
    encryption_key: str = ""

    def ensure_dirs(self) -> None:
        """确保运行所需目录存在。

        创建 data_dir 及其子目录 files（上传文件落盘）/ sessions（会话级数据，
        复用步影思路）。开发期创建在当前工作目录下。
        """
        self.data_dir.mkdir(parents=True, exist_ok=True)
        (self.data_dir / "files").mkdir(parents=True, exist_ok=True)
        (self.data_dir / "sessions").mkdir(parents=True, exist_ok=True)


settings = Settings()
