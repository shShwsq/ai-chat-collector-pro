"""系统提示词目录（Task 4 适配移植）。

存放 MainAgent 与 WriterAgent 的系统提示词 markdown 文件：

- ``main_agent_system.md``：主 Agent 系统提示词，定义对话回声身份、
  Study/Work 双模式职责、Plan/Build 模式工具白名单、图谱工具使用说明、
  高风险工具拦截流程、任务规划与输出规范。
- ``writer_system.md``：Writer Subagent 系统提示词，定义 11 字段 checkpoint.md
  的写入格式与工作原则。

MainAgent / WriterAgent 通过 ``Path(__file__).parent / "prompts" / "*.md"``
读取（延迟加载 + 模块级缓存，避免每次对话都 IO 磁盘）。

KWA 适配说明（相对步影原版）：
- ``main_agent_system.md`` 重写为对话回声身份，新增 Study/Work 双模式与
  图谱工具使用说明，移除 web_search / skill_list / skill_activate /
  checkpoint_search / message_search / deep_search 的工具说明（KWA 未移植）。
- ``writer_system.md`` 保留 11 字段 checkpoint 记录逻辑（与步影一致），仅裁剪
  步影特有的场景示例。
- 步影原版的 ``search_system.md`` / ``summarize_system.md`` 不移植（KWA 无对应
  SearchAgent / SummarizeAgent 子 agent）。
"""

from __future__ import annotations

from pathlib import Path

_PROMPTS_DIR: Path = Path(__file__).parent

MAIN_AGENT_SYSTEM_PROMPT_PATH: Path = _PROMPTS_DIR / "main_agent_system.md"
WRITER_SYSTEM_PROMPT_PATH: Path = _PROMPTS_DIR / "writer_system.md"


def load_main_agent_system_prompt() -> str:
    """读取主 Agent 系统提示词（每次调用都读盘，便于热更新）。"""
    return MAIN_AGENT_SYSTEM_PROMPT_PATH.read_text(encoding="utf-8")


def load_writer_system_prompt() -> str:
    """读取 Writer Subagent 系统提示词（每次调用都读盘，便于热更新）。"""
    return WRITER_SYSTEM_PROMPT_PATH.read_text(encoding="utf-8")


__all__ = [
    "MAIN_AGENT_SYSTEM_PROMPT_PATH",
    "WRITER_SYSTEM_PROMPT_PATH",
    "load_main_agent_system_prompt",
    "load_writer_system_prompt",
]
