# graph/ 图谱子组件开发指南

> 一句话定位：本目录是 KWA 前端组件层下的图谱专用子目录，集中存放与"知识图谱可视化、节点编辑、测验与 Work 模式浮层"相关的 11 个 `.tsx` 组件与 1 个 `graphUtils.ts` 纯函数工具。所有图谱视图（`view='graph'`）与卡片视图（`view='card'`）的渲染、节点交互、延伸 / 抽取 / 测验 / 报告 / 提问等浮层均在此实现。本目录组件统一通过 [`useAppStore`](../../store/useAppStore.ts) 读写全局状态，通过 [`api`](../../lib/api.ts) / [`ws`](../../lib/ws.ts) 与后端通信。

## 模块职责

```
graph/
├── GraphView.tsx          # 图谱主视图：d3-force 力导向布局 + SVG 渲染 + 拖拽 / 缩放 / 平移
├── CardView.tsx           # 卡片视图：节点按类型分组的瀑布流
├── NodeDetailCard.tsx     # 节点悬停详情卡：五区域布局 + 类型切换 + 延伸方向
├── NodeEditor.tsx         # 节点编辑表单：按模板字段渲染 + 类型切换
├── ConfirmDialog.tsx      # 通用二次确认弹窗（删除节点 / 删除图谱等）
├── PendingNodes.tsx       # Study 待抽取浮层：观察记录列表 + 候选节点确认入图
├── QuizPanel.tsx          # Study 测验浮层：config / answering / result 三段式
├── WorkInput.tsx          # Work 抽取入口浮层：文本输入 → 候选工作对象确认入图
├── TrendsSidebar.tsx      # Work 风口推荐侧栏：生成风口列表 + 加入图谱
├── ReportPanel.tsx        # Work 工作报告浮层：周期选择 + 流式预览 + 导出 docx
├── QAPanel.tsx            # Work 提问浮层：流式问答对话 + 来源 / 置信度展示
└── graphUtils.ts          # 纯函数工具：字符宽度估算 / 文本截断换行 / 边路径 / 坐标转换
```

## 关键文件说明

### `GraphView.tsx`（图谱主视图）

- **技术栈**：`d3-force` 力导向模拟 + 原生 SVG 渲染（不使用 react-d3 库）。
- **节点尺寸**：与 `graphUtils.ts` 的 `NODE_WIDTH=180` / `NODE_HEIGHT=72` 保持一致；卡片内边距 `CARD_PAD_X=12` / `CARD_PAD_TOP=10`。
- **力参数**：`forceManyBody` 互斥、`forceLink` 距离、`forceCenter` 居中、`forceCollide` 防重叠；`alphaDecay=0.045` 约 100 帧收敛。
- **性能策略**：tick 高频回调中通过 `nodeElsRef` / `edgeElsRef` 直接更新 DOM 的 `transform` / `d` 属性，**不触发 React 重渲染**；位置快照存于 `positionsRef` 供低频重渲染读取。
- **交互**：
  - 节点拖拽：拖拽时设置 `fx/fy` 固定位置，松开后保持。
  - 滚轮缩放：以光标为中心，缩放系数被 `clampScale` 限制在 `[0.2, 3]`。
  - 空白处拖拽平移：通过 `translate` 状态维护。
  - 悬停 400MS 显示 `NodeDetailCard`，移开 250ms 消失；单击节点固定（pinned）详情卡。
  - 双击节点触发 `store.extendNode(node.id, 'all')` 全部延伸。
  - 对话首页大卡无缝切换到图谱视图：由 `focusNodeAtCenter(nodeId)` 实现，配合 `setSelectedNode` + `setActiveNav('graph')` 完成从大卡浮层到图谱视图的平滑过渡。
- **对外方法**：通过 `forwardRef` + `useImperativeHandle` 暴露三个方法：
  - `relayout()`：重启 d3-force 模拟，供 `ContentToolbar` 的"重新布局"按钮调用。
  - `resetView()`：`setTransform({ x: 0, y: 0, k: 1 })`，重置画布平移与缩放到初始状态。
  - `focusNodeAtCenter(nodeId)`：从 `positionsRef` 取节点位置，平移画布让该节点位于视口正中央，缩放保持不变；节点不存在或位置未就绪时静默返回。
- **闪烁高亮**：`store.flashNodeIds` 命中的节点添加 `is-flash` CSS 类触发动画（见 [styles/app.css](../../styles/app.css)）。

### `NodeDetailCard.tsx`（节点详情卡）

- **五区域布局**（参考 `设计方案.md` 第二部分）：
  1. 节点标题 + 类型标签（含"切换类型"下拉，记忆到后端）
  2. 知识点概括（优先 `generated.summary`，回退 `node.summary` / 首字段）
  3. 重要点 / 关键材料（`generated.important_points` 列表 + 其余模板字段）
  4. 延伸方向推荐（`generated.extension_directions`，可点击触发单点延伸）
  5. 我的补充留白区（输入框 + 类型选择 + 保存 / 保存并延伸）
- **详情来源策略**：若 `detail_payload` 已含 `_important_points` 键则直接从缓存构建；否则调用 `store.generateNodeDetail` / `generateNodeDetailStream` 生成并回写。
- **定位**：由父组件 `GraphView` 计算 `position`（left/top/width/maxHeight），卡片绝对定位、不超出视口、自身可滚动。
- **props**：除 `node` / `position` 等基础字段外，新增可选 prop `onRequestGraphSwitch?: (nodeId: string) => void`，用于大卡浮层无缝切换到图谱视图；图谱视图内部渲染时该 prop 为 `undefined`，无副作用。
- **Task 8 延伸接入**：
  - 单击"延伸方向推荐"项 → `store.extendNode(node.id, 'single', direction.name)`，仅生成该方向一个节点，不进 batch；同时触发 `onRequestGraphSwitch?.(latestNode.id)` 通知浮层切换。
  - "保存并延伸"按钮：先保存留白内容，再以该内容作为 `direction_name` 触发单点延伸；同时触发 `onRequestGraphSwitch?.(latestNode.id)` 通知浮层切换。
  - `extending` 进行中时禁用所有延伸类按钮，避免并发触发。

### `NodeEditor.tsx`（节点编辑表单）

- 按当前图谱类型（study / work）与节点 type 从 [`nodeTemplates.ts`](../../lib/nodeTemplates.ts) 选取模板字段渲染输入框。
- 字段变更本地暂存，"保存"调用 `store.updateNode`；"取消"丢弃。
- 类型切换下拉：切换后重新解析模板，已填字段保留至同名字段，多余字段丢弃。

### `CardView.tsx`（卡片视图）

- `view='card'` 时显示。按节点 `type` 分组，每组瀑布流排列。
- 卡片悬停同样可触发 `NodeDetailCard`（与 `GraphView` 共享选中 / 悬停状态）。
- 节点变更后由 `useAppStore.fullGraph` 自动驱动重渲染。

### `PendingNodes.tsx`（Study 待抽取浮层）

- 双栏布局：左栏 `pendingObservations` 列表（按时间倒序），右栏 `candidateNodes` 候选列表。
- 用户点击左栏项 → `store.extractCandidates(observationId)`；右栏展示候选节点，可勾选。
- "确认入图"按钮 → `store.batchCreateNodes(selectedNodes, observationId)`；成功后整图刷新、闪烁高亮新建节点、左栏自动刷新。

### `QuizPanel.tsx`（Study 测验浮层）

- **三段式阶段**（`store.quizStage`）：
  - `config`：选择题型（single_choice / multi_choice / feynman）+ 限定节点范围（null=全图随机）。
  - `answering`：渲染题目（选择题 options / 费曼题 prompt），提交答案。
  - `result`：显示判分结果（选择题正确答案 + 解析 / 费曼题理解度评分 + 反馈）。
- 历史列表：点击进入 `reviewQuiz` 流程，复用 `result` 视图。
- 降级题目（`payload.degraded=true`）显示提示横幅但仍可作答。

### `WorkInput.tsx`（Work 抽取入口浮层）

- 文本输入区 + "抽取"按钮 → `store.extractWorkObjects(text)`。
- 候选列表展示 `candidateWorkObjects`（含建议关系 `relation`），可勾选 / 编辑。
- "确认入图" → `store.confirmWorkObjects(selected)`；成功后整图刷新、闪烁高亮新建节点、关系边建立。

### `TrendsSidebar.tsx`（Work 风口推荐侧栏）

- "生成风口"按钮 → `store.generateTrends()`。
- 风口列表展示 `trends`（含 `title` / `reason` / `relevance` / `suggested_actions`）。
- 每条"加入图谱"按钮 → `store.addTrendToGraph(index)`；`trendAddingIndex` 标记当前加载项。

### `ReportPanel.tsx`（Work 工作报告浮层）

- 周期切换（weekly / monthly）→ `store.setReportPeriod`。
- "生成报告"按钮 → `store.generateReportStream()`（优先流式，回退非流式 `generateReport`）。
- 流式预览：`store.reportStreamingText` 实时累积，渲染为 Markdown。
- "导出 docx"按钮 → `store.exportReportDocx()`，触发浏览器下载。

### `QAPanel.tsx`（Work 提问浮层）

- 对话历史展示 `store.qaMessages`（user / assistant 交替）。
- 输入框 + "发送"按钮 → `store.askWorkQuestionStream(question)`（优先流式，回退非流式）。
- 流式打字机效果：`store.qaStreamingText` 实时追加到最后一条 assistant 消息。
- assistant 消息展示来源节点（`sources`）与置信度（`confidence`）；降级回答显示降级提示。

### `ConfirmDialog.tsx`（通用确认弹窗）

- 受控组件：`open` / `title` / `message` / `onConfirm` / `onCancel` props。
- 用于删除节点 / 删除图谱 / 撤销延伸等需要二次确认的场景。
- ESC 键 / 遮罩层点击触发 `onCancel`。

### `graphUtils.ts`（纯函数工具）

- **不依赖 React**，可在 tick 高频回调中直接复用。
- 导出常量：`NODE_WIDTH=180` / `NODE_HEIGHT=72` / `CARD_PAD_X=12` / `CARD_PAD_TOP=10`。
- 函数：
  - `estimateTextWidth(text, fontSize)`：按字符宽度估算渲染宽度（CJK 全角 ≈ fontSize，其余 ≈ 0.55×fontSize）。
  - `truncateText(text, maxWidth, fontSize)`：单行截断 + 末尾省略号。
  - `wrapText(text, maxWidth, fontSize, maxLines)`：多行拆分，最后一行超长截断。
  - `edgePath(x1, y1, x2, y2, curvature=0.12)`：二次贝塞尔曲线，避免双向边重叠。
  - `screenToSvg(clientX, clientY, svg, translate, scale)`：屏幕坐标转 SVG 内部坐标。
  - `clampScale(k, min=0.2, max=3)`：限制缩放系数。

## 开发工作流

### 新增图谱相关组件

1. 在本目录创建 `XxxPanel.tsx`，遵循现有命名（Panel=浮层、View=视图、Card=卡片、Editor=表单）。
2. 在 [`useAppStore`](../../store/useAppStore.ts) 中添加对应状态字段与 action（如 `xxxPanelOpen` / `xxxLoading` / `setXxxPanelOpen`）。
3. 通过 `useAppStore(s => s.xxx)` 订阅所需状态，避免订阅整个 store 触发多余渲染。
4. 在 [`ContentToolbar.tsx`](../ContentToolbar.tsx) 或 [`App.tsx`](../../App.tsx) 中挂载浮层入口按钮与浮层本身。
5. 浮层定位参考 `ReportPanel` / `QAPanel`：`position: fixed` + `z-index` 分层 + 遮罩层。

### 调试 d3-force 布局

1. 修改 `GraphView.tsx` 中 `forceSimulation` 的力参数（`forceManyBody` / `forceLink` / `forceCollide`）。
2. 调整 `alphaDecay` 影响收敛速度（越小越慢越稳定，越大越快越抖）。
3. 通过 `relayout()` 暴露的方法可在运行时重新触发模拟。
4. 节点位置抖动可通过设置 `fx/fy` 固定，或调大 `forceCollide` 半径。

### 调试流式输出

1. 确认 `useAppStore.streamingSessionId` 已被 [`App.tsx`](../../App.tsx) 设置（启动时生成 UUID）。
2. 确认 WebSocket 连接已建立且注册到该 `session_id`（`TestSocket.connect(sessionId)`）。
3. 后端流式 token 通过 `graph_agent_token` 事件推送，由 `store.handleGraphAgentToken` 按 `op` 分发。
4. 流式中断 / 错误由 `handleGraphAgentError` / `handleGraphAgentCancelled` 处理，UI 显示降级提示。

## 代码约定

1. **状态读写一律走 `useAppStore`**：组件不维护业务态本地 state（仅 UI 控制态如 `isHover` 可本地）。
2. **选择器订阅**：用 `useAppStore(s => s.xxx)` 而非 `useAppStore()` 全量订阅，避免无关状态变化触发重渲染。
3. **副作用**：所有异步操作通过 store action 触发，组件层不直接调用 `api.xxx`（保持可测试性）。
4. **类型契约**：所有 props 与 store 字段必须有 TypeScript 类型，与 [`lib/types.ts`](../../lib/types.ts) 对齐。
5. **样式**：BEM 类名 + CSS 变量，类名前缀按业务域（如 `graph-view__node` / `quiz-panel__option`）；不使用 CSS-in-JS。
6. **降级处理**：所有依赖 LLM 的功能必须处理 `degraded=true`，UI 显示"AI 服务暂不可用"提示并保留可用功能。
7. **流式优先**：有 `streamingSessionId` 时优先调用流式 API，否则回退非流式（`generateNodeDetail` / `askWorkQuestion` / `generateReport`）。
8. **国际化**：当前为中文硬编码，暂无 i18n 计划；新增文案保持中文，避免英文混入。

## 常见任务

### 新增一种节点类型

1. 在 [`lib/nodeTemplates.ts`](../../lib/nodeTemplates.ts) 添加枚举常量 + 中文标签。
2. 在 `STUDY_TEMPLATES` / `WORK_TEMPLATES` 添加该类型的模板字段定义。
3. 后端 `app/models/node_types.py` 同步添加（前后端必须对齐）。
4. `NodeEditor.tsx` / `NodeDetailCard.tsx` 自动按新模板渲染，无需改动。
5. 如需特殊渲染（如图标 / 颜色），在组件中按 `node.type` 分支处理。

### 新增一个 Work 浮层面板

参考 `ReportPanel.tsx` 实现：

```tsx
import { useAppStore } from '../../store/useAppStore'

export function NewPanel() {
  const open = useAppStore(s => s.workActivePanel === 'new')
  const setPanel = useAppStore(s => s.setWorkPanel)
  // ... 业务态订阅
  if (!open) return null
  return (
    <div className="new-panel__overlay" onClick={() => setPanel('none')}>
      <div className="new-panel__box" onClick={e => e.stopPropagation()}>
        {/* 内容 */}
      </div>
    </div>
  )
}
```

在 `WorkPanel` 类型中添加 `'new'` 选项，在 [`App.tsx`](../../App.tsx) 挂载 `<NewPanel />`，在 `ContentToolbar` 添加入口按钮。

### 修改节点卡片样式

- 节点尺寸：同步修改 `graphUtils.ts` 的 `NODE_WIDTH` / `NODE_HEIGHT` 与 `GraphView.tsx` 的渲染尺寸。
- 卡片样式：在 [`styles/app.css`](../../styles/app.css) 中搜索 `.graph-view__node` 修改。
- 灰色节点（`is_gray=true`）：搜索 `.graph-view__node--gray` 修改背景 / 边框。
- 闪烁高亮：搜索 `.graph-view__node.is-flash` 修改动画关键帧。

### 新增一种测验题型

1. 在 [`lib/types.ts`](../../lib/types.ts) 的 `QuizType` 联合类型添加新值。
2. 在 `QuizPanel.tsx` 的 `config` 阶段添加题型选择按钮。
3. 在 `answering` 阶段按 `quiz.type` 分支渲染新题型的作答 UI。
4. 在 `store.answerQuiz` 中按 `quiz.type` 分支处理答案格式（数组 / 字符串 / 其他）。
5. 后端 `app/routers/quiz.py` 同步添加生成 / 判分逻辑。

## 扩展点

1. **图谱视图渲染**：当前为 SVG，如需切换到 Canvas（性能更高）或 WebGL，可在 `GraphView.tsx` 内部替换渲染层，对外保留 `relayout()` 接口。
2. **节点详情卡布局**：五区域结构固定，如需扩展可在区域 ③ 与 ④ 之间插入新区域，同步更新 `NodeDetailCard.tsx` 与 `设计方案.md`。
3. **测验题型**：`QuizType` 联合类型可扩展，后端 `payload` 字段为自由 JSON，前端按 `type` 分支渲染即可。
4. **Work 浮层**：`WorkPanel` 类型可扩展新值，复用 `setWorkPanel` 切换逻辑与 `workActivePanel` 状态。

## 注意事项

1. **d3-force 性能**：节点数超过 200 时建议关闭 `forceCollide` 或调大 `alphaDecay`，避免 tick 卡顿；当前未做虚拟化，超过 500 节点需考虑 Canvas 重写。
2. **流式状态隔离**：`qaStreamingText` / `reportStreamingText` / `nodeDetailStreamingText` 三个流式状态相互独立，但共用同一个 WebSocket 连接；切换图谱 / 模式时由 `setMode` / `selectGraph` 统一清空，避免跨图谱残留。
3. **闪烁定时器**：`store.flashNodes(ids, true)` 会在 1.8s 后自动清空，组件层无需手动清理；若需立即清空调用 `clearFlash()`。
4. **降级路径**：所有 LLM 依赖功能必须有降级路径（`degraded=true` 时返回兜底数据），UI 不可因降级而崩溃。
5. **节点删除级联**：删除节点会级联清理相关边与测验，由后端处理；前端在 `store.deleteNode` 中本地同步移除 `fullGraph.nodes` / `edges`，避免等待整图刷新。
6. **二次确认**：删除节点 / 删除图谱 / 撤销延伸等不可逆操作必须经过 `ConfirmDialog`；不要在 `window.confirm` 中实现。
7. **图谱坐标系**：SVG 内部坐标与屏幕坐标通过 `screenToSvg` 转换；新增交互（如右键菜单）时注意使用转换后的坐标。
