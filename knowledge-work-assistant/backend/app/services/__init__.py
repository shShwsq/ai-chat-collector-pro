"""服务层：Agent 编排、LLM 调用、知识存储、文件管理、WebSocket 通知、
会话队列、设置存储、模型配置等业务服务。

本层模块从步影 backend/app/services/ 适配拷贝而来，核心职责保留：
- Agent 编排（sub_agent 已就位；main_agent 依赖未移植模块，见下文说明）
- LLM 调用（llm_client / llm_factory / llm_errors）
- 知识存储与检索（knowledge_store / tag_store）
- 文件管理（file_storage）
- WebSocket 通知（ws_notify）
- 会话队列（session_queue）
- 设置存储与加密（settings_store / crypto）
- 模型配置（model_config）

模块就位状态：
- 已就位（可被路由层直接 import 与使用）：
  - ``crypto`` / ``llm_errors`` / ``llm_client`` / ``model_config``
  - ``settings_store`` / ``ws_notify`` / ``session_queue``
  - ``tag_store`` / ``knowledge_store`` / ``file_storage``
  - ``llm_factory`` / ``sub_agent``
- 未就位（依赖步影其它未拷贝模块）：
  - ``main_agent``：依赖步影的 ``context_manager`` / ``mcp_manager`` /
    ``tool_registry`` / ``multimodal.image_handler`` / ``tools.task_tools``
    等模块，这些尚未拷贝到本项目。因此 ``main_agent`` 当前**未接入路由**
    且不能被直接 import；待后续 Task（Task 17）移植这些依赖后补齐。

数据目录指向本项目 backend/data/（由 config.ensure_dirs 创建 files/sessions 子目录）。

为避免在启动期触发 ``main_agent`` 的未解析依赖，本 ``__init__`` 不再聚合导出
步影的 MainAgent。调用方按需显式 import 单个模块。
"""

from __future__ import annotations
