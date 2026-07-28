# frontend/ 前端开发指南

> 一句话定位：本目录是 KWA 软件侧的前端工程，由 **Electron 31 + React 18 + TypeScript 5 + Vite 5** 构成桌面应用骨架。`electron/` 子目录承担主进程 / preload / 后端启动器（CommonJS 编译产物），`src/` 子目录承担渲染进程的 React 应用（ESM + Vite HMR）。本文件只描述前端顶层骨架与子目录导航，子目录细节请见各自 DEVELOPMENT.md。

## 与 web-ai-chat-collector 的关系（软件 + 插件一体化）

本目录是 KWA 软件侧的前端，与插件侧 [web-ai-chat-collector](../../web-ai-chat-collector/DEVELOPMENT.md) 的关系如下：

- **通过后端间接交互**：前端**不直接**与 collector 通信，所有 collector 推送的数据经 KWA 后端 `POST /api/plugin/conversations` 落库后，前端通过 `GET /api/plugin/conversations/recent` 拉取展示。
- **WebSocket 事件订阅**：[src/App.tsx](./src/App.tsx) 启动时连 `/ws?session_id=<uuid>`，订阅 `plugin.conversation_received` 事件；collector 推送成功后后端广播此事件，前端收到后弹 Toast 并刷新"待抽取"侧栏。
- **PluginIntegrationSection 组件**：[src/components/PluginIntegrationSection.tsx](./src/components/PluginIntegrationSection.tsx) 展示 collector 最近推送的对话列表 + 接口契约 + 复制推送 URL 按钮，供用户在设置页查看 collector 对接状态。
- **两套独立 UI**：本目录的图谱 UI（GraphView / NodeDetailCard 等）与 collector 的悬浮球 UI（[content/ui/](../../web-ai-chat-collector/content/ui/DEVELOPMENT.md)）是**两套完全独立的 UI**，互不依赖、互不通信。
- **UI 风格统一 patch**：应用 [plugin-sdk/secondary-dev/styles.patch.js](../plugin-sdk/secondary-dev/styles.patch.js) patch 后，collector 悬浮球颜色会随 KWA 模式（study 墨绿 / work 琥珀）联动（CSS 变量 `--kwa-accent`）；本前端自身的样式不受影响。
- **类型契约不共享**：本目录 [src/lib/types.ts](./src/lib/types.ts) 与 collector 的代码无类型共享（collector 是纯 JS，无 TypeScript）；`PluginConversationRequest` 等 schema 仅在后端 `schemas.py` 与前端 `types.ts` 之间一一对应。

跨子工程任务（启用推送、UI 风格统一、并行开发联调等）请参考工作区根 [DEVELOPMENT.md](../../DEVELOPMENT.md) 的"常见跨子工程任务"章节。

## 模块职责

```
frontend/
├── electron/                  # 主进程 / preload / 后端启动器（详见 electron/DEVELOPMENT.md）
│   ├── main.ts                #   Electron 主进程入口：窗口创建 + IPC 注册 + 生命周期
│   ├── preload.ts             #   contextBridge 桥：向渲染进程暴露 electronAPI.backend.getUrl/getWsUrl
│   ├── launcher.ts            #   生产环境后端子进程启动器（spawn uvicorn + 健康检查轮询）
│   ├── tsconfig.json          #   主进程 TS 配置：CommonJS 输出，target ES2022
│   └── package.json           #   { "type": "commonjs" }（覆盖根 package.json 的 module）
│
├── src/                       # 渲染进程 React 应用（详见 src/DEVELOPMENT.md）
│   ├── App.tsx                #   根组件：header + SideNav + 主内容区 + Toast + WebSocket 订阅
│   ├── main.tsx               #   React 入口：挂载 <App /> 到 #root
│   ├── components/            #   React 组件（含 graph/ 子目录：图谱可视化与节点编辑；ChatExpandedOverlay 大卡浮层 / ToolConfirmDialog 高风险工具确认）
│   ├── lib/                   #   api / ws / types / electron.d.ts / nodeTemplates
│   ├── store/                 #   Zustand 全局状态（useAppStore 单一 store）
│   └── styles/                #   animations.css + app.css（BEM 风格，无 CSS-in-JS）
│
├── index.html                 # Vite 入口 HTML（含 <div id="root">）
├── package.json               # 依赖声明 + scripts（dev / dev:electron / build / dist）
├── vite.config.ts             # Vite 配置：base './' + port 5174 + proxy /api、/ws 到 8788
├── tsconfig.json              # 渲染进程 TS 配置：strict + bundler 模块解析 + react-jsx
├── .eslintrc.cjs              # ESLint 配置（含 react / react-hooks 插件）
├── pnpm-workspace.yaml        # pnpm 工作区配置
├── pnpm-lock.yaml             # pnpm 锁文件（勿用 npm/yarn 改动）
├── seed-graph.js              # 种子图谱注入脚本（调 API 注入最小 study 图谱，自检用）
└── .gitignore                 # 忽略 node_modules / dist / electron/dist / release
```

## 关键文件

| 文件 | 职责 | 关键内容 |
|------|------|---------|
| [package.json](./package.json) | 依赖与脚本 | `react 18.3` / `react-markdown 9` / `remark-gfm 4` / `d3-force 3` / `react-force-graph-2d 1.25` / `zustand 4.5`；scripts：`dev` / `dev:electron`（同时拉起 Vite + Electron）/ `build`（tsc + vite build）/ `build:electron`（主进程 TS 编译）/ `dist`（前端 + 主进程 + electron-builder NSIS）/ `test`（vitest run）/ `test:watch`（vitest watch）；devDependencies 新增 `vitest`；`build` 字段配置 appId / productName / NSIS / extraResources（含 backend/） |
| [vite.config.ts](./vite.config.ts) | Vite 配置 | `base: './'`（便于 Electron file:// 加载打包产物）；`server.port: 5174 strictPort: true`；`server.proxy`：`/api` → `http://127.0.0.1:8788`（timeout 5min，流式 LLM 用）、`/ws` → `ws://127.0.0.1:8788`；`build.outDir: 'dist'` |
| [tsconfig.json](./tsconfig.json) | 渲染进程 TS 配置 | `target: ES2022` / `module: ESNext` / `moduleResolution: bundler` / `jsx: react-jsx` / `strict: true` / `noUnusedLocals: true` / `noUnusedParameters: true` / `isolatedModules: true` / `noEmit: true`（Vite 用 esbuild 转译）；`include: ["src"]` |
| [index.html](./index.html) | Vite 入口 HTML | 含 `<div id="root">`；通过 `<script type="module" src="/src/main.tsx">` 引入 React 入口 |
| [seed-graph.js](./seed-graph.js) | 种子图谱脚本 | Node 脚本：调 `POST /api/graphs` 与 `POST /api/graphs/{id}/nodes` 注入最小 study 图谱，用于验证图谱可视化是否正常 |
| [.eslintrc.cjs](./.eslintrc.cjs) | ESLint 配置 | 启用 `@typescript-eslint` + `react` + `react-hooks` 插件；与 `pnpm lint` 配合 |
| [vitest.config.ts](./vitest.config.ts) | vitest 配置 | `environment: 'node'`；`globals: true`（允许 describe/it/expect 等全局写法）；`include: ['src/**/*.{test,spec}.{ts,tsx}']`；与 `pnpm test` / `pnpm test:watch` 配合 |

## 开发工作流

### 首次准备

```bash
cd knowledge-work-assistant/frontend
pnpm install                   # 安装依赖（首次；后续切分支 / 拉新代码后按需）
```

> **不要用 npm 或 yarn**——本项目用 pnpm 管理，lock 文件是 `pnpm-lock.yaml`，混用会污染依赖树。

### 日常开发（纯前端联调）

```bash
pnpm dev                       # 仅启动 Vite dev server（5174），不启动 Electron
# 浏览器访问 http://localhost:5174
```

适用场景：纯组件 / 状态 / 样式调整，不需要 Electron 主进程能力（IPC / 文件对话框 / 打包产物调试）。
后端需手动启动：`cd ../backend && uv run uvicorn app.main:app --reload --port 8788`。

### 桌面应用开发（Electron + Vite 同时）

```bash
pnpm dev:electron              # concurrently 同时跑：vite + wait-on tcp:5174 + electron .
```

脚本展开：
```bash
concurrently -k "vite" "wait-on tcp:5174 && npm run build:electron && cross-env VITE_DEV_SERVER_URL=http://localhost:5174 electron ."
```

- Vite 先起来监听 5174；
- `wait-on tcp:5174` 确认 Vite 就绪；
- `build:electron` 编译主进程 TS 到 `electron/dist/main.js`；
- `electron .` 启动 Electron，加载 `VITE_DEV_SERVER_URL`（HMR 可用）。

适用场景：调试主进程代码（`electron/*.ts`）、preload 桥、生产模式行为、IPC 通信、应用菜单 / 窗口属性。

### 改主进程代码后

`electron/main.ts` / `preload.ts` / `launcher.ts` 不支持 HMR，**改完必须重启 `pnpm dev:electron`**（Ctrl+C 后重新运行）。渲染进程代码（`src/**`）支持 HMR，无须重启。

### 类型检查与 Lint

```bash
pnpm typecheck                 # tsc --noEmit，仅校验类型，不输出文件
pnpm lint                      # eslint . --ext .ts,.tsx
```

PR 前建议都跑一遍。`tsconfig.json` 启用了 `noUnusedLocals` / `noUnusedParameters`，未使用的变量 / 入参会报错。

### 打包发布

```bash
pnpm dist                      # 完整打包流程
```

脚本展开：
```bash
npm run build:frontend && npm run build:electron && electron-builder --win
```

- `build:frontend`：`tsc && vite build`，输出到 `dist/`；
- `build:electron`：`tsc -p electron/tsconfig.json`，输出到 `electron/dist/`；
- `electron-builder --win`：按 `package.json` 的 `build` 字段配置生成 NSIS 安装包到 `release/`。
- `extraResources` 把 `../backend/`（排除 `__pycache__` / `.venv` / `data`）打到 `resources/backend/`，供 `launcher.ts` 在生产环境定位后端代码。

> 当前未配置 PyInstaller 打包后端为单文件，生产环境依赖目标机器已装 Python 3.12 + 依赖（`uv sync` 安装）。后续如需免 Python 部署，可在 `launcher.ts:resolveBackend()` 扩展 PyInstaller 产物探测逻辑。

## 代码约定

### 命名

- 组件文件 PascalCase：`GraphView.tsx` / `NodeDetailCard.tsx` / `ContentToolbar.tsx`；
- 普通 lib 文件 camelCase：`api.ts` / `ws.ts` / `nodeTemplates.ts`；
- React 组件用 `function XxxYyy()` 声明（不用箭头函数），便于 stack trace 与 React DevTools 识别；
- Hook 用 `useXxx`（`useAppStore` / `useMemo` / `useEffect`）；
- 类型用 PascalCase（`Graph` / `Node` / `Observation` / `QuizGradeResult`）；
- CSS 类名用 BEM：`app-header__title` / `health-badge--ok` / `content-area--chat`。

### 目录划分

- 组件放 `src/components/`，图谱相关子组件放 `src/components/graph/`；
- 库（API / WS / 类型 / 工具）放 `src/lib/`；
- 全局状态放 `src/store/`；
- 样式放 `src/styles/`；
- Electron 主进程放 `electron/`（与渲染进程严格隔离）。

### 状态管理

- 用 **Zustand** 单一 store（`src/store/useAppStore.ts`），不用 Redux / Context / Recoil；
- 组件通过 `useAppStore((s) => s.xxx)` 订阅切片，避免不必要重渲染；
- 全局动作（actions）集中在 store，组件层只调 action 不直接 fetch；
- 错误捕获在 store 的 action 内，写 `error` 状态而非抛出，组件层据此显示。

### 通信

- HTTP 经 `src/lib/api.ts` 单例 `api`，所有请求经此发出；自动处理 `/api` 前缀与 file:// 环境地址解析；统一抛 `ApiError`；
- WebSocket 经 `src/lib/ws.ts` 的 `TestSocket` 类，单例（`App.tsx` 的 `useRef` 持有）；`onEvent(cb)` 订阅事件，回调返回 `off` 取消函数；
- 渲染进程不直接 `require('electron')`，经 `window.electronAPI`（preload 桥暴露）访问主进程能力。

### 样式

- 用 CSS（`src/styles/app.css` + `animations.css`），不用 CSS-in-JS / Tailwind / CSS Modules；
- 模式切换通过 `data-mode="study|work"` 属性 + CSS 变量（`--kwa-accent` 等）实现，不内联样式；
- 浮层面板用 `position: absolute` + 半透明遮罩，组件内 `if (!panelOpen) return null` 控制显隐。

## 常见任务

### 任务 1：新增一个 React 组件

1. 在 `src/components/`（图谱相关放 `src/components/graph/`）新建 `XxxYyy.tsx`；
2. 用 `function XxxYyy(props: XxxYyyProps) { ... }` 声明，导出 `export function XxxYyy`；
3. 需要全局状态时通过 `useAppStore((s) => s.xxx)` 订阅切片；
4. 需要后端数据时调 `api.xxx()`，错误由 store action 捕获；
5. 需要浮层显隐时参考既有模式：`if (!panelOpen) return null` + store 中 `xxxPanelOpen` 状态；
6. 在 `App.tsx` 或父组件中渲染 `<XxxYyy />`；
7. `pnpm typecheck` 确认类型无误，`pnpm lint` 确认风格通过。

### 任务 2：新增一个 IPC 通道（如打开文件保存对话框）

1. 在 [electron/main.ts](./electron/main.ts) 的 `registerIpcHandlers` 加 `ipcMain.handle('dialog:save', async (event, payload) => { ... })`；
2. 在 [electron/preload.ts](./electron/preload.ts) 的 `contextBridge.exposeInMainWorld('electronAPI', { ... })` 加 `dialog: { save: (payload) => ipcRenderer.invoke('dialog:save', payload) }`；
3. 在 [src/lib/electron.d.ts](./src/lib/electron.d.ts) 的 `ElectronAPI` 接口加 `dialog: { save: (payload: ...) => Promise<...> }`；
4. 渲染进程通过 `window.electronAPI?.dialog?.save(payload)` 调用，注意非 Electron 环境兜底；
5. 重启 `pnpm dev:electron`（主进程不支持 HMR）。

详见 [electron/DEVELOPMENT.md](./electron/DEVELOPMENT.md)。

### 任务 3：新增一个 LLM 流式端点的前端订阅

1. 在 [src/lib/api.ts](./src/lib/api.ts) 加 `streamXxx(graphId, ..., sessionId)` 方法（POST `/api/.../xxx-stream`，返回 `StreamStartedResponse`）；
2. 在 [src/store/useAppStore.ts](./src/store/useAppStore.ts) 加 `xxxStreamingText` / `xxxStreamingActive` 状态 + `handleGraphAgentToken(event)` 中按 `op === 'xxx'` 分发；
3. 在 `App.tsx` 的 `useEffect` WebSocket 订阅中确认事件类型已在 switch 分支中处理（如新增 op 类型，需扩展 `GraphAgentOp`）；
4. 在新组件中订阅 `xxxStreamingText` 渲染打字机效果；
5. 触发流式的按钮调 `api.streamXxx(graphId, ..., sessionId)`（sessionId 从 `streamingSessionId` 读取）。

详见 [src/DEVELOPMENT.md](./src/DEVELOPMENT.md) 与 [src/store/DEVELOPMENT.md](./src/store/DEVELOPMENT.md)。

### 任务 4：调整打包产物（appId / 图标 / 安装目录）

1. 编辑 [package.json](./package.json) 的 `build` 字段：
   - `appId`：唯一应用标识（反向域名）；
   - `productName`：显示名（也用作开始菜单 / 桌面快捷方式名称）；
   - `directories.output`：打包产物输出目录（默认 `release/`）；
   - `win.target`：`['nsis']`（Windows NSIS 安装器）；
   - `nsis`：`oneClick` / `allowToChangeInstallationDirectory` / `shortcutName` 等；
   - `extraResources`：把后端代码 / 资源文件打到 `resources/` 下。
2. 应用图标放 `build/icon.ico`（256×256，多分辨率）；
3. `pnpm dist` 验证产物。

## 扩展点

### 新增 Vite 插件

在 [vite.config.ts](./vite.config.ts) 的 `plugins: [...]` 数组中加，例如 `svgr()` 支持 SVG 作为 React 组件导入。

### 调整代理目标

改 [vite.config.ts](./vite.config.ts) 的 `server.proxy['/api'].target` 与 `server.proxy['/ws'].target`，**同步改 4 处**：`backend/app/config.py`（`backend_port` + `cors_origins`）+ `backend/.env.example` + 本文件 + [electron/launcher.ts](./electron/launcher.ts)（`DEFAULT_BACKEND_PORT`）。

### 新增环境变量

- 渲染进程：通过 `import.meta.env.VITE_XXX` 读取（需以 `VITE_` 前缀开头，否则不会暴露到客户端）；
- 主进程：通过 `process.env.XXX` 读取（可在 `pnpm dev:electron` 命令前用 `cross-env XXX=yyy` 注入）。

### 启用 Electron 自动更新

`electron-updater` 包：在 [electron/main.ts](./electron/main.ts) 加 `autoUpdater` 集成，配置 `publish` provider（GitHub Releases / 通用静态服务器）。当前未启用，发布流程是手动分发 NSIS 安装包。

## 注意事项（坑）

### 端口隔离

- 前端固定 **5174**，后端固定 **8788**；
- 改端口需同步改 4 处（见上方"调整代理目标"），否则 dev / 生产 / 代理 / IPC 任一环失配都会让前端连不上后端。

### contextIsolation 与 nodeIntegration

- `contextIsolation: true` + `nodeIntegration: false`：渲染进程不能直接 `require`，必须经 preload 桥；
- 当前 `electronAPI` 只暴露 `backend.getUrl()` / `backend.getWsUrl()` 两个同步方法；
- 同步 IPC 用 `ipcMain.on` + `event.returnValue = ...`（preload 用 `ipcRenderer.sendSync`）；
- 异步 IPC 用 `ipcMain.handle` + `ipcRenderer.invoke`（推荐，不阻塞渲染进程）。

### 主进程 TS 编译产物路径

- `electron/tsconfig.json` 的 `outDir: './dist'`，编译产物在 `electron/dist/main.js` / `preload.js` / `launcher.js`；
- `package.json` 的 `main` 字段指向 `electron/dist/main.js`（不是 `electron/main.ts`），故改主进程代码后必须 `pnpm build:electron` 或重启 `pnpm dev:electron`；
- `electron/package.json` 声明 `"type": "commonjs"`，覆盖根 `package.json` 的 `"type": "module"`，确保主进程编译产物为 CommonJS（Electron 主进程要求）。

### 生产环境 file:// 加载

- `vite.config.ts` 的 `base: './'` 让打包产物用相对路径，便于 Electron `file://` 加载；
- 渲染进程在 `file://` 环境下不能直接用相对路径发请求，必须经 `window.electronAPI.backend.getUrl()` 拿到后端基地址再拼接；
- `src/lib/api.ts` 与 `src/lib/ws.ts` 都已处理此分支，新加请求方法时复用 `httpBase()` / `wsBase()`。

### 流式 LLM 的 Vite 代理超时

- `vite.config.ts` 的 `server.proxy['/api'].timeout = 300000`（5min）+ `proxyTimeout: 300000`；
- 流式 LLM 任务可能长时间不返回（如长文本生成），默认 30s 超时会被 Vite 中断；
- 如果遇到流式请求被代理截断，检查此配置是否被覆盖。

### Zustand 状态切片订阅

- 用 `useAppStore((s) => s.xxx)` 订阅具体字段，**不要** `const store = useAppStore()` 全订阅，否则任意状态变化都会触发组件重渲染；
- 用 `useAppStore.getState().xxx()` 在事件回调 / setTimeout 闭包中读取最新值，避免闭包陈旧引用；
- action 内部修改状态用 `set({ xxx: yyy })`，不要直接 mutate。

### electron-builder 资源路径

- `package.json` 的 `build.extraResources` 把 `../backend` 打到 `resources/backend/`；
- 生产环境 `launcher.ts:resolveBackend()` 通过 `process.resourcesPath` 拼接 `backend` 子目录定位后端代码；
- 若调整后端目录位置，需同步改 `extraResources.from` 与 `resolveBackend()` 中的路径拼接逻辑。

## 下一步该读什么

| 你的角色 / 目标 | 下一步文档 |
|----------------|-----------|
| 要改 Electron 主进程 / IPC / 打包 | [electron/DEVELOPMENT.md](./electron/DEVELOPMENT.md) |
| 要改 React 组件 / 状态 / API 调用 | [src/DEVELOPMENT.md](./src/DEVELOPMENT.md) |
| 要改图谱可视化 / 节点详情卡 / 卡片视图 | [src/components/DEVELOPMENT.md](./src/components/DEVELOPMENT.md) |
| 要改图谱子组件（GraphView / NodeDetailCard / QuizPanel 等） | [src/components/graph/DEVELOPMENT.md](./src/components/graph/DEVELOPMENT.md) |
| 要改 HTTP / WS 客户端 / 类型契约 | [src/lib/DEVELOPMENT.md](./src/lib/DEVELOPMENT.md) |
| 要改全局状态 / action / 流式文本切片 | [src/store/DEVELOPMENT.md](./src/store/DEVELOPMENT.md) |
| 要改样式 / 动画 / CSS 变量 | [src/styles/DEVELOPMENT.md](./src/styles/DEVELOPMENT.md) |
| 要看后端 API / 图谱服务 | [../backend/DEVELOPMENT.md](../backend/DEVELOPMENT.md) |
| 要看高层项目约束 | [../DEVELOPMENT.md](../DEVELOPMENT.md) |
