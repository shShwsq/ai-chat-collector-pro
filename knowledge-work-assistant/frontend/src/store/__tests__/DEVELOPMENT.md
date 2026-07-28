# store/__tests__/ 状态测试开发指南

> 一句话定位：本目录是 KWA 前端 `store/` 全局状态的测试套件，用 **vitest** 跑；当前含 `useAppStore.plugin-event.test.ts`（插件事件 + chat 事件处理测试）。本目录**不写 UI**，只做"状态 + 副作用"的回归测试，确保 [useAppStore.ts](../useAppStore.ts) 的 WS 事件处理 action 与 chat 流程在重构后行为不变。

## 模块职责

```
store/__tests__/
└── useAppStore.plugin-event.test.ts    # useAppStore 的 WS 事件处理 action 测试（5 个用例）
```

### `useAppStore.plugin-event.test.ts`

- 测试目标：[useAppStore.ts](../useAppStore.ts) 的 WS 事件处理 action（`handlePluginConversationReceived` + chat 系列 `handleChat*` + 工具确认 `confirmToolCall` / `rejectToolCall`）。
- 覆盖维度：插件对话事件 Toast + 待抽取刷新；chat token 累加；chat tool_call 追加；chat tool_confirmation 设置与确认 / 拒绝。

## 测试用例清单（5 个）

| 用例名 | 验证点 |
| --- | --- |
| `test_handlePluginConversationReceived_toast` | 收到插件对话事件后弹 Toast（文案含 `title`，类型为 `info`） |
| `test_handlePluginConversationReceived_refresh_pending_nodes` | study 模式图谱视图下，事件触发 `loadPendingObservations` |
| `test_chat_token_event` | `handleChatToken` 累加 `chatStreamingText` 为 `'你好'`，同步更新最后一条 assistant 消息 `content`（打字机效果） |
| `test_chat_tool_call_event` | `handleChatToolCall` 在最后一条 assistant 消息的 `tool_calls` 数组追加一条 `pending` 项 |
| `test_chat_tool_confirmation_event` | `handleChatToolConfirmation` 设置 `pendingToolConfirmation`；`confirmToolCall` 调 `api.confirmChatToolCall('r1', { approved: true })` + 清空；`rejectToolCall('用户拒绝')` 调 `api.confirmChatToolCall('r1', { approved: false, reason })` + 清空 |

## 测试约定

1. **mock `../../lib/api`**：用 `vi.mock('../../lib/api', ...)` 替换整个 api 模块；**保留 `ApiError` 类**（让 store 内的 `errMsg(e)` 仍能识别 `ApiError`），其余方法用 `vi.fn()` 占位。
2. **使用真实 `useAppStore`**：不 mock store 本身，通过 `useAppStore.getState()` / `useAppStore.setState()` 直接操作状态，验证 action 副作用。
3. **`beforeEach` 重置 store**：用 `setState({ ...initial }, true)` 重置，第二个参数 `true` 表示**替换而非合并**，确保用例间状态完全隔离。
4. **`clearAllMocks` 清调用记录**：每个用例前后用 `vi.clearAllMocks()` 清掉 mock fn 的调用记录，断言 `toHaveBeenCalledWith` 时只看到本用例的调用。
5. **`flushMicrotasks` 处理 fire-and-forget**：store 内有 fire-and-forget 的 Promise（如 `loadPendingObservations` 不 await），用 `flushMicrotasks` 等待微任务队列清空后再断言。
6. **vitest globals**：直接用 `describe` / `it` / `expect` / `vi`（无需 import），由 vitest 配置注入 globals。

## 新增测试流程

1. 在 `__tests__/` 下新建 `*.test.ts`（如 `useAppStore.chat.test.ts` / `useAppStore.work.test.ts`）。
2. mock `../../lib/api` 模块（保留 `ApiError` 类）。
3. 用 `useAppStore.setState({ ...initial }, true)` 重置 store 到初始态。
4. 调用 action（如 `await useAppStore.getState().sendMessage('你好')`）。
5. 用 `useAppStore.getState()` 断言状态变化，或用 `vi.mocked(api.xxx).toHaveBeenCalledWith(...)` 断言 API 调用契约。
6. 异步副作用用 `flushMicrotasks` 等待。

## 常用命令

- `pnpm test`：跑全部测试。
- `pnpm test:watch`：watch 模式，文件改动自动重跑。
- `pnpm test src/store/__tests__/`：只跑本目录下全部测试。

## 扩展点

1. **chat 全流程测试**：当前只覆盖 chat 单个事件处理；可补齐 `sendMessage` → `handleChatToken`*N → `handleChatDone` 的完整流式链路测试。
2. **工具确认倒计时测试**：Task 10 工具确认有 `timeout` 倒计时；可用 `vi.useFakeTimers` 测试超时自动拒绝行为。
3. **Checkpoint 测试**：`loadCheckpoint` / `triggerCheckpoint` 的 API 调用与状态更新。
4. **Plan/Build 切换测试**：`setPlanMode(true/false)` 的状态切换与副作用。
5. **错误路径测试**：mock api 抛 `ApiError`，断言 store 写入 `error` 状态 + 弹 Toast + 返回 falsy。

## 注意事项

1. **`setState({...initial}, true)` 第二参数**：必须传 `true`，否则是合并语义，上一用例的 `chatMessages` 等数组字段会残留。
2. **mock api 保留 `ApiError`**：store 内 `errMsg(e)` 用 `e instanceof ApiError` 判断；mock 时必须把真实 `ApiError` 类透传出去，否则错误路径行为不一致。
3. **fire-and-forget 不要 await**：store 内 `handlePluginConversationReceived` 触发 `loadPendingObservations` 但不 await；测试时用 `flushMicrotasks` 等待，不要直接 `await` action 返回值。
4. **`clearAllMocks` 时机**：在 `beforeEach` 中调用，确保每个用例看到的 mock 调用记录都是干净的；如需在用例内多次断言，可在断言间再次 `clearAllMocks`。
5. **不 mock zustand**：zustand 本身无需 mock，真实 store 即可；如需测试选择器订阅，可在测试组件层用 `@testing-library/react` 单独覆盖。
6. **测试文件不进入构建产物**：vitest 配置的 `include` 仅匹配 `*.test.ts`，普通源码文件不受影响；测试文件不会被 Vite 打包进生产产物。
