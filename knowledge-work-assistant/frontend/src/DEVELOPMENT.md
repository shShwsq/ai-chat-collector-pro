# src/ 渲染进程开发指南

> 一句话定位：本目录是 KWA 前端的 React 渲染进程层，由 Vite HMR 驱动。`App.tsx` 装配整体布局（header + SideNav + 主内容区 + Toast + WebSocket 订阅），四个子目录各司其职：`components/`（React 组件）、`lib/`（API / WS / 类型 / 工具）、`store/`（Zustand 全局状态）、`styles/`（CSS）。本文件描述渲染进程整体骨架与子目录导航，子目录细节请见各自 DEVELOPMENT.md。

## 模块职责

```
src/
├── App.tsx                  # 根组件：布局 + 健康轮询 + WebSocket 订阅 + 浮层面板装配
├── main.tsx                 # React 入口：挂载 <App /> 到 #root，导入全局样式
│
├── components/              # React 组件（详见 components/DEVELOPMENT.md）
│   ├── graph/               #   图谱相关子组件（GraphView / NodeDetailCard / QuizPanel 等）
│   ├── ChatHome.tsx         #   对话主页（Work 模式对话入口 + 历史瀑布流）
│   ├── ChatPanel.tsx        #   对话面板（Work 模式内嵌对话，Study 模式提示）
│   ├── ContentToolbar.tsx   #   内容区顶栏：视图切换 / 重新布局 / 撤销延伸 / 开始测验
│   ├── GraphList.tsx        #   左侧图谱列表：新建 / 重命名 / 删除 / 选中
│   ├── Icon.tsx             #   内联 SVG 图标组件
│   ├── ModeSwitch.tsx       #   Study / Work 模式切换开关
│   ├── PluginIntegrationSection.tsx  # 设置页「插件对接」分区
│   ├── RecommendationCard.tsx        # 推荐项卡片（study 复习 / work 提醒）
│   ├── ReminderBanner.tsx   #   顶部提醒横幅（到期 / 临近提醒）
│   ├── SettingsPanel.tsx    #   设置面板：LLM 配置 + 请求队列 + 插件对接
│   ├── SideNav.tsx          #   最左 56px 竖排导航：对话 / 图谱 / 设置
│   └── Toast.tsx            #   全局 Toast（成功 / 警告 / 错误）
│
├── lib/                     # 通信层与类型契约（详见 lib/DEVELOPMENT.md）
│   ├── api.ts               #   HTTP 客户端：/api 前缀 + file:// 环境地址解析 + ApiError
│   ├── ws.ts                #   WebSocket 客户端：TestSocket 类 + generateSessionId
│   ├── types.ts             #   与 backend/app/models/schemas.py 一一对应的类型
│   ├── nodeTemplates.ts     #   节点模板镜像（与 backend node_types.py 对齐）
│   └── electron.d.ts        #   window.electronAPI 全局类型声明
│
├── store/                   # 全局状态（详见 store/DEVELOPMENT.md）
│   └── useAppStore.ts       #   Zustand 单一 store：mode / view / 图谱 / 候选 / 测验 / 流式 / Toast
│
└── styles/                  # 样式（详见 styles/DEVELOPMENT.md）
    ├── app.css              #   主样式：布局 + 组件 + BEM 类名 + 模式 CSS 变量
    └── animations.css       #   动画：闪烁 / 淡入 / 加载等关键帧
```

## 关键文件

| 文件 | 职责 | 关键内容 |
|------|------|---------|
| [App.tsx](./App.tsx) | 根组件 | 布局：`app-shell`（`data-mode`）+ `app-header`（标题 + 健康徽章 + ModeSwitch）+ `app-body`（SideNav + 主内容区）+ `Toast` + `app-footer`；`useEffect` 启动时调 `loadGraphs()` + 健康检查轮询（5s）；`useEffect` 启动 WebSocket：生成 `sessionId` → `new TestSocket()` → `connect(sessionId)` → `onEvent` 订阅 `plugin.conversation_received` / `graph_agent_token` / `done` / `cancelled` / `error` 事件并分发到 store；按 `activeNav` 切换主内容区：`'chat'` → ChatPanel / `'settings'` → SettingsPanel / `'graph'` → GraphList + content-area（ContentToolbar + GraphView/CardView + PendingNodes/QuizPanel/WorkInput/TrendsSidebar/ReportPanel/QAPanel 浮层） |
| [main.tsx](./main.tsx) | React 入口 | `ReactDOM.createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>)`；导入 `./styles/animations.css` + `./styles/app.css` |
| [components/SideNav.tsx](./components/SideNav.tsx) | 竖排导航 | 56px 宽，三个图标按钮（对话 / 图谱 / 设置），订阅 `store.activeNav`，点击调 `setActiveNav` |
| [components/ModeSwitch.tsx](./components/ModeSwitch.tsx) | 模式切换 | 顶部右上角开关，订阅 `store.mode`，点击调 `setMode`（自动重载新模式图谱列表 + 清空当前选中） |
| [components/GraphList.tsx](./components/GraphList.tsx) | 图谱列表 | 左侧栏：图谱列表 + 新建按钮 + 重命名 / 删除（ConfirmDialog 二次确认）；订阅 `store.graphs` / `currentGraphId` |
| [components/ContentToolbar.tsx](./components/ContentToolbar.tsx) | 内容区顶栏 | 视图切换（graph / card）+ 重新布局（调 `graphViewRef.relayout()`）+ 撤销延伸（仅 mode=all 时可见）+ 开始测验（study 模式）+ Work 模式入口（抽取 / 风口 / 报告 / 提问） |
| [components/SettingsPanel.tsx](./components/SettingsPanel.tsx) | 设置面板 | LLM API 配置（base_url / api_key / model / context_window）+ 请求队列（活跃 / 取消）+ 插件对接分区（懒加载） |
| [components/ChatPanel.tsx](./components/ChatPanel.tsx) | 对话面板 | Work 模式：内嵌对话（输入框 + 历史消息流）；Study 模式：提示"对话功能在 Work 模式下可用" |
| [components/Toast.tsx](./components/Toast.tsx) | 全局提示 | 订阅 `store.toast`，自动消失（3s）；类型：info / success / warning / error |
| [lib/api.ts](./lib/api.ts) | HTTP 客户端 | `httpBase()`：dev 用相对路径走 Vite 代理，file:// 经 `window.electronAPI.backend.getUrl()` 拿后端地址；`request<T>()`：统一加 `/api` 前缀 + JSON 处理 + `ApiError` 抛出；`api` 对象：50+ 方法，与后端 routers 一一对应（健康 / 图谱 / 节点 / 边 / 插件 / 抽取 / 测验 / Work / 推荐 / LLM 配置 / 流式触发） |
| [lib/ws.ts](./lib/ws.ts) | WebSocket 客户端 | `wsBase()`：dev 用 `ws://${loc.host}`，file:// 经 `window.electronAPI.backend.getWsUrl()`；`TestSocket` 类：`connect(sessionId?)` / `send(msg)` / `onEvent(cb)` / `close()`；`generateSessionId()`：优先 `crypto.randomUUID()`，回退时间戳 + 随机数 |
| [lib/types.ts](./lib/types.ts) | 类型契约 | 与 `backend/app/models/schemas.py` 一一对应；含 `HealthResponse` / `Graph` / `Node` / `Edge` / `Observation` / `Quiz` / `Trend` / `RecommendationItem` / `LlmConfig` / `WsEvent`（welcome / pong / echo / plugin.conversation_received / graph_agent_*）等 |
| [lib/nodeTemplates.ts](./lib/nodeTemplates.ts) | 节点模板镜像 | 与 `backend/app/models/node_types.py` 一一对应；`STUDY_SUBJECTS` / `WORK_OBJECTS` 枚举 + `STUDY_TEMPLATES` / `WORK_TEMPLATES` 模板字段 + `USER_FILL_TYPES` 留白类型；`getTemplate(graphType, nodeType)` / `getTypeOptions(graphType)` / `stripMetaKeys(dp)` 等 |
| [lib/electron.d.ts](./lib/electron.d.ts) | 全局类型声明 | `interface ElectronAPI { backend: { getUrl, getWsUrl } }`；`interface Window { electronAPI?: ElectronAPI }`；与 `electron/preload.ts` 暴露的 API 一一对应 |
| [store/useAppStore.ts](./store/useAppStore.ts) | 全局状态 | Zustand 单一 store，含 30+ 状态字段 + 40+ action；状态分组：mode/view/图谱/选中/加载错误、Task 8 延伸、Task 11 抽取、Task 12 测验、Task 13-16 Work、推荐、LLM 配置、流式输出、Toast；所有 action 捕获异常后写 `error` 状态，不抛出 |

## 开发工作流

### 改渲染进程代码后

- Vite HMR 自动热替换，无须手动刷新；
- 改 `App.tsx` 的 `useEffect` 依赖项需谨慎，可能导致 WebSocket 重连 / 健康检查重启；
- 改 `lib/types.ts` 后需同步改 `backend/app/models/schemas.py`（两者一一对应）；
- 改 `lib/nodeTemplates.ts` 后需同步改 `backend/app/models/node_types.py`；
- 改 `store/useAppStore.ts` 的 action 后，触发对应 UI 操作看 Console 日志与 Toast 提示。

### 类型检查与 Lint

```bash
pnpm typecheck                 # tsc --noEmit
pnpm lint                      # eslint . --ext .ts,.tsx
```

`tsconfig.json` 启用 `strict: true` + `noUnusedLocals` + `noUnusedParameters` + `noFallthroughCasesInSwitch`，未使用变量 / 入参 / switch 穿透都会报错。

### React DevTools 调试

- 安装 React DevTools 浏览器扩展（Chrome / Firefox）；
- Electron dev 模式下自动打开 DevTools（`mainWindow.webContents.openDevTools({ mode: 'detach' })`）；
- Components 面板：查看组件树 + props + hooks 状态；
- Profiler 面板：录制交互，分析重渲染热点（Zustand 切片订阅不当会导致不必要重渲染）。

## 代码约定

### 组件声明

- 用 `function XxxYyy(props: XxxYyyProps) { ... }` 声明，**不用箭头函数**（便于 stack trace 与 React DevTools 识别）；
- 导出用 `export function XxxYyy()` 或 `export default function XxxYyy()`；
- props 类型用 `interface XxxYyyProps { ... }`，必填字段在前，可选字段在后（`?` 标注）；
- 组件内 hooks 顺序：`useAppStore` → `useState` → `useRef` → `useMemo` → `useCallback` → `useEffect`。

### 状态订阅

- 用 `useAppStore((s) => s.xxx)` 订阅具体字段，**不要** `const store = useAppStore()` 全订阅；
- 多字段订阅可用 `useShallow`（zustand 提供的浅比较）避免不必要重渲染；
- 在事件回调 / setTimeout 闭包中读最新值用 `useAppStore.getState().xxx()`，避免闭包陈旧引用。

### 事件处理

- React 事件用 `onXxx={handler}`，handler 用 `useCallback` 包裹（依赖项需完整）；
- 副作用用 `useEffect`，依赖项需完整，清理函数在 return 中；
- 异步 action 调用：`void store.xxx()` 或 `await store.xxx()`，错误由 store 内部捕获。

### 通信

- HTTP 经 `api.xxx()`，**不直接 fetch**；
- WebSocket 经 `TestSocket` 单例（`App.tsx` 的 `useRef` 持有），事件在 `App.tsx` 的 `onEvent` 中分发到 store；
- 渲染进程不直接 `require('electron')`，经 `window.electronAPI?.xxx` 访问主进程能力（注意非 Electron 环境兜底）。

### 样式

- CSS 类名用 BEM：`block__element--modifier`（如 `app-header__title` / `health-badge--ok`）；
- 模式切换通过 `data-mode="study|work"` 属性 + CSS 变量（`--kwa-accent` 等）实现，不内联样式；
- 浮层面板用 `position: absolute` + 半透明遮罩，组件内 `if (!panelOpen) return null` 控制显隐。

## 常见任务

### 任务 1：新增一个 React 组件

详见 [components/DEVELOPMENT.md](./components/DEVELOPMENT.md) 的"任务 1"。

### 任务 2：新增一个 store action

详见 [store/DEVELOPMENT.md](./store/DEVELOPMENT.md) 的"任务 1"。

### 任务 3：新增一个 API 调用

详见 [lib/DEVELOPMENT.md](./lib/DEVELOPMENT.md) 的"任务 1"。

### 任务 4：订阅一个新的 WebSocket 事件

1. 在 [lib/types.ts](./lib/types.ts) 加事件类型（扩展 `WsEvent` 联合类型）；
2. 在 [App.tsx](./App.tsx) 的 `onEvent` switch 中加新 case，分发到 store action；
3. 在 [store/useAppStore.ts](./store/useAppStore.ts) 加对应的 `handleXxxEvent` action；
4. 在组件中订阅 store 的对应状态字段渲染。

### 任务 5：调整布局结构

1. 在 [App.tsx](./App.tsx) 修改 JSX 结构（`app-shell` / `app-header` / `app-body` / `content-area`）；
2. 在 [styles/app.css](./styles/app.css) 调整对应 CSS（grid / flex 布局）；
3. 浮层面板的位置（`top` / `right` / `bottom` / `left`）在组件内的内联 style 或 CSS 类中调整；
4. 响应式布局：用 `@media (max-width: 768px)` 等媒体查询调整小屏布局。

## 扩展点

### 新增子目录

如需新增子目录（如 `src/hooks/` 自定义 Hook 库）：

1. 在 `src/` 下新建目录；
2. 在 [tsconfig.json](../tsconfig.json) 的 `include: ["src"]` 已覆盖，无须改；
3. 加 `src/hooks/DEVELOPMENT.md` 描述子目录职责；
4. 在本文件的"模块职责"小节加新目录说明。

### 引入新依赖

1. `pnpm add xxx`（生产依赖）或 `pnpm add -D xxx`（开发依赖）；
2. 在组件 / lib 中 `import xxx from 'xxx'`；
3. 注意 bundle size：用 `pnpm build` 后查看 `dist/assets/` 体积，过大的库考虑动态 import 代码分割。

### 启用路由

当前是单页面 + `activeNav` 切换视图，无路由。如需多路由（如 `/graph/:id` / `/settings`）：

1. `pnpm add react-router-dom`；
2. 在 [main.tsx](./main.tsx) 包 `<BrowserRouter>`（Electron file:// 需用 `<HashRouter>`）；
3. 在 [App.tsx](./App.tsx) 用 `<Routes>` / `<Route>` 替换 `activeNav` 切换逻辑。

## 注意事项（坑）

### Zustand 全订阅的性能陷阱

- ❌ `const store = useAppStore()`：任意状态变化都触发重渲染；
- ✅ `const mode = useAppStore((s) => s.mode)`：仅 `mode` 变化时重渲染；
- ✅ `const { mode, view } = useAppStore(useShallow((s) => ({ mode: s.mode, view: s.view })))`：浅比较多字段。

### WebSocket 连接失败时降级

- `App.tsx` 启动时连 `/ws?session_id=...`，连接失败时静默降级（不弹错误）；
- 流式 LLM 动作（detail-stream / ask-stream / report-stream）在 `sessionId` 为 null 时**自动回退到非流式接口**（store 内已判断），用户仍能拿到结果但没有打字机效果；
- 如果 WebSocket 频繁断开，检查后端 `/ws` 端点是否正常（后端日志看 `ws_notify` 模块）。

### 流式文本的状态管理

- `qaStreamingText` / `reportStreamingText` / `nodeDetailStreamingText` 是逐 token 累积的字符串；
- 每次 `graph_agent_token` 事件触发 `setXxxStreamingText(prev => prev + delta)`；
- 流式完成（`graph_agent_done`）后清空 `xxxStreamingActive` 但保留 `xxxStreamingText` 供展示；
- 切换节点 / 关闭面板时需手动清空对应流式文本，避免跨节点残留。

### 类型契约的同步

- `lib/types.ts` 与 `backend/app/models/schemas.py` 一一对应，改其一需同步改另一；
- `lib/nodeTemplates.ts` 与 `backend/app/models/node_types.py` 一一对应；
- 后端 schema 加新字段时，前端 types 需同步加（否则 `api.xxx()` 的响应类型校验失败）；
- 字段命名：后端 snake_case，前端 types 也用 snake_case（与 API 响应一致），UI 展示时按需转 camelCase。

### file:// 环境的地址解析

- 生产环境 Electron 用 `file://` 加载打包产物，渲染进程不能用相对路径发请求；
- `lib/api.ts` 的 `httpBase()` 在 `file:` 协议下经 `window.electronAPI.backend.getUrl()` 拿后端基地址；
- `lib/ws.ts` 的 `wsBase()` 同理；
- 新加请求方法时复用 `httpBase()`，不要硬编码 `http://127.0.0.1:8788`。

### StrictMode 的双重渲染

- `main.tsx` 用 `<React.StrictMode>` 包裹，dev 模式下会双重渲染（用于检测副作用）；
- `useEffect` 的 cleanup 函数会被调用两次，确保副作用可重复执行 / 可清理；
- 如果遇到"请求发两次"问题，检查 `useEffect` 依赖项是否正确，避免在 render 阶段调 action。

### 浮层面板的 z-index 层级

- `app.css` 中定义了 z-index 层级：基础组件 `1` / 浮层面板 `100` / Toast `1000` / ConfirmDialog `2000`；
- 新增浮层面板时遵循此层级，避免被其他元素遮挡；
- 半透明遮罩用 `position: fixed` + `inset: 0` + `background: rgba(0,0,0,0.4)`。

## 下一步该读什么

| 你的角色 / 目标 | 下一步文档 |
|----------------|-----------|
| 要改 React 组件 / 图谱可视化 | [components/DEVELOPMENT.md](./components/DEVELOPMENT.md) |
| 要改图谱子组件（GraphView / NodeDetailCard / QuizPanel 等） | [components/graph/DEVELOPMENT.md](./components/graph/DEVELOPMENT.md) |
| 要改 HTTP / WS 客户端 / 类型契约 | [lib/DEVELOPMENT.md](./lib/DEVELOPMENT.md) |
| 要改全局状态 / action / 流式文本切片 | [store/DEVELOPMENT.md](./store/DEVELOPMENT.md) |
| 要改样式 / 动画 / CSS 变量 | [styles/DEVELOPMENT.md](./styles/DEVELOPMENT.md) |
| 要改 Electron 主进程 / IPC | [../electron/DEVELOPMENT.md](../electron/DEVELOPMENT.md) |
| 要看后端 API / schemas | [../../../backend/app/DEVELOPMENT.md](../../../backend/app/DEVELOPMENT.md) |
| 要看高层项目约束 | [../../../DEVELOPMENT.md](../../../DEVELOPMENT.md) |
