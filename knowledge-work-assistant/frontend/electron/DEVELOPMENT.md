# electron/ 主进程开发指南

> 一句话定位：本目录是 KWA 前端的 Electron 主进程层，三个 TS 文件分别承担"窗口与生命周期"（`main.ts`）、"渲染进程桥"（`preload.ts`）、"后端子进程启动器"（`launcher.ts`）。编译产物为 CommonJS（`electron/dist/*.js`），由根 `package.json` 的 `main` 字段加载。本目录不写业务逻辑，只做"装配与桥接"。

## 模块职责

```
electron/
├── main.ts                # Electron 主进程入口：窗口创建 + IPC 注册 + 生命周期
├── preload.ts             # contextBridge 桥：向渲染进程暴露 electronAPI
├── launcher.ts            # 生产环境后端子进程启动器（spawn uvicorn + 健康检查）
├── tsconfig.json          # 主进程 TS 配置：CommonJS 输出，target ES2022
└── package.json           # { "type": "commonjs" }（覆盖根 package.json 的 module）
```

## 关键文件

| 文件 | 职责 | 关键内容 |
|------|------|---------|
| [main.ts](./main.ts) | 主进程入口 | `createWindow()`：1280×820 窗口，minSize 960×640，`contextIsolation: true` + `nodeIntegration: false` + `sandbox: false`，preload 指向 `electron/dist/preload.js`；`registerIpcHandlers()`：`ipcMain.on('backend:get-url')` / `ipcMain.on('backend:get-ws-url')` 同步 IPC；`app.whenReady()`：注册 IPC → 启动后端（异步）→ 创建窗口；`before-quit` 调 `stopBackend()` 终止后端子进程 |
| [preload.ts](./preload.ts) | 渲染进程桥 | `contextBridge.exposeInMainWorld('electronAPI', { backend: { getUrl, getWsUrl } })`；两个方法均用 `ipcRenderer.sendSync` 同步获取主进程返回值；渲染进程通过 `window.electronAPI?.backend?.getUrl()` 访问 |
| [launcher.ts](./launcher.ts) | 后端启动器 | `DEFAULT_BACKEND_PORT = 8788`；`isDev()`：`!app.isPackaged`；`getBackendBaseUrl()`：dev 优先 `BACKEND_URL` 环境变量，生产固定 `http://127.0.0.1:8788`；`getBackendWsUrl()`：HTTP → WS 协议替换；`resolveBackend()`：定位 `resources/backend/` 目录 + `python -m uvicorn` 命令；`resolveBackendDataDir()`：`app.getPath('userData')/backend-data/`；`startBackend()`：spawn 后端 + 设置 `DATA_DIR` / `DATABASE_URL` / `APP_ENV` / `BACKEND_PORT` 环境变量 + stdout/stderr 转发到主进程控制台；`waitForBackend()`：轮询 `GET /api/health` 30s 超时；`stopBackend()`：Windows 用 `taskkill /T /F` 终止进程树 |
| [tsconfig.json](./tsconfig.json) | TS 配置 | `target: ES2022` / `module: CommonJS` / `moduleResolution: node` / `strict: true` / `esModuleInterop: true` / `sourceMap: true` / `types: ["node"]` / `outDir: ./dist`；`include: ["main.ts", "preload.ts", "launcher.ts"]` |
| [package.json](./package.json) | 模块声明 | 仅 `{ "type": "commonjs" }`，覆盖根 `package.json` 的 `"type": "module"`，确保编译产物为 CommonJS（Electron 主进程要求） |

## 开发工作流

### 改主进程代码后

```bash
# 方式 A：日常开发（自动重启）
pnpm dev:electron                # Ctrl+C 后重新运行，会重新 build:electron + electron .
                                 # 主进程不支持 HMR，必须重启

# 方式 B：仅编译主进程 TS（不启动 Electron）
pnpm build:electron              # tsc -p electron/tsconfig.json
                                 # 产物输出到 electron/dist/{main,preload,launcher}.js
```

### 调试主进程日志

- `pnpm dev:electron` 启动时的终端输出（`[main]` / `[launcher]` / `[backend]` 前缀）；
- 后端子进程的 stdout / stderr 由 `launcher.ts` 转发到主进程控制台（`[backend]` 前缀）；
- Electron 渲染进程的 DevTools 日志在窗口右键 → 检查（或 `Ctrl+Shift+I`）；
- 生产模式调试：`pnpm dist` 打包后安装运行，主进程日志在 `%APPDATA%/对话回声/logs/main.log`（如启用 electron-log；当前未启用，日志只输出到 stdout）。

### 验证 IPC

1. 渲染进程 DevTools Console 输入：
   ```js
   window.electronAPI.backend.getUrl()    // 应返回 'http://127.0.0.1:8788'
   window.electronAPI.backend.getWsUrl()  // 应返回 'ws://127.0.0.1:8788'
   ```
2. 如果返回 undefined：检查 `preload.js` 是否正确编译到 `electron/dist/preload.js`，以及 `BrowserWindow.webPreferences.preload` 路径是否正确。
3. 如果报 `require is not defined`：检查 `contextIsolation: true` + `nodeIntegration: false`，渲染进程不能直接 `require`。

## 代码约定

### 命名

- 模块文件小写：`main.ts` / `preload.ts` / `launcher.ts`；
- 函数 camelCase：`createWindow` / `registerIpcHandlers` / `startBackendAndWait`；
- 常量全大写下划线：`WINDOW_WIDTH` / `DEFAULT_BACKEND_PORT` / `HEALTH_CHECK_TIMEOUT_MS`；
- IPC 通道命名：`<domain>:<action>` 格式（如 `backend:get-url` / `dialog:save`）。

### 安全

- **始终** `contextIsolation: true` + `nodeIntegration: false`，渲染进程不直接 `require`；
- preload 桥只暴露必要的最小 API，不暴露 `ipcRenderer` 本身；
- `sandbox: false` 是为了 preload 能用 Node API（如 `path`）；如果不需要，可改 `true` 进一步隔离；
- 外部链接（`window.open` / `<a target="_blank">`）由 `shell.openExternal` 转交系统浏览器，避免在 Electron 内新开窗口。

### 模块化

- 主进程代码用 ESM 语法写（`import`），但 `tsconfig.json` 配置为 `module: CommonJS`，编译为 CommonJS；
- `electron/package.json` 声明 `"type": "commonjs"`，覆盖根 `package.json` 的 `"type": "module"`；
- 不要在主进程代码中 `import` 渲染进程代码（`src/**`），二者严格隔离。

## 常见任务

### 任务 1：新增一个 IPC 通道（如打开文件保存对话框）

1. 在 [main.ts](./main.ts) 的 `registerIpcHandlers` 加：
   ```typescript
   // 异步 IPC（推荐，不阻塞渲染进程）
   ipcMain.handle('dialog:save', async (_event, defaultName: string) => {
     const result = await dialog.showSaveDialog(mainWindow!, {
       defaultPath: defaultName,
       filters: [{ name: 'Markdown', extensions: ['md'] }],
     })
     return result.canceled ? null : result.filePath
   })
   ```
2. 在 [preload.ts](./preload.ts) 的 `contextBridge.exposeInMainWorld('electronAPI', { ... })` 加：
   ```typescript
   dialog: {
     save: (defaultName: string) => ipcRenderer.invoke('dialog:save', defaultName),
   },
   ```
3. 在 [../src/lib/electron.d.ts](../src/lib/electron.d.ts) 的 `ElectronAPI` 接口加：
   ```typescript
   dialog: {
     save: (defaultName: string) => Promise<string | null>
   }
   ```
4. 渲染进程调用：
   ```typescript
   const filePath = await window.electronAPI?.dialog?.save('report.md')
   if (filePath) { /* 写文件 */ }
   ```
5. 重启 `pnpm dev:electron`。

### 任务 2：调整窗口属性（标题栏 / 最小尺寸 / 背景色）

1. 在 [main.ts](./main.ts) 的 `createWindow()` 中调整 `new BrowserWindow({ ... })` 选项：
   - `width` / `height`：初始尺寸（默认 1280×820）；
   - `minWidth` / `minHeight`：最小尺寸（默认 960×640）；
   - `title`：窗口标题（默认"对话回声"）；
   - `backgroundColor`：窗口背景色（默认 `#f5f5f7`）；
   - `frame: false` + `titleBarStyle: 'hidden'`：自定义标题栏（macOS 用 `trafficLightPosition`）；
   - `webPreferences.devTools`: `isDev` 时自动打开 DevTools。
2. 重启 `pnpm dev:electron`。

### 任务 3：调整后端启动参数（端口 / 工作目录 / 环境变量）

1. 在 [launcher.ts](./launcher.ts) 改：
   - `DEFAULT_BACKEND_PORT`：后端监听端口（**同步改 4 处**：本文件 + `backend/app/config.py` + `backend/.env.example` + `../vite.config.ts`）；
   - `resolveBackend()`：调整后端代码定位逻辑（如改用 PyInstaller 单文件，可在此扩展可执行文件探测）；
   - `resolveBackendDataDir()`：调整数据目录位置（默认 `userData/backend-data/`）；
   - `startBackend()` 的 `env` 对象：新增 / 修改传给后端子进程的环境变量；
   - `HEALTH_CHECK_TIMEOUT_MS`：健康检查超时（默认 30s）；
   - `HEALTH_CHECK_INTERVAL_MS`：轮询间隔（默认 500ms）。
2. 重启 `pnpm dev:electron`（生产环境）或重启后端（dev 环境）。

### 任务 4：启用 Electron 自动更新

1. 安装：`pnpm add electron-updater`；
2. 在 [main.ts](./main.ts) 加：
   ```typescript
   import { autoUpdater } from 'electron-updater'
   app.whenReady().then(() => {
     autoUpdater.checkForUpdatesAndNotify()
   })
   autoUpdater.on('update-downloaded', () => {
     // 提示用户重启安装
   })
   ```
3. 在 [../package.json](../package.json) 的 `build.publish` 配置 provider：
   ```json
   "publish": { "provider": "github", "owner": "...", "repo": "..." }
   ```
4. `pnpm dist` 时 electron-builder 会自动发布到 GitHub Releases（需 token）。

## 扩展点

### 新增主进程模块

如需拆分 `main.ts`（如菜单 / 托盘 / 快捷键 / 自动更新各自模块）：

1. 在 `electron/` 新建 `menu.ts` / `tray.ts` / `shortcuts.ts`；
2. 在 [tsconfig.json](./tsconfig.json) 的 `include` 数组加新文件名；
3. 在 `main.ts` 中 `import { setupMenu } from './menu'` 调用；
4. `pnpm build:electron` 会一起编译到 `electron/dist/`。

### 集成原生模块（如 sqlite3 / better-sqlite3）

如需在主进程用原生 Node 模块（如本地 SQLite 加密）：

1. `pnpm add better-sqlite3` + `pnpm add -D @types/better-sqlite3`；
2. `electron-builder` 会自动 rebuild 原生模块（`nodeGypRebuild: true`）；
3. 在主进程代码 `import Database from 'better-sqlite3'`；
4. **不要**在渲染进程用原生模块（contextIsolation 会阻止）。

### 多窗口管理

如需多窗口（如独立的设置窗口 / 关于窗口）：

1. 在 `main.ts` 维护 `Map<string, BrowserWindow>` 管理多窗口；
2. 新建 `createSettingsWindow()` / `createAboutWindow()` 等工厂函数；
3. 不同窗口可加载不同 URL（`loadURL('/settings')` / `loadFile('about.html')`）；
4. 通过 IPC 在窗口间通信（`webContents.send` + `ipcMain.on`）。

## 注意事项（坑）

### 主进程不支持 HMR

- 改 `main.ts` / `preload.ts` / `launcher.ts` 后必须重启 `pnpm dev:electron`；
- 渲染进程代码（`src/**`）支持 HMR，无须重启；
- 如果用了 `nodemon` / `tsc --watch` 自动重启主进程，确保 `electron .` 命令前重新编译 TS。

### contextIsolation 与 require

- `contextIsolation: true` 时渲染进程**不能** `require('electron')`，必须经 preload 桥；
- preload 脚本中可以 `require`，但暴露给渲染进程的对象需经过 `contextBridge` 序列化（不能直接传函数引用 / class 实例）；
- 如果遇到 "Cannot read property 'xxx' of undefined"：检查 `window.electronAPI` 是否被 preload 正确注入（DevTools Console 输入 `window.electronAPI` 验证）。

### 后端子进程的进程树终止

- Windows 下 `spawn('python', [...])` 可能 fork uvicorn worker 子进程，仅 `kill` 主进程会导致子进程残留；
- `stopBackend()` 用 `taskkill /PID <pid> /T /F`：`/T` 终止整棵进程树，`/F` 强制；
- 如果用户从任务管理器手动 kill Electron 进程，`before-quit` 事件可能不触发，后端子进程会残留——可考虑在 launcher 中写 PID 文件，下次启动时清理。

### 后端代码定位的兜底

- `resolveBackend()` 当前只支持 `python -m uvicorn` 方式，要求目标机器已装 Python 3.12 + 依赖；
- 如果 `process.resourcesPath/backend/` 不存在（如开发环境），`cwd` 回退到 `process.cwd()`；
- 后续若引入 PyInstaller 打包后端为单文件，可在此扩展可执行文件探测：
  ```typescript
  const exePath = path.join(process.resourcesPath, 'backend', 'kwa-backend.exe')
  if (fs.existsSync(exePath)) {
    return { command: exePath, args: [], cwd: path.dirname(exePath) }
  }
  ```

### 后端数据目录的可写性

- 生产环境数据目录 `app.getPath('userData')/backend-data/`，确保可写（不在只读的 `resources/` 下）；
- 如果用户安装到 `C:\Program Files\`，`resources/` 目录通常只读，后端不能在那里写 SQLite 数据库；
- `launcher.ts` 通过 `DATA_DIR` 环境变量告诉后端用 `userData/backend-data/`，后端 `config.py` 读取此变量覆盖默认 `./data`。

### 健康检查的网络可达性

- `waitForBackend()` 轮询 `GET /api/health`，3s 超时 + 500ms 间隔 + 30s 总超时；
- 如果后端启动慢（如首次初始化大模型），可能超时；可在 `main.ts` 的 `startBackendAndWait().then(ready => { ... })` 中处理 `ready=false` 情况，提示用户"后端启动中，部分功能可能延迟可用"；
- 后端就绪后前端会自动连上（健康徽章变绿），无须用户手动刷新。

### Electron 版本升级

- 当前 Electron 31.x（`package.json` 的 `devDependencies.electron`）；
- 升级时注意 `nodeIntegration` / `contextIsolation` / `sandbox` 等安全策略的默认值变化（Electron 22+ 默认 `contextIsolation: true`）；
- 升级后 `pnpm install` 重新装原生模块（electron-builder 会自动 rebuild）；
- 测试 `pnpm dev:electron` 与 `pnpm dist` 都正常后再合并。

## 下一步该读什么

| 你的角色 / 目标 | 下一步文档 |
|----------------|-----------|
| 要改渲染进程 React 组件 | [../src/DEVELOPMENT.md](../src/DEVELOPMENT.md) |
| 要改 IPC 桥的全局类型声明 | [../src/lib/DEVELOPMENT.md](../src/lib/DEVELOPMENT.md)（含 `electron.d.ts`） |
| 要改前端打包配置 / Vite 代理 | [../DEVELOPMENT.md](../DEVELOPMENT.md) |
| 要看后端 API / 启动流程 | [../../backend/DEVELOPMENT.md](../../backend/DEVELOPMENT.md) |
| 要看高层项目约束 | [../../DEVELOPMENT.md](../../DEVELOPMENT.md) |
