"""PyInstaller 打包入口。

直接传 app 对象给 uvicorn.run（而非字符串 ``'app.main:app'``），避免 PyInstaller
frozen 环境下字符串导入定位失败。host/port 从环境变量读取（Electron launcher
注入 BACKEND_PORT；host 默认 127.0.0.1 仅本机访问，不对外暴露）。
"""

import os

import uvicorn

from app.main import app

if __name__ == "__main__":
    uvicorn.run(
        app,
        host=os.environ.get("BACKEND_HOST", "127.0.0.1"),
        port=int(os.environ.get("BACKEND_PORT", "8788")),
        log_level="info",
    )
