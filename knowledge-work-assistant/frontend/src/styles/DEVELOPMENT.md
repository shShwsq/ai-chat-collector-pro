# styles/ 样式开发指南

> 一句话定位：本目录是 KWA 前端的"样式层"，仅两个 CSS 文件：`app.css`（主样式，约 1000+ 行，定义全部布局 / 组件 / 模式变量 / 动画）与 `animations.css`（关键帧动画，被 `app.css` 引用）。本目录**不写组件**，只做"视觉呈现"；样式约定为 **BEM 类名 + CSS 变量**，不使用 CSS-in-JS、不使用 Tailwind 等原子 CSS。

## 模块职责

```
styles/
├── app.css            # 主样式：CSS 变量定义 + 全局重置 + 布局 + 全部组件样式 + 模式切换 + 响应式
└── animations.css     # 关键帧动画：闪烁 / 淡入 / 弹窗进场 / 旋转加载等
```

## 关键文件说明

### `app.css`（主样式）

- **设计方向**：refined minimalism —— 浅色主题、克制留白、中性灰阶为主，仅以一处低饱和强调色标注当前模式（study 墨绿 `#1a7f6e` / work 琥珀 `#b45309`），避免蓝紫渐变。
- **字体栈**：系统字体栈（`-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif`），无需外部字体文件。

#### CSS 变量定义（`:root`）

| 分组 | 变量 | 值 | 用途 |
| --- | --- | --- | --- |
| **中性色** | `--bg` | `#f5f5f7` | 页面根背景 |
|  | `--surface` | `#ffffff` | 卡片 / 弹窗 / 输入框底色 |
|  | `--surface-soft` | `#fafafa` | 次级表面：表头 / 禁用输入 |
|  | `--border` | `#e5e5e7` | 主要描边 |
|  | `--border-soft` | `#f0f0f2` | 弱描边：弹头内部分隔线 |
|  | `--text` | `#1d1d1f` | 主要文字 |
|  | `--text-secondary` | `#6e6e73` | 次要文字 |
|  | `--text-tertiary` | `#8e8e93` | 三级文字：占位符 / 元信息 |
|  | `--hover` | `#f5f5f7` | 列表项 / ghost 按钮 hover 底色 |
|  | `--danger` | `#b91c1c` | 错误 / 删除 |
|  | `--danger-soft` | `#fef2f2` | 错误提示背景 |
|  | `--danger-border` | `#fecaca` | 错误提示描边 |
| **强调色** | `--accent` | `#1a7f6e`（study）/ `#b45309`（work） | 主强调色：按钮 / 选中态 / focus 描边 |
|  | `--accent-soft` | `#eef5f2`（study）/ `#fbf3e8`（work） | 强调色浅底：chip / badge 背景 |
| **尺寸** | `--header-h` | `56px` | 顶部 header 高度 |
|  | `--sidebar-w` | `264px` | 左侧图谱列表宽度 |
|  | `--radius-sm` | `6px` | 按钮 / 输入框 / chip |
|  | `--radius-md` | `8px` | 卡片 / toast / 列表项 |
|  | `--radius-lg` | `12px` | 模态弹窗 / 大型容器 |
| **过渡** | `--ease` | `cubic-bezier(0.4, 0, 0.2, 1)` | 统一缓动 |
|  | `--transition-fast` | `160ms var(--ease)` | 即时反馈：hover / focus / 描边色变化 |
|  | `--transition-base` | `220ms var(--ease)` | 结构性变化：chip 模式切换 / toast 进场 |

#### 模式切换（`.app-shell[data-mode="..."]`）

- `.app-shell[data-mode="study"]` 覆写 `--accent: #1a7f6e` / `--accent-soft: #eef5f2`（墨绿）。
- `.app-shell[data-mode="work"]` 覆写 `--accent: #b45309` / `--accent-soft: #fbf3e8`（琥珀）。
- 切换模式时由 [App.tsx](../App.tsx) 设置 `<div className="app-shell" data-mode={mode}>` 的 `data-mode` 属性，CSS 变量自动联动，所有引用 `var(--accent)` 的元素同步变色。

#### 主要组件类

| 类名 | 用途 | 关键属性 |
| --- | --- | --- |
| `.app-shell` | 应用根容器 | `display: flex; flex-direction: column; min-height: 100vh` |
| `.app-header` | 顶部 56px 横栏 | 含 logo / 模式开关 / 提醒横幅 |
| `.app-body` | 主体三栏布局 | `display: flex; flex: 1` |
| `.side-nav` | 最左 56px 竖排导航 | `flex-shrink: 0` |
| `.side-nav__item` | 导航项 | hover / `is-active` 态 |
| `.graph-list` | 左侧 264px 图谱列表 | 含新建 / 重命名 / 删除按钮 |
| `.graph-list__item` | 图谱列表项 | hover / `is-active` 态 |
| `.content-area` | 中部内容区 | `flex: 1; display: flex; flex-direction: column` |
| `.content-toolbar` | 内容区顶栏 | 视图切换 / 重新布局 / 撤销延伸 / 开始测验 |
| `.graph-view` | 图谱视图容器 | SVG 内部绝对定位 |
| `.graph-view__node` | 节点小卡片 | 180×72px；含 `--gray` 灰色节点变体 |
| `.graph-view__node.is-flash` | 闪烁高亮态 | 触发 `node-flash` 动画 |
| `.graph-view__edge` | 边路径 | hover 高亮 |
| `.node-detail-card` | 节点详情卡 | 五区域绝对定位浮层 |
| `.card-view` | 卡片视图容器 | 按类型分组瀑布流 |
| `.card-view__group` | 卡片视图分组 | 含类型标题 |
| `.chat-home` | 对话主页 | 居中输入框 + 历史瀑布流 |
| `.chat-home__input-wrap` | 对话输入区 | 无消息时垂直居中，有消息时贴底 |
| `.chat-home__waterfall` | 历史瀑布流 | `max-height` 限制 + 内部滚动 |
| `.chat-panel` | 对话面板 | 内嵌对话视图 |
| `.mode-switch` | Study / Work 模式开关 | 胶囊形 toggle |
| `.settings-panel` | 设置面板 | LLM 配置 + 请求队列 + 插件对接 |
| `.toast` | 全局 Toast | `position: fixed; right: 24px; bottom: 24px` |
| `.toast--success` / `--warning` / `--error` | Toast 变体 | 含图标 + 边框色 |
| `.reminder-banner` | 顶部提醒横幅 | 到期 / 临近提醒 |
| `.recommendation-card` | 推荐项卡片 | study 复习 / work 提醒 |
| `.quiz-panel` | 测验浮层 | `position: fixed` + 遮罩层 |
| `.quiz-panel__option` | 测验选项 | hover / `is-selected` / `is-correct` / `is-wrong` 态 |
| `.work-input` / `.trends-sidebar` / `.report-panel` / `.qa-panel` | Work 浮层 | `position: fixed` + 遮罩层 |
| `.confirm-dialog` | 二次确认弹窗 | `position: fixed` + 遮罩层 |
| `.plugin-section` | 插件对接分区 | 最近推送 + 契约展示 |
| `.llm-request-list` | LLM 请求列表 | 含取消按钮 |

#### 全局重置

- `*` `box-sizing: border-box`、`margin: 0`、`padding: 0`。
- `html, body, #root` `height: 100%`。
- `body` 字体栈 + `font-size: 14px` + `color: var(--text)` + `background: var(--bg)`。
- `button` 重置默认样式（去除边框 / 背景 / 字体继承）。
- `a` `color: inherit; text-decoration: none`。
- `input` / `textarea` 字体继承 + `color: var(--text)`。
- 滚动条样式（webkit）：宽度 8px、滑块圆角 `var(--radius-sm)`、滑块颜色 `var(--border)`。

### `animations.css`（关键帧动画）

| 动画名 | 用途 | 时长 | 关键帧 |
| --- | --- | --- | --- |
| `node-flash` | 节点闪烁高亮（新建 / 命中已存在） | 1.8s（与 `FLASH_AUTO_CLEAR_MS` 对齐） | 0% 强发光 → 50% 弱发光 → 100% 无 |
| `toast-in` | Toast 进场 | 220ms | 0% translateX(100%) + opacity 0 → 100% translateX(0) + opacity 1 |
| `toast-out` | Toast 离场 | 160ms | 0% opacity 1 → 100% opacity 0 |
| `fade-in` | 通用淡入 | 220ms | 0% opacity 0 → 100% opacity 1 |
| `pop-in` | 弹窗进场 | 220ms | 0% scale(0.92) + opacity 0 → 100% scale(1) + opacity 1 |
| `spin` | 加载旋转 | 700ms 线性循环 | 0% rotate(0deg) → 100% rotate(360deg) |
| `pulse` | 脉动（如加载中按钮） | 1.4s | 0% / 100% opacity 1 → 50% opacity 0.5 |

## 开发工作流

### 新增一个组件样式

1. 在 `app.css` 找到对应业务域分组（如 `.graph-view__*` 在图谱视图分组、`.quiz-panel__*` 在测验分组）。
2. 用 BEM 命名：`.block` / `.block__element` / `.block--modifier` / `.block.is-state`。
3. 优先使用 CSS 变量（`var(--xxx)`），避免硬编码颜色 / 尺寸。
4. 强调色用 `var(--accent)` / `var(--accent-soft)`，随模式自动联动。
5. 过渡用 `var(--transition-fast)`（即时反馈）或 `var(--transition-base)`（结构性变化）。
6. 圆角用 `var(--radius-sm/md/lg)`，阴影用 `0 1px 2px rgba(0,0,0,0.05)` 等黑色低透明度。
7. 完成后在组件 `.tsx` 中添加 `className="xxx"`。

### 新增一个模式相关样式

1. 默认样式写在 `.block` 下，使用 `var(--accent)`。
2. 如需模式特定覆写，在 `.app-shell[data-mode="study"] .block` 或 `.app-shell[data-mode="work"] .block` 下覆写。
3. 优先通过覆写 CSS 变量（如 `--accent`）实现联动，避免直接写颜色值。

### 新增一个动画

1. 在 `animations.css` 定义 `@keyframes xxx { ... }`。
2. 在 `app.css` 的对应类中添加 `animation: xxx <duration> <easing> <iteration-count>`。
3. 动画时长优先用 `var(--transition-fast)` / `var(--transition-base)`，复杂动画可自定义。
4. 循环动画（如 `spin`）用 `linear` 缓动 + `infinite` 迭代次数。

### 修改主题色

1. 修改 `:root` 的 `--accent` / `--accent-soft` 默认值（study 模式色）。
2. 修改 `.app-shell[data-mode="study"]` / `.app-shell[data-mode="work"]` 的覆写值。
3. （插件侧 UI 已不再由本项目维护，若 collector 扩展后续接入主题色，需在 `web-ai-chat-collector` 内部自行管理，不与本项目联动）

## 代码约定

1. **BEM 命名**：`block` / `block__element` / `block--modifier` / `block.is-state`；不使用驼峰 / 下划线混合。
2. **CSS 变量优先**：颜色 / 尺寸 / 过渡 / 圆角一律用变量，避免硬编码；如需新变量，在 `:root` 定义。
3. **强调色随模式**：所有强调色用 `var(--accent)` / `var(--accent-soft)`，禁止硬编码 `#1a7f6e` / `#b45309`。
4. **过渡时长**：即时反馈（hover / focus / 描边色）用 `var(--transition-fast)`；结构性变化（进场 / 尺寸变化）用 `var(--transition-base)`；不要在常规 hover 上用超过 220ms 的过渡。
5. **阴影**：一律用黑色低透明度（`rgba(0,0,0,0.05)` ~ `0.12`），不使用彩色阴影。
6. **字重**：仅用 `400`（常规）/ `500`（次强调）/ `600`（强调）三档，避免 `700+`。
7. **z-index 分层**：`--header: 100` / `--sidebar: 90` / `--floating-panel: 200` / `--toast: 9999` / `--modal: 9998`（如需新增层级，先在 `:root` 定义变量）。
8. **响应式**：当前未做移动端适配，仅桌面端；如需响应式，用 `@media (max-width: 768px)` 等断点。
9. **暗色模式**：当前未启用，主应用 styles 暂未预留 `@media (prefers-color-scheme: dark)` 变量覆写；如需启用，在 `app.css` 的 `:root` 后追加暗色变量覆写块即可。
10. **不使用 CSS-in-JS**：所有样式集中在 `app.css` / `animations.css`，组件内不写 `style={{}}` 内联样式（除动态计算的位置 / 尺寸外）。

## 常见任务

### 修改节点卡片样式

搜索 `.graph-view__node`：

- 尺寸：在 [graphUtils.ts](../components/graph/graphUtils.ts) 同步修改 `NODE_WIDTH` / `NODE_HEIGHT`。
- 灰色节点：搜索 `.graph-view__node--gray` 修改背景 / 边框（虚线）。
- 闪烁高亮：搜索 `.graph-view__node.is-flash` 修改 `animation`；关键帧在 `animations.css` 的 `node-flash`。

### 修改 Toast 位置

搜索 `.toast`：

- `position: fixed; right: 24px; bottom: 24px` 改为所需位置。
- 多 Toast 堆叠时用 `transform: translateY(calc(100% + 12px))` 等计算。

### 修改浮层 z-index

在 `:root` 添加 `--z-xxx` 变量，浮层用 `z-index: var(--z-xxx)`；避免硬编码数字。

### 新增一个 CSS 变量

1. 在 `:root` 定义变量（如 `--my-color: #xxx`）。
2. 在 `.app-shell[data-mode="study"]` / `.app-shell[data-mode="work"]` 按需覆写。
3. 组件样式中用 `var(--my-color)` 引用。

## 扩展点

1. **暗色模式**：在 `@media (prefers-color-scheme: dark)` 中覆写 `--bg` / `--surface` / `--text` 等中性变量；强调色保持不变（study 墨绿 / work 琥珀在暗色下仍可读）。
2. **响应式**：用 `@media (max-width: 1024px)` 等断点调整 `--sidebar-w` / `--header-h` 等；移动端可隐藏左侧图谱列表，改为抽屉式。
3. **主题定制**：如需用户自定义主题色，把 `--accent` 改为从 `localStorage` 读取的运行时变量，通过 JS 注入 `:root` style。
4. **CSS Modules 迁移**：如需组件级样式隔离，可迁移到 CSS Modules（`*.module.css`），但需重构全部类名引用。

## 注意事项

1. **模式切换全局生效**：`data-mode` 设置在 `.app-shell` 根容器上，所有引用 `var(--accent)` 的元素自动联动；不要在子组件上重复设置 `data-mode`。
2. **`var(--accent)` 不可硬编码**：硬编码 `#1a7f6e` / `#b45309` 会导致模式切换时颜色不联动；搜索代码中是否有遗漏的硬编码色值。
3. **滚动条样式仅 webkit**：Firefox 不支持 `::-webkit-scrollbar`，如需 Firefox 兼容用 `scrollbar-color` / `scrollbar-width`。
4. **动画性能**：闪烁 / 旋转等高频动画用 `transform` / `opacity`（GPU 加速），避免触发 layout / paint；节点闪烁用 `box-shadow` + `filter: drop-shadow` 而非 `border` 变化。
5. **`z-index` 层级**：浮层（200）< 模态（9998）< Toast（9999）；新增浮层时按此层级分配，避免遮挡 Toast。
6. **`app.css` 规模**：当前约 1000+ 行，修改时务必先 `Ctrl+F` 定位到对应类名，避免误改其他组件样式。
7. **BEM 命名一致性**：现有类名均遵循 BEM，新增类名必须保持一致；不要混用驼峰（`graphView`）或下划线（`graph_view`）。
8. **`@media` 断点**：当前未定义统一断点变量，如需响应式建议先在 `:root` 定义 `--bp-sm: 640px` 等，再用 `@media (max-width: var(--bp-sm))`（注：CSS 变量不能直接用于 `@media`，需用 `@custom-media` 或预处理器）。
