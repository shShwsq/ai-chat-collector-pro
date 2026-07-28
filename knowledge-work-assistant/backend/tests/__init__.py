"""后端测试包。

测试目录组织：

- ``tests/conftest.py``：pytest fixture（tmp_db / async_client / mock_llm / app）
- ``tests/e2e/``：端到端集成测试（插件推送 → 落库 → WS 广播 完整链路）

测试隔离原则（参见 spec Requirement: 测试隔离与无 LLM 依赖）：

1. **临时 SQLite 数据库**：所有测试通过 ``tmp_db`` fixture 使用 ``tmp_path`` 创建的
   临时 SQLite 文件，monkeypatch ``settings.database_url`` 与
   ``app.db.engine`` / ``app.db.AsyncSessionLocal``，**不读写
   ``backend/data/app.db``**。
2. **无真实 LLM 依赖**：所有 LLM 调用通过 ``mock_llm`` fixture 替代，
   不发真实网络请求，可在无 API Key 环境下运行。
3. **HTTP 测试**：通过 ``httpx.AsyncClient`` + ``ASGITransport(app)``
   直连 FastAPI app，无需启动 uvicorn。
"""
