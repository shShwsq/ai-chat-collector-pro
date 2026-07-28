# lib/__tests__/ 库测试开发指南

> 一句话定位：本目录是 KWA 前端 `lib/` 通信层的测试套件，用 **vitest** 跑；当前含 `kwa-push.test.ts`（SDK 单元测试）。本目录**不写业务逻辑**，只做"通信层 + 类型契约层"的回归测试，确保 [api.ts](../api.ts) / [ws.ts](../ws.ts) / 节点模板镜像 / SDK 在重构后行为不变。

## 模块职责

```
lib/__tests__/
└── kwa-push.test.ts    # plugin-sdk/kwa-push.js SDK 单元测试（5 个用例）
```

### `kwa-push.test.ts`

- 测试目标：[`plugin-sdk/kwa-push.js`](../../../../plugin-sdk/kwa-push.js) SDK 的 `pushConversation` 方法。
- 覆盖维度：成功路径 + 请求体契约 + 重试退避 + 去重透传 + 重试耗尽 + 客户端校验。

## 测试用例清单（5 个）

| 用例名 | 验证点 |
| --- | --- |
| `test_pushConversation_success` | 成功推送 + 请求体契约（camelCase → snake_case 转换）+ 返回值解析 |
| `test_pushConversation_retry` | 前 3 次失败、第 4 次成功；退避序列 500ms / 1000ms / 2000ms；`vi.useFakeTimers` + `advanceTimersByTimeAsync` |
| `test_pushConversation_dedup` | 后端返回 `deduplicated: true` 时 SDK 原样透传 |
| `test_pushConversation_all_retry_failed` | 所有 fetch reject 时重试耗尽抛 `KwaPushError`；fetch 调用次数 = `maxRetries + 1` |
| `test_pushConversation_missing_required_field` | 缺 `platform` 字段时客户端校验直接抛错 |

## 测试约定

1. **mock `global.fetch`**：用 `vi.stubGlobal('fetch', fetchMock)` 注入 mock，断言调用次数 / 请求体 / URL。
2. **重置 SDK 全局默认配置**：`afterEach` 用 `configure(...)` 还原默认值，避免用例间污染。
3. **CJS 模块无类型声明**：`kwa-push.js` 是 CJS 模块无 `.d.ts`，用 `@ts-ignore` 抑制 TS 错误。
4. **精确推进退避时长**：`vi.useFakeTimers` + `advanceTimersByTimeAsync` 按退避序列（500 / 1000 / 2000ms）逐步推进，验证重试节奏。
5. **vitest globals**：直接用 `describe` / `it` / `expect` / `vi`（无需 import），由 vitest 配置注入 globals。

## 新增测试流程

1. 在 `__tests__/` 下新建 `*.test.ts`（如 `api.test.ts` / `ws.test.ts`）。
2. mock 外部依赖（`global.fetch` / `WebSocket` / `window.electronAPI` 等）。
3. 用 vitest globals（`describe` / `it` / `expect`）组织用例，参考 `kwa-push.test.ts` 的结构。
4. 异步用例用 `async/await`；涉及定时器用 `vi.useFakeTimers` + `advanceTimersByTimeAsync`。
5. 在 `package.json` 的 `test` 脚本下自动会被 vitest 抓取（默认匹配 `**/*.test.ts`）。

## 常用命令

- `pnpm test`：跑全部测试。
- `pnpm test:watch`：watch 模式，文件改动自动重跑。
- `pnpm test src/lib/__tests__/kwa-push.test.ts`：只跑指定文件。

## 扩展点

1. **api.ts 单元测试**：当前未覆盖 [api.ts](../api.ts) 的 `request<T>` 封装与各 API 方法；可 mock `global.fetch` 后补齐 `getHealth` / `createGraph` / `listObservations` 等方法的请求构造与响应解包测试。
2. **ws.ts 单元测试**：当前未覆盖 [ws.ts](../ws.ts) 的 `TestSocket` 类；可 mock `WebSocket` 后补齐 `connect` / `send` / `onEvent` / `close` 测试。
3. **nodeTemplates.ts 镜像测试**：可加断言确保 `STUDY_SUBJECTS` / `WORK_OBJECTS` 与后端枚举一致（参考素材目录的对应文件）。
4. **快照测试**：对于稳定的请求体结构（如 `pushPluginConversation`），可用 `expect(body).toMatchSnapshot()` 锁定契约。

## 注意事项

1. **`kwa-push.js` 无类型声明**：SDK 是参考素材目录提供的 CJS 模块，无 `.d.ts`；测试文件用 `@ts-ignore` 抑制导入错误，不要为它单独补类型声明（超出本目录职责）。
2. **fake timers 与 Promise**：用 `advanceTimersByTimeAsync` 而非 `advanceTimersByTime`，前者会 flush 微任务队列，避免 Promise 卡住。
3. **`configure(...)` 副作用**：SDK 的 `configure` 修改模块级全局默认配置，必须在 `afterEach` 还原，否则污染其他用例。
4. **mock fetch 还原**：`vi.stubGlobal('fetch', ...)` 不会自动还原；用 `vi.unstubAllGlobals()` 或在 `afterEach` 显式还原。
5. **测试文件不进入构建产物**：vitest 配置的 `include` 仅匹配 `*.test.ts`，普通源码文件不受影响；测试文件不会被 Vite 打包进生产产物。
