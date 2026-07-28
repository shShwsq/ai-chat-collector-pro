# components/ 组件开发指南

> 一句话定位：本目录是 KWA 前端的 React 组件层，14 个 `.tsx` 文件按业务域拆分（布局 / 导航 / 图谱列表 / 工具栏 / 设置 / 对话 / Toast / 提醒），以及一个 `graph/` 子目录集中放图谱相关组件（GraphView / NodeDetailCard / QuizPanel 等）。本文件描述顶层组件，`graph/` 子目录细节请见 [graph/DEVELOPMENT.md](./graph/DEVELOPMENT.md)。

## 与 web-ai-chat-collector 的关系（软件 + 插件一体化）

本目录是 KWA 前端组件层，与插件侧 [web-ai-chat-collector](../../../web-ai-chat-collector/DEVELOPMENT.md) 的关系如下：

- **`PluginIntegrationSection.tsx` 展示推送状态**：设置页的"插件对接"分区，调 `api.getPluginRecent` 展示 collector 最近推送的对话列表 + 调 `api.getPluginContract` 展示接口契约 + 复制推送 URL 按钮；用户在此查看 collector 对接状态。
- **`PendingNodes.tsx` 消费推送数据**：[graph/PendingNodes.tsx](./graph/PendingNodes.tsx) 展示 `GET /api/observations?processed=false` 返回的未处理对话（含 collector 推送的 `source='plugin'` 记录），用户点击"抽取"后调 `POST /api/graphs/{id}/nodes/batch` 将候选节点入图。
- **`Toast.tsx` 响应推送事件**：collector 推送成功后，后端广播 `plugin.conversation_received` WebSocket 事件，[App.tsx](../App.tsx) 收到后调 `store.pushToast` 弹 Toast 提示用户"收到新对话"。
- **两套独立 UI**：本目录的图谱 UI（GraphView / NodeDetailCard / QuizPanel 等）与 collector 的悬浮球 UI（[content/ui/](../../../web-ai-chat-collector/content/ui/DEVELOPMENT.md)）是**两套完全独立的 UI**，互不依赖、互不通信；本目录组件不注入 collector 页面，collector 悬浮球也不出现在 KWA 窗口。
- **`SettingsPanel.tsx` 配置 LLM 凭据**：用户在此配置的 LLM `base_url` / `api_key` / `model` 写入 KWA 后端 `settings` 表（加密存储）；与 collector 的 `chrome.storage.local.llmSettings` **完全独立**，共享 LLM 凭据时需在两侧各填一次。

跨子工程任务（启用推送、UI 风格统一、并行开发联调等）请参考工作区根 [DEVELOPMENT.md](../../../DEVELOPMENT.md) 的"常见跨子工程任务"章节。

## 模块职责

```
components/
├── graph/                            # 图谱相关子组件（详见 graph/DEVELOPMENT.md）
│   ├── CardView.tsx                  #   卡片视图（节点瀑布流，按类型分组）
│   ├── ConfirmDialog.tsx             #   二次确认弹窗
│   ├── GraphView.tsx                 #   图谱视图（d3-force 力导向 + SVG 渲染）
│   ├── NodeDetailCard.tsx            #   节点悬停详情卡（五区域布局 + Task 8 延伸）
│   ├── NodeEditor.tsx                #   节点编辑表单（按模板字段渲染）
│   ├── PendingNodes.tsx              #   待抽取对话与候选节点浮层（Task 11）
│   ├── QAPanel.tsx                   #   Work 模式提问浮层（Task 16，流式输出）
│   ├── QuizPanel.tsx                 #   Study 测验浮层（Task 12，三段式）
│   ├── ReportPanel.tsx               #   Work 工作报告浮层（Task 15，流式 + 导出 docx）
│   ├── TrendsSidebar.tsx             #   Work 风口推荐侧栏（Task 14）
│   ├── WorkInput.tsx                 #   Work 模式抽取入口浮层（Task 13）
│   └── graphUtils.ts                 #   图谱纯函数工具（截断 / 换行 / 边路径 / 坐标转换）
│
├── ChatExpandedOverlay.tsx           # 对话首页大卡浮层（FLIP 动画 + createPortal + 无缝切图谱）
├── ChatHome.tsx                      # 对话首页瀑布流主体组件（交互增强版）：study/work 双模式推荐卡片瀑布流 + 居中输入框 + sending 过渡；4 项交互增强：卡片飞入（随机 delay/duration）、滚轮覆盖（瀑布流上移盖住输入框 + 输入框渐进模糊）、点击展开（setChatExpandedNodeId 触发顶层 ChatExpandedOverlay）、sending 过渡（仅 work）；props: `{ mode: 'study'|'work', onAsk?: (q: string) => void }`
├── ChatPanel.tsx                     # 多轮对话面板（Task 9 / Task 10，Study/Work 统一，activeNav='chat' 时显示）
├── ContentToolbar.tsx                # 内容区顶栏：视图切换 / 重新布局 / 撤销延伸 / 开始测验 / Work 入口
├── GraphList.tsx                     # 左侧图谱列表：新建 / 重命名 / 删除 / 选中
├── Icon.tsx                          # 内联 SVG 图标组件（统一图标尺寸与 stroke）
├── ModeSwitch.tsx                    # Study / Work 模式切换开关
├── PluginIntegrationSection.tsx      # 设置页「插件对接」分区（最近推送 + 契约展示）
├── RecommendationCard.tsx            # 推荐项卡片（forwardRef）：暴露 article DOM 供父组件做 FLIP First 测量；新增 props `enterDelay?` / `enterDuration?` / `isDimmed?`；study 模式底部显示'上次复习时间 + 错误率徽标'，work 模式显示'提醒时间 + 星标图标'；样式类扩展 rec-card--entering / rec-card--dimmed
├── ReminderBanner.tsx                # 受控组件：仅 `count: number` + `onClick: () => void` 两个 props；count <= 0 返回 null；移除了关闭按钮和跳转节点逻辑；内联 BellIcon
├── SettingsPanel.tsx                 # 设置面板：LLM 配置 + 请求队列 + 插件对接分区
├── SideNav.tsx                       # 最左 56px 竖排导航：对话 / 图谱 / 设置
├── Toast.tsx                         # 全局 Toast（成功 / 警告 / 错误）
└── ToolConfirmDialog.tsx             # 高风险工具调用确认对话框（倒计时 + 同意/拒绝）
```

## 关键文件

| 文件 | 职责 | 关键内容 |
|------|------|---------|
| [SideNav.tsx](./SideNav.tsx) | 竖排导航 | 56px 宽，三个图标按钮（对话 `chat` / 图谱 `graph` / 设置 `settings`）；订阅 `store.activeNav`，点击调 `setActiveNav`；对话图标右上角红点（`store.reminderCount > 0` 时显示） |
| [ModeSwitch.tsx](./ModeSwitch.tsx) | 模式切换 | 顶部右上角 toggle 开关；订阅 `store.mode`，点击调 `setMode`（自动重载新模式图谱列表 + 清空当前选中）；study 显示墨绿色，work 显示琥珀色 |
| [GraphList.tsx](./GraphList.tsx) | 图谱列表 | 左侧栏：图谱列表（订阅 `store.graphs`）+ 新建按钮（弹 inline 输入框）+ 重命名（inline 编辑）+ 删除（ConfirmDialog 二次确认）+ 选中（调 `selectGraph` → `loadFullGraph`） |
| [ContentToolbar.tsx](./ContentToolbar.tsx) | 内容区顶栏 | 视图切换（graph / card，订阅 `store.view`）；重新布局（调 `props.onRelayout` → `graphViewRef.relayout()`）；撤销延伸（仅 `extensionBatchId` 存在时可见，调 `revokeExtend`）；开始测验（study 模式，调 `setQuizPanelOpen(true)`）；Work 模式入口（抽取 / 风口 / 报告 / 提问，调对应 `setWorkActivePanel`） |
| [ChatExpandedOverlay.tsx](./ChatExpandedOverlay.tsx) | 大卡浮层 | FLIP 飞入动画 + `createPortal` 渲染到 `document.body` + 无缝切换到图谱视图（`setSelectedNode` + `setActiveNav('graph')` + `graphViewRef.focusNodeAtCenter`）；props: `{ graphViewRef: React.RefObject<GraphViewHandle | null> }` |
| [ChatHome.tsx](./ChatHome.tsx) | 对话首页 | 对话首页瀑布流主体组件（交互增强版）：study/work 双模式推荐卡片瀑布流 + 居中输入框 + sending 过渡；4 项交互增强：卡片飞入（随机 delay/duration）、滚轮覆盖（瀑布流上移盖住输入框 + 输入框渐进模糊）、点击展开（`setChatExpandedNodeId` 触发顶层 `ChatExpandedOverlay`）、sending 过渡（仅 work）；props: `{ mode: 'study'|'work', onAsk?: (q: string) => void }` |
| [ChatPanel.tsx](./ChatPanel.tsx) | 对话面板 | 多轮对话面板（Task 9 / Task 10）：Study/Work 双模式统一多轮对话；`chatMessages.length === 0` 时渲染 `<ChatHome mode={mode} onAsk={handleAsk} />`，否则渲染 `<ChatConversationView />`；顶层渲染 `pendingToolConfirmation && <ToolConfirmDialog />`；ChatConversationView 含消息列表 + 底部输入框 + header 工具栏（返回首页按钮 / 流式取消按钮）；Work 模式独有的 PlanBuildToggle 子组件；ChatMessageItem 区分 user/assistant 消息，assistant 流式占位态显示三点打字动画，工具调用过程渲染为 ChatToolCallItem 列表 |
| [SettingsPanel.tsx](./SettingsPanel.tsx) | 设置面板 | `activeNav='settings'` 时显示；LLM 配置（base_url / api_key / model / context_window，调 `api.updateLlmConfig`）；请求队列（活跃列表 + 取消按钮，调 `api.cancelLlmRequest`）；插件对接分区（懒加载 `PluginIntegrationSection`） |
| [PluginIntegrationSection.tsx](./PluginIntegrationSection.tsx) | 插件对接分区 | 最近推送对话列表（调 `api.getPluginRecent`）+ 接口契约展示（调 `api.getPluginContract`）+ 复制推送 URL 按钮 |
| [RecommendationCard.tsx](./RecommendationCard.tsx) | 推荐项卡片 | `forwardRef` 实现，暴露 article DOM 供父组件做 FLIP First 测量；新增 props `enterDelay?` / `enterDuration?` / `isDimmed?`；study 模式底部显示"上次复习时间 + 错误率徽标"，work 模式显示"提醒时间 + 星标图标"；样式类扩展 `rec-card--entering` / `rec-card--dimmed` |
| [ReminderBanner.tsx](./ReminderBanner.tsx) | 提醒横幅 | 受控组件：仅 `count: number` + `onClick: () => void` 两个 props；`count <= 0` 返回 `null`；移除了关闭按钮和跳转节点逻辑；内联 BellIcon |
| [Icon.tsx](./Icon.tsx) | 图标组件 | 内联 SVG 图标（chat / graph / settings / close / edit / delete / send / 等）；统一 `size` / `color` / `strokeWidth` props；不依赖图标库（避免 bundle 体积） |
| [Toast.tsx](./Toast.tsx) | 全局提示 | 订阅 `store.toast`；类型：info（蓝）/ success（绿）/ warning（黄）/ error（红）；3s 后自动消失（调 `clearToast`）；单条覆盖（后到的覆盖前条） |
| [ToolConfirmDialog.tsx](./ToolConfirmDialog.tsx) | 工具确认对话框 | 高风险工具调用确认对话框；显示工具名（`TOOL_NAME_LABEL` 中文映射）+ 参数摘要（`summarizeArgs`）+ 风险等级；同意 → `confirmToolCall`；拒绝 + 可选原因 → `rejectToolCall`；倒计时（`timeout` 字段，<=10s 标红 `is-urgent`）；props: `{ confirmation: ToolConfirmation }` |

## 开发工作流

### 新增组件

1. 在 `components/`（图谱相关放 `components/graph/`）新建 `XxxYyy.tsx`；
2. 用 `function XxxYyy(props: XxxYyyProps) { ... }` 声明，导出 `export function XxxYyy`；
3. 文件顶部加 JSDoc 注释说明组件职责与关键交互；
4. 在 `App.tsx` 或父组件中渲染 `<XxxYyy />`；
5. `pnpm typecheck` + `pnpm lint` 确认无误。

### 改组件后

- Vite HMR 自动热替换，无须手动刷新；
- 改 props 接口后，需同步改父组件传入的 props；
- 改 store 订阅切片后，确认订阅字段正确，避免不必要重渲染。

### 调试组件

- React DevTools Components 面板：查看组件树 + props + hooks 状态；
- Console 中 `console.log` / `console.dir` 查看运行时数据；
- 临时加 `border: 1px solid red` 调试布局问题；
- 用 React Profiler 录制交互，分析重渲染热点。

## 代码约定

### 组件声明

```tsx
/**
 * 组件职责简述。
 *
 * 关键交互：
 * - 交互 1
 * - 交互 2
 */

import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import type { Node } from '../lib/types'

export interface XxxYyyProps {
  /** 必填字段说明。 */
  node: Node
  /** 可选字段说明。 */
  pinned?: boolean
  /** 回调说明。 */
  onClose: () => void
}

export function XxxYyy({ node, pinned = false, onClose }: XxxYyyProps) {
  // 1. store 订阅
  const mode = useAppStore((s) => s.mode)
  const updateNode = useAppStore((s) => s.updateNode)
  // 2. useState
  const [loading, setLoading] = useState(false)
  // 3. useRef
  // 4. useMemo / useCallback
  const label = useMemo(() => /* ... */, [node])
  // 5. useEffect
  useEffect(() => {
    /* side effect */
  }, [node.id])

  return <div className="xxx-yyy">...</div>
}
```

### 命名

- 组件文件 PascalCase：`GraphView.tsx` / `NodeDetailCard.tsx`；
- 组件名与文件名一致：`function GraphView()`；
- props 接口名加 `Props` 后缀：`GraphViewProps` / `NodeDetailCardProps`；
- 事件 handler 用 `onXxx` / `handleXxx`：`onClose`（props 回调）/ `handleClose`（内部处理）。

### 样式

- CSS 类名用 BEM：`block__element--modifier`；
- 不内联 style，除非动态值（如 `style={{ left: x, top: y }}`）；
- 模式相关颜色用 CSS 变量：`color: var(--kwa-accent)`；
- 浮层用 `position: absolute` + 半透明遮罩。

### 状态订阅

- 用 `useAppStore((s) => s.xxx)` 订阅具体字段；
- 多字段用 `useShallow` 浅比较；
- 事件回调中用 `useAppStore.getState().xxx` 读最新值。

## 常见任务

### 任务 1：新增一个 React 组件

1. 在 `components/`（图谱相关放 `components/graph/`）新建 `XxxYyy.tsx`；
2. 按上方"组件声明"模板编写；
3. 在 `App.tsx` 或父组件中 `import { XxxYyy } from './components/XxxYyy'`；
4. 在 JSX 中渲染 `<XxxYyy prop1={...} prop2={...} />`；
5. 若需浮层显隐：在 `store/useAppStore.ts` 加 `xxxPanelOpen` 状态 + `setXxxPanelOpen` action；组件内 `if (!xxxPanelOpen) return null`；
6. `pnpm typecheck` + `pnpm lint` 验证。

### 任务 2：在 SettingsPanel 加新分区

1. 在 [SettingsPanel.tsx](./SettingsPanel.tsx) 的 JSX 中加新分区容器（`<section className="settings-section">`）；
2. 分区内容用懒加载：`const [xxxLoaded, setXxxLoaded] = useState(false)`，进入分区时调 `api.getXxx()` 加载；
3. 错误处理：`try { ... } catch (e) { setXxxError(...) }`，UI 显示错误提示；
4. 加 loading 占位（`<div className="loading">加载中...</div>`）。

### 任务 3：调整 SideNav 顺序 / 增减导航项

1. 在 [store/useAppStore.ts](../store/useAppStore.ts) 的 `ActiveNav` 类型加 / 减值；
2. 在 [SideNav.tsx](./SideNav.tsx) 的按钮列表中加 / 减对应项；
3. 在 [App.tsx](../App.tsx) 的 `activeNav === 'xxx'` 分支中加 / 减对应主内容区；
4. 默认值改 `store` 的 `activeNav` 初始值。

### 任务 4：在 ContentToolbar 加新按钮

1. 在 [ContentToolbar.tsx](./ContentToolbar.tsx) 的 JSX 中加按钮（`<button className="toolbar__btn" onClick={...}>`）；
2. 按钮可见性按 `mode` / `view` / `currentGraphId` 等条件控制；
3. 点击 handler 调 store action（如 `setQuizPanelOpen(true)` / `setWorkActivePanel('trends')`）；
4. 进行中状态用 `store.xxxLoading` / `store.xxxSaving` 等标记，按钮 `disabled={xxxLoading}`。

### 任务 5：调整 Toast 类型 / 持续时间

1. 在 [store/useAppStore.ts](../store/useAppStore.ts) 的 `ToastType` 类型加减值（如加 `'info'` / `'loading'`）；
2. 在 [Toast.tsx](./Toast.tsx) 的颜色 / 图标映射中加对应项；
3. 持续时间在 `pushToast` action 的 `setTimeout` 中调整（当前 3s）；
4. 多条堆叠：当前实现是单条（后到的覆盖前条），如需多条需改 `toast: ToastMessage[]` 数组。

## 扩展点

### 新增浮层面板

参考既有模式（PendingNodes / QuizPanel / WorkInput / TrendsSidebar / ReportPanel / QAPanel）：

1. 在 `components/graph/` 新建 `XxxPanel.tsx`；
2. 在 `store/useAppStore.ts` 加 `xxxPanelOpen` 状态 + `setXxxPanelOpen` action + 业务状态字段（如 `xxxLoading` / `xxxResult`）；
3. 组件内 `if (!xxxPanelOpen) return null` 控制显隐；
4. 触发按钮在 `ContentToolbar.tsx` 或 `NodeDetailCard.tsx` 中加；
5. 在 `App.tsx` 的 content-area 中渲染 `<XxxPanel />`（与既有浮层并列）。

### 拆分大组件

如果组件超过 300 行，考虑拆分：

1. 把子 JSX 抽成独立子组件（同目录新建 `XxxYyyPart.tsx`）；
2. 把纯函数抽到 `lib/` 或 `graph/graphUtils.ts`；
3. 把状态逻辑抽到自定义 Hook（`useXxx`）；
4. 父组件通过 props 传数据给子组件，避免子组件直接订阅 store（减少耦合）。

### 抽取通用组件

如多个组件有相似 UI（如卡片 / 按钮 / 输入框），考虑抽到 `components/common/` 子目录：

1. 新建 `components/common/Button.tsx` / `Card.tsx` 等；
2. 加 `components/common/DEVELOPMENT.md`；
3. 在本文件"模块职责"小节加 `common/` 子目录说明。

## 注意事项（坑）

### 浮层面板的 z-index 层级

- 基础组件 `z-index: 1`；
- 浮层面板 `z-index: 100`（PendingNodes / QuizPanel / WorkInput / TrendsSidebar / ReportPanel / QAPanel）；
- Toast `z-index: 1000`；
- ConfirmDialog `z-index: 2000`；
- 新增浮层遵循此层级，避免被遮挡。

### 浮层的半透明遮罩

- 浮层需有遮罩防止误操作背景；
- 遮罩用 `position: fixed` + `inset: 0` + `background: rgba(0,0,0,0.4)`；
- 点击遮罩关闭浮层（`onClick={onClose}`），但浮层本体 `onClick={e => e.stopPropagation()}` 阻止冒泡。

### props 与 store 的取舍

- 跨多层组件共享的状态用 store（如 `mode` / `currentGraphId` / `fullGraph`）；
- 仅父组件用的状态用 props 传（如 `pinned` / `position`）；
- 组件内部状态用 `useState`（如 `loading` / `error` / 输入框值）；
- 不要把所有状态都塞 store，会导致不必要重渲染。

### 事件回调中的最新状态

- 在 `setTimeout` / `setInterval` / 事件回调闭包中，`mode` 等闭包变量可能是陈旧值；
- 用 `useAppStore.getState().mode` 读最新值；
- 或用 `useRef` 持有最新值，在 `useEffect` 中同步：

```tsx
const modeRef = useRef(mode)
useEffect(() => { modeRef.current = mode }, [mode])
```

### GraphList 选中态的高亮

- `GraphList` 的选中项高亮通过 `data-selected="true"` 属性 + CSS 实现；
- 不要内联 `backgroundColor`，否则模式切换时颜色不联动；
- 选中态颜色用 `var(--kwa-accent-soft)`（study 墨绿浅 / work 琥珀浅）。

### Toast 的覆盖策略

- 当前 `pushToast` 实现是后到的覆盖前条（单条显示）；
- 如果在短时间内连续 push 多条 Toast，只会看到最后一条；
- 如需堆叠显示，需把 `toast: ToastMessage` 改为 `toasts: ToastMessage[]`，并在 `Toast.tsx` 中循环渲染。

## 下一步该读什么

| 你的角色 / 目标 | 下一步文档 |
|----------------|-----------|
| 要改图谱可视化 / 节点详情卡 / 测验面板 | [graph/DEVELOPMENT.md](./graph/DEVELOPMENT.md) |
| 要改全局状态 / action | [../store/DEVELOPMENT.md](../store/DEVELOPMENT.md) |
| 要改 HTTP / WS / 类型契约 | [../lib/DEVELOPMENT.md](../lib/DEVELOPMENT.md) |
| 要改样式 / 动画 | [../styles/DEVELOPMENT.md](../styles/DEVELOPMENT.md) |
| 要改 App 布局 / WebSocket 订阅 | [../DEVELOPMENT.md](../DEVELOPMENT.md)（含 App.tsx 说明） |
| 要看高层项目约束 | [../../../../DEVELOPMENT.md](../../../../DEVELOPMENT.md) |
