# ui/ 统一样式包开发指南

> 一句话定位：本目录是 KWA 插件 SDK 的"统一样式包层"，仅两个文件：`kwa-plugin.css`（统一样式包，导出 `--kwa-accent` 等 CSS 变量 + `.kwa-btn` 等组件类）与 `style-guide.md`（样式规范文档，定义视觉语言与组件用法）。本目录**不写 JS 逻辑**，只做"视觉统一"；插件方只需 `<link>` 引入 `kwa-plugin.css` 并在根容器设置 `data-kwa-mode` 属性即可切换整套强调色，与主应用 study / work 双模式联动。

## 模块职责

```
ui/
├── kwa-plugin.css     # 统一样式包：CSS 变量定义 + 11 组组件类 + 暗色模式预留
└── style-guide.md     # 样式规范文档：颜色变量表 + 字体 + 圆角 + 阴影 + 组件外观 + 交互模式
```

## 关键文件说明

### `kwa-plugin.css`（统一样式包）

- **设计目标**：让所有接入插件在浅色主题、强调色、圆角、阴影、交互节奏上与主应用保持一致，避免各插件自行硬编码颜色（如原 [web-ai-chat-collector](../../../web-ai-chat-collector/) 中的 `#2563eb` 蓝色）。
- **使用方式**：插件方 `<link rel="stylesheet" href="kwa-plugin.css">` 引入，在根容器设置 `data-kwa-mode="study"` 或 `"work"` 即可切换整套强调色，无需改写组件代码。
- **CSS 变量命名**：所有变量以 `--kwa-` 前缀命名，避免与插件原有变量冲突。

#### 变量定义

| 分组 | 变量 | study 值 | work 值 | 用途 |
| --- | --- | --- | --- | --- |
| **强调色** | `--kwa-accent` | `#1a7f6e` | `#b45309` | 主强调色：按钮 / 选中态 / focus 描边 / 链接 |
|  | `--kwa-accent-soft` | `#eef5f2` | `#fbf3e8` | 强调色浅底：chip / badge 背景 / 选中行底色 |
|  | `--kwa-accent-hover` | `#15665a` | `#92440a` | 强调色加深：primary 按钮 hover |
| **中性色** | `--kwa-bg` | `#f5f5f7` | （不变） | 页面 / 插件根背景 |
|  | `--kwa-surface` | `#ffffff` | （不变） | 卡片 / 弹窗 / 输入框底色 |
|  | `--kwa-surface-soft` | `#fafafa` | （不变） | 次级表面：表头 / 禁用输入 |
|  | `--kwa-border` | `#e5e5e7` | （不变） | 主要描边 |
|  | `--kwa-border-soft` | `#f0f0f2` | （不变） | 弱描边：弹头内部分隔线 / divider |
|  | `--kwa-text` | `#1d1d1f` | （不变） | 主要文字 |
|  | `--kwa-text-secondary` | `#6e6e73` | （不变） | 次要文字 |
|  | `--kwa-text-tertiary` | `#8e8e93` | （不变） | 三级文字：占位符 / 元信息 / 时间戳 |
|  | `--kwa-hover` | `#f5f5f7` | （不变） | 列表项 / ghost 按钮 hover 底色 |
| **语义色** | `--kwa-danger` | `#b91c1c` | （不变） | 错误 / 删除 / 危险动作实心按钮 |
|  | `--kwa-danger-soft` | `#fef2f2` | （不变） | 错误提示背景 / danger badge 底色 |
|  | `--kwa-danger-border` | `#fecaca` | （不变） | 错误提示描边 |
|  | `--kwa-success` | `#22c55e` | （不变） | 成功状态：toast 图标 / success badge |
|  | `--kwa-warning` | `#b45309` | （不变） | 警告状态（与 work 强调色同值） |

#### 字体与字号

- **字体栈**：`-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif`，跨平台覆盖 macOS / Windows / iOS / Android 系统字体。
- **字号建议**：`18px`（h2，极少用）/ `16px`（h3）/ `14px`（body，`.kwa-scope` 基准）/ `13px`（控件，推荐）/ `12px`（small 辅助）/ `11px`（h6 微标）。
- **字重**：仅用 `400`（常规）/ `500`（次强调）/ `600`（强调）三档，避免 `700+`。

#### 圆角与阴影

| 变量 | 值 | 适用场景 |
| --- | --- | --- |
| `--kwa-radius-sm` | `6px` | 按钮 / 输入框 / textarea / chip / 小图标按钮 |
| `--kwa-radius-md` | `8px` | 卡片 / toast / 列表项容器 / 模态内分区 |
| `--kwa-radius-lg` | `12px` | 模态弹窗 / 大型容器 / 占位空状态 |
| `--kwa-shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | 卡片默认态 / 低层悬浮 |
| `--kwa-shadow-md` | `0 4px 12px rgba(0,0,0,0.08)` | toast / 下拉 / 次级浮层 |
| `--kwa-shadow-lg` | `0 8px 40px rgba(0,0,0,0.12)` | 模态弹窗 / 全屏遮罩上的主浮层 |

胶囊形元素（badge / toggle）使用 `999px`，不纳入变量档位。阴影一律使用黑色低透明度，不使用彩色阴影。

#### 11 组组件类

| 类名 | 用途 | 关键属性 |
| --- | --- | --- |
| `.kwa-btn` | 通用按钮（含 `--primary` / `--ghost` / `--danger` 变体） | `padding: 6px 16px; font-size: 13px; font-weight: 500; border-radius: var(--kwa-radius-sm)` |
| `.kwa-card` | 内容分组容器（含 `--accent` 强调色条变体） | `padding: 14px 16px; border-radius: var(--kwa-radius-md); --kwa-surface 底 + --kwa-border 描边 + --kwa-shadow-sm` |
| `.kwa-badge` | 状态 / 计数标记（含 `--accent` / `--danger` / `--success` 变体） | `padding: 2px 8px; font-size: 11px; font-weight: 600; border-radius: 999px` |
| `.kwa-input` | 单行文本输入 | `width: 100%; padding: 7px 10px; font-size: 13px; border-radius: var(--kwa-radius-sm)` |
| `.kwa-textarea` | 多行文本输入 | `padding: 8px 10px; font-size: 13px; line-height: 1.6; min-height: 72px; resize: vertical` |
| `.kwa-chip` | 平台 chip / 小型分类标签 | `padding: 2px 8px; font-size: 11px; font-weight: 500; border-radius: var(--kwa-radius-sm); --kwa-accent-soft 底 + --kwa-accent 字` |
| `.kwa-list` / `.kwa-list__item` | 垂直堆叠可交互列表 | 容器 `list-style: none; gap: 2px`；子项 `padding: 8px 10px; border-radius: var(--kwa-radius-sm)`；hover / `is-active` 态 |
| `.kwa-divider` | 水平方向轻量分隔 | `width: 100%; height: 1px; margin: 8px 0; background: var(--kwa-border-soft)` |
| `.kwa-toast` | 右下角全局浮层提示（含 `--success` / `--error` / `--info` 变体） | `position: fixed; right: 24px; bottom: 24px; z-index: 9999; max-width: 360px; padding: 10px 14px; border-radius: var(--kwa-radius-md); box-shadow: var(--kwa-shadow-lg); 进场动画 kwa-toast-in 220ms` |
| `.kwa-modal` | 模态弹窗（含 `__overlay` / `__box` / `__header` / `__body` / `__footer`） | `__overlay: position: fixed; inset: 0; z-index: 9998; background: rgba(29,29,31,0.32); backdrop-filter: blur(2px)`；`__box: max-width: 480px; border-radius: var(--kwa-radius-lg); box-shadow: var(--kwa-shadow-lg); 进场动画 kwa-pop-in` |
| `.kwa-spinner` | 加载旋转（含 `--sm` / `--lg` 变体） | 默认 `16px` 圆；`2px` 描边；底色 `--kwa-border`，顶部 `--kwa-accent`；`kwa-spin` 700ms 线性循环 |

#### 交互模式

| 变量 | 时长 | 缓动 | 适用场景 |
| --- | --- | --- | --- |
| `--kwa-transition-fast` | `160ms` | `cubic-bezier(0.4,0,0.2,1)` | 即时反馈：按钮 hover/active / 输入框 focus / 列表 hover / 描边色变化 |
| `--kwa-transition-base` | `220ms` | `cubic-bezier(0.4,0,0.2,1)` | 结构性变化：chip 模式切换 / toast 进场 / 弹窗进场 / `data-kwa-mode` 切换后的色彩过渡 |

选用原则：颜色 / 描边等视觉微调 用 `fast`；元素进场 / 尺寸或位置变化 用 `base`。不要在常规 hover 上使用超过 `220ms` 的过渡。

#### 暗色模式预留

- 主应用当前暂未启用暗色模式。
- `kwa-plugin.css` 已在 `@media (prefers-color-scheme: dark)` 中预留了 `--kwa-bg` / `--kwa-surface` / `--kwa-text` 等中性变量的暗色覆写，但**不会自动生效于主应用**。
- 插件方如需在系统暗色主题下自行适配，可直接依赖该媒体查询；如需关闭，可在插件根容器覆写这些变量为浅色值。
- 主应用后续启用暗色模式时会统一在此处扩展，并新增 `[data-kwa-theme="dark"]` 显式开关。

### `style-guide.md`（样式规范文档）

- **版本**：v1.0.0，对应文件 `kwa-plugin.css`，适用对象：接入 KWA 的浏览器插件。
- **章节结构**：
  1. 概述：设计目标与 `data-kwa-mode` 切换机制
  2. 颜色变量表：强调色 / 中性色 / 语义色
  3. 字体：字体栈 + 字号建议 + 字重
  4. 圆角：三档变量 + 胶囊形说明
  5. 阴影：三档变量 + 黑色低透明度原则
  6. 组件外观：11 组组件类的视觉规格 / 状态 / 变体 / HTML 示例
  7. 交互模式：过渡时长表 + 选用原则
  8. 暗色模式预留：`prefers-color-scheme` 与 `[data-kwa-theme]` 说明
  9. 风险提示：CSS 不参与鉴权 + 变量可被覆写
  10. 变更日志：v1.0.0 初版记录
- **HTML 示例**：每个组件类附完整 HTML 示例，可直接复制使用。
- **风险提示**：
  - 本样式包暂不参与鉴权：任何能加载 `kwa-plugin.css` 的页面均可读取其中的色值、变量名与类名结构。请勿在 CSS 中放置任何敏感信息（密钥、内部域名等）。
  - 插件与主应用的数据交互鉴权由 `kwa-push.js` 与后端 `/api/plugin/conversations` 负责，本样式包仅负责视觉层。
  - CSS 变量可被任意页面脚本读取与覆写，不要将其作为信任边界。

## 开发工作流

### 修改 CSS 变量值

1. 在 `kwa-plugin.css` 的 `:root`（中性色 + 默认 study 强调色）/ `[data-kwa-mode="study"]` / `[data-kwa-mode="work"]` 中修改变量值。
2. 在 `style-guide.md` 的颜色变量表中同步更新。
3. **主应用同步**：[frontend/src/styles/app.css](../../frontend/src/styles/app.css) 的 `--accent` / `--accent-soft` 必须与 `--kwa-accent` / `--kwa-accent-soft` 保持一致（study 墨绿 `#1a7f6e` / work 琥珀 `#b45309`）。
4. 在已接入的插件中验证模式切换效果。

### 新增一个组件类

1. 在 `kwa-plugin.css` 末尾添加新组件类（如 `.kwa-tabs` / `.kwa-tabs__item`）。
2. 用 BEM 命名：`.kwa-block` / `.kwa-block__element` / `.kwa-block--modifier` / `.kwa-block.is-state`。
3. 优先使用 CSS 变量（`var(--kwa-xxx)`），避免硬编码颜色 / 尺寸。
4. 在 `style-guide.md` 的「组件外观」一节添加新组件的视觉规格 / 状态 / 变体 / HTML 示例。
5. 在「变更日志」中记录新增。

### 新增一个 CSS 变量

1. 在 `:root` 定义变量（如 `--kwa-my-color: #xxx`）。
2. 在 `[data-kwa-mode="study"]` / `[data-kwa-mode="work"]` 按需覆写。
3. 在 `style-guide.md` 的对应变量表中添加新变量说明。
4. 在「变更日志」中记录新增。

### 修改组件视觉规格

1. 在 `kwa-plugin.css` 修改对应组件类的属性（如 `.kwa-btn` 的 `padding` / `font-size`）。
2. 在 `style-guide.md` 的对应组件章节同步更新视觉规格。
3. 在「变更日志」中记录变更。

## 代码约定

1. **`--kwa-` 前缀**：所有变量以 `--kwa-` 前缀命名，避免与插件原有变量冲突。
2. **BEM 命名**：`.kwa-block` / `.kwa-block__element` / `.kwa-block--modifier` / `.kwa-block.is-state`；不使用驼峰 / 下划线混合。
3. **CSS 变量优先**：颜色 / 尺寸 / 过渡 / 圆角一律用变量，避免硬编码；如需新变量，在 `:root` 定义。
4. **强调色随模式**：所有强调色用 `var(--kwa-accent)` / `var(--kwa-accent-soft)` / `var(--kwa-accent-hover)`，禁止硬编码 `#1a7f6e` / `#b45309`。
5. **过渡时长**：即时反馈用 `var(--kwa-transition-fast)`；结构性变化用 `var(--kwa-transition-base)`；不要在常规 hover 上用超过 `220ms` 的过渡。
6. **阴影**：一律用黑色低透明度（`rgba(0,0,0,0.05)` ~ `0.12`），不使用彩色阴影。
7. **字重**：仅用 `400` / `500` / `600` 三档，避免 `700+`。
8. **暗色模式预留**：中性变量在 `@media (prefers-color-scheme: dark)` 中预留暗色覆写；强调色保持不变（study 墨绿 / work 琥珀在暗色下仍可读）。
9. **不参与鉴权**：CSS 中不放置任何敏感信息；CSS 变量可被任意页面脚本读取与覆写，不作为信任边界。
10. **样式包独立**：`kwa-plugin.css` 不依赖主应用前端样式，可独立分发；插件方只需 `<link>` 引入即可。

## 常见任务

### 修改主色

1. 修改 `kwa-plugin.css` 的 `[data-kwa-mode="study"]` / `[data-kwa-mode="work"]` 中 `--kwa-accent` / `--kwa-accent-soft` / `--kwa-accent-hover` 的值。
2. 在 `style-guide.md` 的颜色变量表中同步更新。
3. **主应用同步**：[frontend/src/styles/app.css](../../frontend/src/styles/app.css) 的 `--accent` / `--accent-soft` 必须同步修改。

### 添加暗色模式支持

1. 在 `kwa-plugin.css` 的 `@media (prefers-color-scheme: dark)` 中覆写 `--kwa-bg` / `--kwa-surface` / `--kwa-text` 等中性变量为暗色值。
2. 强调色保持不变（study 墨绿 / work 琥珀在暗色下仍可读）。
3. 在 `style-guide.md` 的「暗色模式预留」一节更新说明。
4. 在主应用 [frontend/src/styles/app.css](../../frontend/src/styles/app.css) 中同步添加暗色模式覆写。

### 添加显式暗色模式开关

1. 在 `kwa-plugin.css` 添加 `[data-kwa-theme="dark"]` 选择器，覆写中性变量为暗色值。
2. 插件方在根容器设置 `data-kwa-theme="dark"` 即可显式启用暗色模式（覆盖 `prefers-color-scheme` 媒体查询）。
3. 在 `style-guide.md` 中更新说明。

### 修改 Toast 位置

搜索 `.kwa-toast`：

- `position: fixed; right: 24px; bottom: 24px` 改为所需位置。
- 注意 `z-index: 9999` 保持最高层级，避免被其他浮层遮挡。

## 扩展点

1. **暗色模式**：在 `@media (prefers-color-scheme: dark)` 中覆写中性变量；主应用启用暗色模式时同步扩展 `[data-kwa-theme="dark"]` 显式开关。
2. **主题定制**：如需用户自定义主题色，把 `--kwa-accent` 改为从 `localStorage` 读取的运行时变量，通过 JS 注入 `:root` style。
3. **CSS Modules 迁移**：如需组件级样式隔离，可迁移到 CSS Modules（`*.module.css`），但需重构全部类名引用。
4. **CSS-in-JS 适配**：如插件使用 CSS-in-JS（如 styled-components），可把 CSS 变量导入 JS 并在组件中引用 `var(--kwa-accent)` 等。

## 注意事项

1. **`--kwa-` 前缀**：所有变量必须以 `--kwa-` 前缀命名，避免与插件原有变量冲突；不要使用无前缀的变量名（如 `--accent`）。
2. **`data-kwa-mode` 设置位置**：在插件根容器（通常是 `<html>` 或 `<body>`）设置 `data-kwa-mode` 属性；未声明时回退到 study 模式。
3. **主应用同步**：[frontend/src/styles/app.css](../../frontend/src/styles/app.css) 的 `--accent` / `--accent-soft` 必须与 `--kwa-accent` / `--kwa-accent-soft` 保持一致；修改任一处必须同步另一处。
4. **不参与鉴权**：CSS 中不放置任何敏感信息（密钥、内部域名等）；CSS 变量可被任意页面脚本读取与覆写，不作为信任边界。
5. **`prefers-color-scheme` 不自动生效于主应用**：`@media (prefers-color-scheme: dark)` 仅对引入 `kwa-plugin.css` 的插件生效；主应用暂未启用暗色模式，需在 [frontend/src/styles/app.css](../../frontend/src/styles/app.css) 中单独添加。
6. **`z-index` 层级**：Toast（9999）> 模态（9998）> 其他浮层；新增浮层时按此层级分配，避免遮挡 Toast。
7. **胶囊形元素**：badge / toggle 使用 `999px`，不纳入 `--kwa-radius-*` 变量档位。
8. **样式包独立**：`kwa-plugin.css` 不依赖主应用前端样式，可独立分发；插件方只需 `<link>` 引入即可，无需复制主应用 CSS。
9. **`style-guide.md` 同步**：修改 `kwa-plugin.css` 必须同步更新 `style-guide.md` 的对应章节；在「变更日志」中记录变更。
10. **`web_accessible_resources`**：Chrome MV3 扩展中 `kwa-plugin.css` 必须加入 `web_accessible_resources`，否则 content script `<link>` 引入时会被拦截；详见 [secondary-dev/PATCH-GUIDE.md](../secondary-dev/PATCH-GUIDE.md) Step 8。
