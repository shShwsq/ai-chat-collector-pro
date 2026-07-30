# tools/ 工具 handler 子包开发指南

> 一句话定位：本目录是 KWA 后端 services 层的"工具 handler 子包"，4 个 `.py` 文件按职责拆分：`file_tools`（文件读写）、`system_tools`（系统交互）、`task_tools`（会话任务列表）、`graph_tools`（图谱工具封装），供 `tool_registry` 注册为 Function Calling 工具供 `MainAgent` 调用。

## 模块职责

```
tools/
├── __init__.py          # 聚合 file_tools / system_tools / task_tools 导入
├── file_tools.py        # 文件读写与目录列表（file_read / file_write / file_list + register_file_tools）
├── system_tools.py      # 系统交互（command_exec / open_app / open_url / system_notification / screenshot / clipboard_read / clipboard_write）
├── task_tools.py        # 会话内存级任务列表（TaskStore + task_* handler 工厂）
└── graph_tools.py       # 图谱工具封装（7 个 graph_* handler + HIGH_RISK_TOOLS + 模式白名单）
```

## 关键文件

### `__init__.py`：聚合导入

聚合 `file_tools` / `system_tools` / `task_tools` 的导入（`graph_tools` 由 `tool_registry.register_default_tools` 直接 import，不在此聚合）。`__all__` 导出三类工具的公开符号，便于上层 `from app.services.tools import file_read` 直接使用。

**注意**：`__init__.py` **不**注册工具到 `tool_registry`，注册由 `tool_registry.register_default_tools()` 统一负责。

### `file_tools.py`：文件读写与目录列表

提供 `file_read` / `file_write` / `file_list` 三个 handler，另提供 `register_file_tools` 便捷注册函数，将三个工具连同 schema 注册到指定 `ToolRegistry`，供 `writer_agent` 工具循环等场景独立使用（无需经过 `register_default_tools` 全量注册）。

**设计要点**：
1. **同步 IO 包裹 `asyncio.to_thread`**：避免阻塞事件循环。
2. **路径解析**：绝对路径直接使用；相对路径相对于 `settings.data_dir` 解析，便于 Agent 用简短名操作数据目录内文件。
3. **路径穿越防护**：`_is_path_traversal` 检查路径是否包含 `..` 段（反斜杠统一为正斜杠后按段检查，避免误判合法文件名）。
4. **Plan 模式限制**：`file_read` 在 Plan 模式仅允许读取 `settings.data_dir/files/`（用户上传目录）。
5. **Build 模式禁止系统敏感目录**：`_FORBIDDEN_READ_PREFIXES` 含 `C:\Windows\System32\config` 等前缀，命中即拒绝。
6. **单文件大小限制**：`_DEFAULT_MAX_SIZE = 100_000`（约 100KB）。
7. **模式感知**：handler 从 `args["_mode"]` 读取当前模式（由 `ToolRegistry.execute` 注入；未注入按 Build 处理）。

### `system_tools.py`：系统交互

提供 7 个系统交互 handler：

| handler | Plan | Build | 说明 |
|---------|------|-------|------|
| `command_exec` | ❌ | ✅ | 执行 shell 命令（PowerShell + 异步 + 超时 + 黑名单） |
| `open_app` | ❌ | ✅ | 打开本地应用程序（`subprocess.Popen`） |
| `open_url` | ✅ | ✅ | 用默认浏览器打开 URL（`webbrowser.open`，校验 http/https） |
| `system_notification` | ✅ | ✅ | 系统桌面通知（PowerShell toast） |
| `screenshot` | ✅ | ✅ | 截取主屏并保存 PNG（`PIL.ImageGrab`） |
| `clipboard_read` | ✅ | ✅ | 读取剪贴板文本（PowerShell `Get-Clipboard`） |
| `clipboard_write` | ❌ | ✅ | 写入剪贴板文本（PowerShell `Set-Clipboard`） |

**设计要点**：
1. **阻塞调用包裹 `asyncio.to_thread` 或 `asyncio.create_subprocess_*`**：避免阻塞事件循环。
2. **Windows 为主平台**：命令执行用 PowerShell，剪贴板 / 通知用 PowerShell。
3. **危险命令黑名单 `_COMMAND_BLACKLIST`**：覆盖 POSIX 自毁（`rm -rf /` / `mkfs` / `dd if=/dev/zero` / fork bomb）与 Windows 自毁（`format c:` / `del /f /s /q C:\` / `shutdown` / `diskpart`），小写子串匹配，命中即拒绝。
4. **默认超时 `_DEFAULT_TIMEOUT = 30`** 秒。
5. **`open_url` 协议白名单**：仅允许 `http://` / `https://`。

### `task_tools.py`：会话内存级任务列表

提供 `TaskStore` 类与 `make_task_handlers()` / `make_placeholder_task_handlers()` 两个 handler 工厂，供 `ToolRegistry` 注册 `task_create` / `task_list` / `task_update` / `task_delete` 四个工具。

**设计要点**：
1. **会话内存级**：`TaskStore` 实例存于 `MainAgent` 实例 attribute，会话结束即释放，不持久化。
2. **任务状态**：`pending` / `in_progress` / `completed` / `deleted`（`_VALID_STATUSES`），`task_list` 不返回 `deleted` 任务。
3. **非线程安全**：单会话单事件循环，无需加锁。
4. **闭包绑定会话**：handler 通过 `task_store_getter` 闭包绑定会话，仿 `append_note` 的 `session_id_getter` 模式。
5. **Plan + Build 均可用**：规划是只读操作。
6. **`make_placeholder_task_handlers`**：当 `MainAgent` 未就位时返回占位 handler（始终返回 `{"status": "error", "message": "task store not available"}`），便于 `register_default_tools` 在初始化阶段调用。

### `graph_tools.py`：图谱工具封装（Task 7）

把 `GraphAgent` / `GraphStore` 能力包装为 7 个 Function Calling 工具：

| 工具名 | Plan | Build | 高风险 | 说明 |
|--------|------|-------|--------|------|
| `graph_query_nodes` | ✅ | ✅ | ❌ | 按关键词查询图谱节点 |
| `graph_get_node_detail` | ✅ | ✅ | ❌ | 获取节点详情 |
| `graph_get_context` | ✅ | ✅ | ❌ | 获取图谱全貌上下文 |
| `graph_extract_from_observation` | ❌ | ✅ | ✅ | 从观察对话抽取节点（写入图谱） |
| `graph_generate_quiz` | ✅ | ✅ | ❌ | 基于图谱生成测验题 |
| `graph_generate_trends` | ✅ | ✅ | ❌ | 分析行业风口（仅 work 图谱） |
| `graph_generate_report` | ✅ | ✅ | ❌ | 生成工作报告（仅 work 图谱） |

**设计要点**：
1. **延迟导入**：`graph_agent` / `graph_store` 在 handler 内部导入，避免 `tool_registry.register_default_tools` → `register_graph_tools` → `graph_agent` 的循环依赖（`MainAgent.__init__` 同时 import `graph_agent` 与 `tool_registry`）。
2. **统一错误兜底**：每个 handler 捕获所有异常返回 `{"status": "error", ...}`，不抛异常给工具循环（对齐 `ToolRegistry.execute` 的契约）。
3. **`HIGH_RISK_TOOLS = {"graph_extract_from_observation"}`**：模块顶部定义，供 `main_agent._intercept_high_risk_tool` 查询。
4. **`get_tools_for_mode(scenario_mode, plan_mode)`**：按场景模式（study / work）+ plan_mode 的白名单过滤：
   - Study 模式（任何 plan/build）：暴露全部 7 个工具（高风险走拦截）
   - Work 模式 Build：暴露全部 7 个工具
   - Work 模式 Plan：仅暴露 6 个只读工具（`READONLY_GRAPH_TOOLS`）
5. **落库由 `GraphAgent` 内部负责**：本模块只做参数透传与结果包装，不直接操作 DB。

**`graph_extract_from_observation` 返回结构扩展**：配合 graph_agent 的**分块抽取**升级，该 handler 的成功返回结构新增 3 个元数据字段（与 graph_agent 返回一致）：
```python
{
    "status": "ok",
    "observation_id": "...",
    "graph_type": "study|work",
    "nodes": [...],           # 不变：清洗后的节点列表
    "count": N,                # 不变：len(nodes)
    # ===== 以下 3 个字段为新增 =====
    "truncated": bool,         # 是否触发分块抽取（原对话超过单块 6000 字符）
    "segment_count": int,      # 实际分块数（短对话为 1）
    "original_length": int,    # 原对话字符数（用于调试/统计）
}
```
兼容性：handler 内部对 graph_agent 的返回做 `isinstance(result, dict)` 判断——新版（dict）解析新增字段，旧版或降级路径（list）默认 `truncated=false`、`segment_count=1 if nodes else 0`、`original_length=0`。LLM 不可用或抽取失败时 `nodes=[]`，其余字段仍有合理默认值。

## 工具 handler 签名约定

所有 handler 统一签名：

```python
async def handler(**args: dict[str, Any]) -> dict[str, Any]:
    ...
```

- **`args`**：来自 LLM 的 `tool_call.arguments`（已 JSON 反序列化为 dict），含以下隐式字段：
  - `_mode`：`"plan"` / `"build"`，由 `ToolRegistry.execute` 注入（未注入时按 `"build"` 处理，保证可独立调用）
- **返回值**：`dict[str, Any]`，必须含 `status` 字段：
  - `{"status": "ok", ...}`：成功，附加字段由 handler 自定义
  - `{"status": "error", "message": "..."}`：失败，`message` 是人类可读的失败原因
  - `{"status": "not_found", ...}`：部分 handler（如 `graph_get_node_detail`）用于资源不存在场景
- **不抛异常**：handler 内部捕获所有异常并返回 `{"status": "error", ...}`，由 `ToolRegistry.execute` 将其作为 `tool_result` 推给 LLM。

## plan/build 模式白名单规则

| 模式 | 允许的工具类别 |
|------|---------------|
| **Plan**（规划模式） | 仅只读工具：`file_read`（限 `data_dir/files/`）/ `file_list` / `open_url` / `system_notification` / `screenshot` / `clipboard_read` / `task_*` / 6 个只读图谱工具 |
| **Build**（执行模式） | 所有工具，含 `file_write` / `command_exec` / `open_app` / `clipboard_write` / `graph_extract_from_observation`（高风险，需用户确认） |

**实现位置**：每个工具在 `ToolRegistry.register` 时通过 `allowed_modes` 参数声明（如 `["plan", "build"]` / `["build"]`）。`ToolRegistry.execute(mode="plan")` 会按 `allowed_modes` 过滤，Plan 模式下不可见的工具调用直接返回 `{"status": "error", "message": "tool not available in plan mode"}`。

**高风险工具的二次拦截**：即使在 Build 模式下，`HIGH_RISK_TOOLS` 中的工具由 `MainAgent._intercept_high_risk_tool` 在 `ToolRegistry.execute` 之前拦截：
- Plan 模式：直接拒绝（不弹框，回填拒绝原因）
- Build 模式：通过 WS 推送 `chat_tool_call_confirmation` 事件，等待用户确认 / 60s 超时（`TOOL_CONFIRMATION_TIMEOUT`）

## 新增工具流程

1. **写 handler**：在对应 `*_tools.py` 加 `async def new_tool(args: dict[str, Any]) -> dict[str, Any]`，遵循"不抛异常 + 返回 `status` 字段"约定。
2. **构造 schema**：用 `_build_schema(name, description, properties, required)` 构造 OpenAI function calling 格式 schema（或直接手写 dict）。
3. **注册**：
   - 同类工具的批量注册：在文件末尾的 `register_*_tools(registry)` 函数末尾追加 `(name, schema, allowed_modes, handler)` 元组到 `_XXX_TOOL_DEFS` 列表。
   - 跨类别工具：在 `tool_registry.register_default_tools()` 末尾追加 `registry.register(name, schema, handler, allowed_modes)`。
4. **如为高风险**：在对应 `*_tools.py` 顶部将工具名加入 `HIGH_RISK_TOOLS` 集合（供 `main_agent._intercept_high_risk_tool` 查询）。
5. **如需模式白名单**：在 `get_tools_for_mode` 或 `MainAgent` 的工具列表构造中处理（图谱工具用 `graph_tools.get_tools_for_mode`）。

**验证**：在 `MainAgent` 启动后查看 `tool_registry.list_tools()` 含新工具 → Plan 模式下不可见（或可见但只读）→ Build 模式下可调用 → 高风险工具触发 `chat_tool_call_confirmation` 事件。

## 安全注意事项

### 路径穿越检测

`file_tools._is_path_traversal` 检查路径是否包含 `..` 段：
- 反斜杠统一为正斜杠后按路径段检查，避免误判合法文件名中的 `..`。
- 命中即返回 `{"status": "error", "message": "path traversal not allowed"}`。

### 系统敏感目录黑名单

`file_tools._FORBIDDEN_READ_PREFIXES` 含：
- `c:\windows\system32\config`
- `c:/windows/system32/config`

Build 模式下也禁止读取（小写前缀匹配）。

### 危险命令黑名单

`system_tools._COMMAND_BLACKLIST` 含：
- POSIX 自毁：`rm -rf /` / `rm -rf /*` / `mkfs` / `dd if=/dev/zero` / `dd if=/dev/null` / fork bomb
- Windows 自毁：`format c:` / `del /f /s /q c:\` / `rd /s /q c:\` / `shutdown` / `diskpart`

小写子串匹配，命中即返回 `{"status": "error", "message": "command blocked by blacklist"}`。

### 高风险工具需用户确认

`HIGH_RISK_TOOLS` 中的工具（当前仅 `graph_extract_from_observation`）在 Build 模式下调用时：
1. `MainAgent._intercept_high_risk_tool` 拦截，通过 `ws_notify.notify_session` 推送 `chat_tool_call_confirmation` 事件。
2. 前端弹出 `ToolConfirmDialog`，用户点击"允许" / "拒绝"。
3. 后端通过 `resolve_tool_confirmation(confirmation_id, decision)` 接收用户决策，继续执行或回填拒绝原因。
4. 60 秒未确认（`TOOL_CONFIRMATION_TIMEOUT`）默认拒绝。

## 与上层的关系

- **被 `tool_registry.register_default_tools()` 调用**：`register_default_tools` 在 `MainAgent.__init__` 中调用，依次注册 `file_tools` / `system_tools` / `task_tools` / `graph_tools` 的全部工具到全局 `tool_registry` 单例。
- **被 `MainAgent` 通过 `tool_registry.execute()` 调用**：`MainAgent._run_tool_call` 接收 LLM 的 `tool_call` 事件，调 `tool_registry.execute(name, args, mode=...)` 触发对应 handler。
- **`graph_tools` 延迟导入 `graph_agent`**：避免循环依赖（`MainAgent.__init__` 同时 import `graph_agent` 与 `tool_registry`，若 `graph_tools` 在模块顶部 import `graph_agent`，则 `register_default_tools` → `register_graph_tools` → `graph_agent` 会形成环）。
- **`writer_agent` 复用 `file_tools`**：`WriterAgent` 拥有独立的 `ToolRegistry` 实例，通过 `register_file_tools` 注册 file_read / file_write / file_list，用于 checkpoint 写入与文件读取。
- **`task_tools` 绑定到 `MainAgent` 实例**：`MainAgent` 持有 `TaskStore` 实例，通过 `make_task_handlers(task_store_getter=lambda: self.task_store)` 注册 handler 闭包。

## 代码约定

### 异步 + 不抛异常

- 所有 handler `async def`，签名 `(args: dict[str, Any]) -> dict[str, Any]`。
- handler 内部捕获所有异常，返回 `{"status": "error", "message": ...}`，**不向上抛**。
- 同步 IO（文件 / subprocess / `PIL.ImageGrab`）包裹 `asyncio.to_thread` 或 `asyncio.create_subprocess_*`。

### 模式感知

- handler 从 `args["_mode"]` 读取当前模式（`"plan"` / `"build"`，未传入按 `"build"` 处理）。
- 模式相关的访问限制（如 Plan 模式 `file_read` 限 `data_dir/files/`）在 handler 内部实现。
- 模式可见性（Plan 模式下工具是否在 LLM 工具列表中暴露）由 `ToolRegistry` 的 `allowed_modes` 控制。

### 命名

- **模块文件**：全小写下划线（`file_tools.py` / `system_tools.py` / `task_tools.py` / `graph_tools.py`）。
- **handler 函数**：snake_case（`file_read` / `command_exec` / `graph_query_nodes`），不带 `_` 前缀（公开给 LLM 调用）。
- **内部辅助函数**：下划线前缀（`_is_path_traversal` / `_resolve_path` / `_is_dangerous_command` / `_build_schema`）。
- **常量**：全大写下划线（`_COMMAND_BLACKLIST` / `_FORBIDDEN_READ_PREFIXES` / `HIGH_RISK_TOOLS` / `ALL_GRAPH_TOOLS` / `READONLY_GRAPH_TOOLS`）。
- **注册函数**：`register_*_tools(registry)`（如 `register_file_tools` / `register_graph_tools`）。
- **handler 工厂**：`make_*_handlers(getter)`（如 `make_task_handlers` / `make_placeholder_task_handlers`）。

## 常见任务

### 任务 1：新增一个本地工具

**场景**：让 Agent 能查询当前系统时间。

**步骤**：
1. 在 `system_tools.py` 加 handler：
   ```python
   async def get_system_time(args: dict[str, Any]) -> dict[str, Any]:
       from datetime import datetime
       return {
           "status": "ok",
           "datetime": datetime.now().isoformat(),
           "timezone": str(datetime.now().astimezone().tzinfo),
       }
   ```
2. 在 `_SYSTEM_TOOL_DEFS`（或 `register_default_tools`）追加 schema + `allowed_modes=["plan", "build"]` + handler。
3. 重启后端，`tool_registry.list_tools()` 应含 `get_system_time`。

**验证**：在 MainAgent 对话中触发"现在几点"→ LLM 应调 `get_system_time` → 返回当前时间。

### 任务 2：新增一个图谱工具

**场景**：让 Agent 能查询图谱中某节点的所有入边。

**步骤**：
1. 在 `graph_tools.py` 加 handler `graph_get_node_inbound_edges`，内部 `from app.services.graph_store import graph_store` 延迟导入。
2. 在 `_GRAPH_TOOL_DEFS` 追加 `(name, schema, ["plan", "build"], handler)`。
3. 在 `__all__` 追加工具名。

**验证**：在 MainAgent 对话中触发"查节点的入边"→ LLM 应调 `graph_get_node_inbound_edges` → 返回边列表。

### 任务 3：将某工具标记为高风险

**场景**：新增一个会删除节点的工具 `graph_delete_node`，需要用户确认。

**步骤**：
1. 在 `graph_tools.py` 加 handler `graph_delete_node`。
2. 在 `_GRAPH_TOOL_DEFS` 追加元组，`allowed_modes=["build"]`（Plan 模式直接拒绝）。
3. 在 `HIGH_RISK_TOOLS` 集合追加 `"graph_delete_node"`。
4. （可选）更新 `get_tools_for_mode` 的 Work Plan 分支，确保高风险工具不在 Plan 模式暴露。

**验证**：Build 模式下触发"删除节点 X"→ 前端弹 `ToolConfirmDialog` → 用户允许后才执行；Plan 模式下直接拒绝。

## 注意事项（坑）

### `register_default_tools` 不自动调用

全局 `tool_registry` 单例在 `app.services.tool_registry` 模块加载时创建，但**不自动** `register_default_tools`。`MainAgent.__init__` 显式调用 `register_default_tools(tool_registry)` 注册全部默认工具。若你直接 `from app.services.tool_registry import tool_registry` 使用，需自行调用 `register_default_tools` 或单独调 `register_*_tools`。

### `writer_agent` 用独立 `ToolRegistry`

`WriterAgent` 不复用全局 `tool_registry`，而是新建 `ToolRegistry()` 实例并仅 `register_file_tools`。这是为了避免 Writer 拿到 MainAgent 的全部工具（如 `command_exec` 等高风险工具）。**不要**让 Writer 复用全局 `tool_registry`。

### `graph_tools` 必须延迟导入 `graph_agent`

`MainAgent.__init__` 同时 `import graph_agent` 与 `from app.services.tool_registry import register_default_tools`。若 `graph_tools` 在模块顶部 `from app.services.graph_agent import graph_agent`，则加载链为：

```
MainAgent → graph_agent → ...（OK）
MainAgent → tool_registry → register_default_tools → graph_tools → graph_agent（再次加载，但已部分加载）
```

虽然 Python 的 import 缓存通常能避免死锁，但会导致 `graph_agent` 在 `graph_tools` 加载时拿到部分初始化的模块引用。**统一在 handler 内部 import** 是最稳妥的做法。

### `task_tools` 非线程安全

`TaskStore` 用 `list` + `int` 计数器，未加锁。单会话单事件循环下没问题，但**不要**跨会话共享 `TaskStore` 实例，也不要在多线程中调用 handler。

## 下一步该读什么

| 你的角色 / 目标 | 下一步文档 |
|----------------|-----------|
| 要看 `tool_registry` 的工具注册与执行框架 | [../DEVELOPMENT.md](../DEVELOPMENT.md) 的 `tool_registry.py` 章节 |
| 要看 `MainAgent` 如何调用工具 / 高风险拦截 | [../DEVELOPMENT.md](../DEVELOPMENT.md) 的 `main_agent.py` 章节 |
| 要看 `WriterAgent` 如何用 `file_tools` | [../DEVELOPMENT.md](../DEVELOPMENT.md) 的 `writer_agent.py` 章节 |
| 要看 `GraphAgent` / `GraphStore` 的图谱能力 | [../graph_agent.py](../graph_agent.py) / [../graph_store.py](../graph_store.py) |
| 要看 `services` 整体架构 | [../DEVELOPMENT.md](../DEVELOPMENT.md) |
| 要看后端整体架构 | [../../../DEVELOPMENT.md](../../../DEVELOPMENT.md) |
