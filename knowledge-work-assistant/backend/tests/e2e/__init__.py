"""端到端集成测试包。

涵盖插件推送 → 后端 webhook 落库 → WS 广播 完整链路：

- ``test_plugin_webhook.py``：webhook 单元测试（POST /api/plugin/conversations 等）
- ``test_plugin_ws_broadcast.py``：WS 广播 + 完整链路 e2e 测试
"""
