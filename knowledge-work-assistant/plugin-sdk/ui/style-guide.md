# KWA Plugin UI Kit 样式规范

> 版本：v1.0.0　·　对应文件：`kwa-plugin.css`　·　适用对象：接入「知识工作助手」的浏览器插件

## 1. 概述

本规范定义了知识工作助手浏览器插件统一样式包的视觉语言与组件用法。其目的是让所有接入插件在浅色主题、强调色、圆角、阴影、交互节奏上与主应用保持一致，并通过 `study`（墨绿）/ `work`（琥珀）双模式 CSS 变量实现色彩联动，避免各插件自行硬编码颜色（如原 `web-ai-chat-collector` 中的 `#2563eb` 蓝色）。引入 `kwa-plugin.css` 后，插件方只需在根容器设置 `data-kwa-mode` 属性即可切换整套强调色，无需改写组件代码。

## 2. 颜色变量表

所有变量以 `--kwa-` 前缀命名，定义在 `:root`（中性色 + 默认 study 强调色）与 `[data-kwa-mode="study"]` / `[data-kwa-mode="work"]`（覆写强调色）上。未声明 `data-kwa-mode` 时回退到 study 模式。

### 强调色（随模式切换）

| 变量 | study 值 | work 值 | 用途 |
| --- | --- | --- | --- |
| `--kwa-accent` | `#1a7f6e` | `#b45309` | 主强调色：按钮、选中态、focus 描边、链接 |
| `--kwa-accent-soft` | `#eef5f2` | `#fbf3e8` | 强调色浅底：chip / badge 背景、选中行底色、focus 光晕 |
| `--kwa-accent-hover` | `#15665a` | `#92440a` | 强调色加深：primary 按钮 hover |

### 中性色（不随模式变化）

| 变量 | 值 | 用途 |
| --- | --- | --- |
| `--kwa-bg` | `#f5f5f7` | 页面/插件根背景 |
| `--kwa-surface` | `#ffffff` | 卡片、弹窗、输入框底色 |
| `--kwa-surface-soft` | `#fafafa` | 次级表面：表头、禁用输入、占位区 |
| `--kwa-border` | `#e5e5e7` | 主要描边：卡片边、输入框边、分隔 |
| `--kwa-border-soft` | `#f0f0f2` | 弱描边：弹头内部分隔线、divider |
| `--kwa-text` | `#1d1d1f` | 主要文字 |
| `--kwa-text-secondary` | `#6e6e73` | 次要文字：说明、表头 |
| `--kwa-text-tertiary` | `#8e8e93` | 三级文字：占位符、元信息、时间戳 |
| `--kwa-hover` | `#f5f5f7` | 列表项 / ghost 按钮 hover 底色 |

### 语义色

| 变量 | 值 | 用途 |
| --- | --- | --- |
| `--kwa-danger` | `#b91c1c` | 错误、删除、危险动作实心按钮 |
| `--kwa-danger-soft` | `#fef2f2` | 错误提示背景、danger badge 底色 |
| `--kwa-danger-border` | `#fecaca` | 错误提示描边 |
| `--kwa-success` | `#22c55e` | 成功状态：toast 图标、success badge |
| `--kwa-warning` | `#b45309` | 警告状态（与 work 强调色同值） |

## 3. 字体

### 字体栈

```
--kwa-font-stack: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
  'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif;
```

跨平台覆盖 macOS / Windows / iOS / Android 系统字体，无需外部字体文件。

### 字号建议

| 字号 | 用途层级 | 对应组件 |
| --- | --- | --- |
| `18px` | h2 大标题 | 极少使用，弹窗主标题可用 `15px` 起 |
| `16px` | h3 标题 | 卡片标题、面板主标题 |
| `14px` | body 正文 | 默认正文、`.kwa-scope` 基准 |
| `13px` | 控件文字 | 按钮、输入框、弹窗 body（推荐） |
| `12px` | small 辅助 | 元信息、列表 meta |
| `11px` | h6 微标 | badge、chip、时间戳 |

字重仅用 `400`（常规）/ `500`（次强调）/ `600`（强调）三档，避免 `700+`。

## 4. 圆角

| 变量 | 值 | 适用场景 |
| --- | --- | --- |
| `--kwa-radius-sm` | `6px` | 按钮、输入框、textarea、chip、小图标按钮 |
| `--kwa-radius-md` | `8px` | 卡片、toast、列表项容器、模态内分区 |
| `--kwa-radius-lg` | `12px` | 模态弹窗、大型容器、占位空状态 |

胶囊形元素（badge、toggle）使用 `999px`，不纳入变量档位。

## 5. 阴影

| 变量 | 值 | 适用场景 |
| --- | --- | --- |
| `--kwa-shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | 卡片默认态、低层悬浮 |
| `--kwa-shadow-md` | `0 4px 12px rgba(0,0,0,0.08)` | toast、下拉、次级浮层 |
| `--kwa-shadow-lg` | `0 8px 40px rgba(0,0,0,0.12)` | 模态弹窗、全屏遮罩上的主浮层 |

阴影一律使用黑色低透明度，不使用彩色阴影。hover 态可在 `sm` 与 `md` 之间切换以表达层级提升。

## 6. 组件外观

### 6.1 按钮 `.kwa-btn`

- 用途：通用操作触发，支持 `primary` / `ghost` / `danger` 三种语义变体。
- 视觉规格：`padding: 6px 16px`；`font-size: 13px`；`font-weight: 500`；`border-radius: var(--kwa-radius-sm)`；`box-sizing: border-box`。
- 状态：
  - default：白底 + `--kwa-border` 描边 + `--kwa-text` 文字
  - hover：底色 `--kwa-hover`，描边 `--kwa-text-tertiary`
  - active：底色 `--kwa-border-soft`，`translateY(0.5px)`
  - focus-visible：`outline: 2px solid var(--kwa-accent); outline-offset: 2px`
  - disabled：`opacity: 0.5`，`cursor: not-allowed`
- 变体：
  - `--primary`：`--kwa-accent` 实心 + 白字，hover 走 `--kwa-accent-hover`
  - `--ghost`：透明背景 + 描边，hover 走 `--kwa-hover`
  - `--danger`：`--kwa-danger` 实心 + 白字，hover `brightness(0.92)`
- HTML 示例：

```html
<button class="kwa-btn kwa-btn--primary">保存</button>
<button class="kwa-btn kwa-btn--ghost">取消</button>
<button class="kwa-btn kwa-btn--danger">删除</button>
<button class="kwa-btn" disabled>禁用</button>
```

### 6.2 卡片 `.kwa-card`

- 用途：内容分组容器，承载表单、记录、说明等。
- 视觉规格：`padding: 14px 16px`；`border-radius: var(--kwa-radius-md)`；`--kwa-surface` 底 + `--kwa-border` 描边 + `--kwa-shadow-sm`。
- 变体 `--accent`：左侧 `3px solid var(--kwa-accent)` 强调色条，`padding-left: 19px`。
- HTML 示例：

```html
<div class="kwa-card">普通卡片内容</div>
<div class="kwa-card kwa-card--accent">带强调色条的卡片</div>
```

### 6.3 徽标 `.kwa-badge`

- 用途：状态/计数标记，胶囊形。
- 视觉规格：`padding: 2px 8px`；`font-size: 11px`；`font-weight: 600`；`border-radius: 999px`。
- 状态/变体：
  - default：`--kwa-border-soft` 底 + `--kwa-text-secondary` 字
  - `--accent`：`--kwa-accent-soft` 底 + `--kwa-accent` 字
  - `--danger`：`--kwa-danger-soft` 底 + `--kwa-danger-border` 描边 + `--kwa-danger` 字
  - `--success`：`#dcfce7` 底 + `#15803d` 字
- HTML 示例：

```html
<span class="kwa-badge">默认</span>
<span class="kwa-badge kwa-badge--accent">study</span>
<span class="kwa-badge kwa-badge--danger">去重</span>
<span class="kwa-badge kwa-badge--success">成功</span>
```

### 6.4 输入框 `.kwa-input`

- 用途：单行文本输入。
- 视觉规格：`width: 100%`；`padding: 7px 10px`；`font-size: 13px`；`border-radius: var(--kwa-radius-sm)`；`--kwa-surface` 底 + `--kwa-border` 描边。
- 状态：
  - default：`--kwa-border` 描边
  - hover（非 focus）：描边 `--kwa-text-tertiary`
  - focus：描边 `--kwa-accent` + `box-shadow: 0 0 0 2px var(--kwa-accent-soft)`
  - disabled：底色 `--kwa-surface-soft`，字色 `--kwa-text-tertiary`
  - placeholder：`--kwa-text-tertiary`
- HTML 示例：

```html
<input class="kwa-input" placeholder="请输入推送目标 URL" />
<input class="kwa-input" value="禁用态" disabled />
```

### 6.5 多行输入 `.kwa-textarea`

- 用途：长文本输入。
- 视觉规格：`padding: 8px 10px`；`font-size: 13px`；`line-height: 1.6`；`min-height: 72px`；`resize: vertical`；圆角 `--kwa-radius-sm`。
- 状态：与 `.kwa-input` 一致（default / hover / focus / disabled）。
- HTML 示例：

```html
<textarea class="kwa-textarea" placeholder="输入对话内容..."></textarea>
```

### 6.6 平台 chip `.kwa-chip`

- 用途：标记平台来源（chatgpt / claude / gemini 等）或小型分类标签。
- 视觉规格：`padding: 2px 8px`；`font-size: 11px`；`font-weight: 500`；`border-radius: var(--kwa-radius-sm)`；`--kwa-accent-soft` 底 + `--kwa-accent` 字。
- 状态：随 `data-kwa-mode` 联动变色，无独立 hover 态。
- HTML 示例：

```html
<span class="kwa-chip">ChatGPT</span>
<span class="kwa-chip">Claude</span>
```

### 6.7 列表 `.kwa-list`

- 用途：垂直堆叠的可交互项（最近推送记录、候选节点等）。
- 视觉规格：容器 `list-style: none`，`gap: 2px`；子项 `.kwa-list__item` `padding: 8px 10px`，`border-radius: var(--kwa-radius-sm)`。
- 状态：
  - default：透明底
  - hover：底色 `--kwa-hover`
  - `is-active`：底色 `--kwa-accent-soft`
- HTML 示例：

```html
<ul class="kwa-list">
  <li class="kwa-list__item">第一项</li>
  <li class="kwa-list__item is-active">选中项</li>
  <li class="kwa-list__item">第三项</li>
</ul>
```

### 6.8 分隔线 `.kwa-divider`

- 用途：水平方向轻量分隔。
- 视觉规格：`width: 100%`；`height: 1px`；`margin: 8px 0`；背景 `--kwa-border-soft`；无边框。
- 状态：无。
- HTML 示例：

```html
<hr class="kwa-divider" />
```

### 6.9 Toast 通知 `.kwa-toast`

- 用途：右下角全局浮层提示（推送结果、错误反馈等）。
- 视觉规格：`position: fixed; right: 24px; bottom: 24px`；`z-index: 9999`；`max-width: 360px`；`padding: 10px 14px`；`border-radius: var(--kwa-radius-md)`；`box-shadow: var(--kwa-shadow-lg)`；进场动画 `kwa-toast-in`（220ms）。
- 结构：`.kwa-toast__icon`（圆形图标 18px）+ `.kwa-toast__msg`。
- 变体：
  - default / `--info`：白底 + `--kwa-border` 描边，图标 `--kwa-accent`
  - `--success`：描边 `#c6e4dc`，图标 `--kwa-success`
  - `--error`：底色 `--kwa-danger-soft` + 描边 `--kwa-danger-border` + 字色 `--kwa-danger`，图标 `--kwa-danger`
- HTML 示例：

```html
<div class="kwa-toast kwa-toast--success">
  <span class="kwa-toast__icon">✓</span>
  <span class="kwa-toast__msg">推送成功</span>
</div>
<div class="kwa-toast kwa-toast--error">
  <span class="kwa-toast__icon">!</span>
  <span class="kwa-toast__msg">推送失败：网络错误</span>
</div>
```
- 备注：建议由 JS 动态插入并在 3 秒后移除；同一时刻只展示一个 toast。

### 6.10 模态弹窗 `.kwa-modal`

- 用途：需要用户聚焦的确认 / 表单 / 详情弹窗。
- 视觉规格：
  - `__overlay`：`position: fixed; inset: 0`；`z-index: 9998`；`background: rgba(29,29,31,0.32)`；`backdrop-filter: blur(2px)`；进场 `kwa-fade-in`
  - `__box`：`max-width: 480px`；`max-height: calc(100vh - 48px)`；`border-radius: var(--kwa-radius-lg)`；`box-shadow: var(--kwa-shadow-lg)`；进场 `kwa-pop-in`
  - `__header`：`padding: 14px 16px`，下边框 `--kwa-border-soft`，含 `.kwa-modal__title`（15px / 600）
  - `__body`：`padding: 14px 16px`，`overflow-y: auto`，`font-size: 13px`
  - `__footer`：`padding: 12px 16px`，上边框 `--kwa-border-soft`，右对齐操作按钮
- 状态：无 hover/active；建议由 JS 控制 display 或挂载/卸载。
- HTML 示例：

```html
<div class="kwa-modal__overlay">
  <div class="kwa-modal__box">
    <div class="kwa-modal__header">
      <h3 class="kwa-modal__title">查看契约</h3>
      <button class="kwa-btn kwa-btn--ghost">关闭</button>
    </div>
    <div class="kwa-modal__body">契约 JSON 内容...</div>
    <div class="kwa-modal__footer">
      <button class="kwa-btn kwa-btn--ghost">取消</button>
      <button class="kwa-btn kwa-btn--primary">复制</button>
    </div>
  </div>
</div>
```

### 6.11 加载旋转 `.kwa-spinner`

- 用途：异步加载占位。
- 视觉规格：默认 `16px` 圆；`2px` 描边；底色 `--kwa-border`，顶部 `--kwa-accent`；`kwa-spin` 700ms 线性循环。
- 变体：`--sm`（12px / 1.5px）、`--lg`（24px / 2.5px）。
- 状态：无。
- HTML 示例：

```html
<span class="kwa-spinner"></span>
<span class="kwa-spinner kwa-spinner--sm"></span>
<span class="kwa-spinner kwa-spinner--lg"></span>
```

## 7. 交互模式

### 过渡时长

| 变量 | 时长 | 缓动 | 适用场景 |
| --- | --- | --- | --- |
| `--kwa-transition-fast` | `160ms` | `cubic-bezier(0.4,0,0.2,1)` | 即时反馈：按钮 hover/active、输入框 focus、列表 hover、描边色变化 |
| `--kwa-transition-base` | `220ms` | `cubic-bezier(0.4,0,0.2,1)` | 结构性变化：chip 模式切换、toast 进场、弹窗进场、`data-kwa-mode` 切换后的色彩过渡 |

选用原则：颜色/描边等视觉微调用 `fast`；元素进场、尺寸或位置变化用 `base`。不要在常规 hover 上使用超过 `220ms` 的过渡，避免拖沓感。

## 8. 暗色模式预留

主应用当前暂未启用暗色模式，`kwa-plugin.css` 已在 `@media (prefers-color-scheme: dark)` 中预留了 `--kwa-bg / --kwa-surface / --kwa-text` 等中性变量的暗色覆写，但**不会自动生效于主应用**。插件方如需在系统暗色主题下自行适配，可直接依赖该媒体查询；如需关闭，可在插件根容器覆写这些变量为浅色值。主应用后续启用暗色模式时会统一在此处扩展，并新增 `[data-kwa-theme="dark"]` 显式开关。

## 9. 风险提示

- **本样式包暂不参与鉴权**：任何能加载 `kwa-plugin.css` 的页面均可读取其中的色值、变量名与类名结构。请勿在 CSS 中放置任何敏感信息（密钥、内部域名等）。
- 插件与主应用的数据交互鉴权由 `kwa-push.js` 与后端 `/api/plugin/conversations` 负责，本样式包仅负责视觉层。
- CSS 变量可被任意页面脚本读取与覆写，不要将其作为信任边界。

## 10. 变更日志

### v1.0.0（初版）

- 建立 `--kwa-*` 变量体系，覆盖强调色 / 中性色 / 语义色 / 圆角 / 阴影 / 字体 / 过渡共 25 个变量。
- 实现 `study`（墨绿 `#1a7f6e`）/ `work`（琥珀 `#b45309`）双模式强调色，通过 `[data-kwa-mode]` 切换。
- 提供 11 组组件类：`kwa-btn`（含 primary/ghost/danger）、`kwa-card`（含 accent）、`kwa-badge`（含 accent/danger/success）、`kwa-input`、`kwa-textarea`、`kwa-chip`、`kwa-list`、`kwa-divider`、`kwa-toast`（含 success/error/info）、`kwa-modal`（含 overlay/box/header/body/footer）、`kwa-spinner`。
- 预留 `prefers-color-scheme: dark` 暗色模式变量覆写（主应用暂未启用）。
