# 磁帖拖动 + 双击拓展 改造方案

## Summary

在保持卡片视觉形态的前提下，将 Bento Grid 改造为「磁帖背板」：整体可自由拖动，放大缩小，双击任意原始卡片会基于其内容生成一张一级拓展卡片；再次双击拓展卡片时提示「Demo 模式仅支持一级拓展」。现有单击打开详情抽屉、视角切换、影像画廊、追问等功能保留。

## Current State Analysis

* 卡片位于 [index.html](file:///c:/Users/molin/Documents/trae_projects/%E5%A4%8D%E8%B5%9B%EF%BC%9F/index.html) `<main id="dashboard">` 内的 Tailwind CSS Grid（`grid-cols-3`，部分 `md:col-span-2`）。

* 六张核心卡片带 `card-clickable` 类，[index.html#L1067-L1069](file:///c:/Users/molin/Documents/trae_projects/%E5%A4%8D%E8%B5%9B%EF%BC%9F/index.html#L1067-L1069) 中单击监听 `openDrawer(card.id)`。

* 卡片有 `data-view`（front/back/game）属性，[highlightPerspective](file:///c:/Users/molin/Documents/trae_projects/%E5%A4%8D%E8%B5%9B%EF%BC%9F/index.html#L1253-L1275) 通过 `active-perspective` 类高亮。

* 模拟数据集中在 `MOCK_DATA` 对象（[L606-L657](file:///c:/Users/molin/Documents/trae_projects/%E5%A4%8D%E8%B5%9B%EF%BC%9F/index.html#L606-L657)）。

* 影像画廊是背板下方的独立 `<section id="gallery">`。

* 所有样式与脚本内联在单个 index.html。

Proposed Changes\
注意：对于磁铁的定义用户已修改”整体可自由拖动，放大缩小“，而非单个磁贴可自由拖动，请注意冲突，若有疑问可调用向用户提问的工具。
----------------------------------------------------------------

### 1. 背板容器改造

* 将 `<main id="dashboard">` 内包裹六张卡片的 `.grid` 容器替换为 `<div id="magnetBoard">` 磁帖背板：

  * `position: relative`、`overflow: hidden`、`min-height: calc(100vh - 80px)`。

  * 背景在现有暗色基础上叠加细密点阵纹理（`radial-gradient` 点阵 + 虚线网格），营造磁性白板质感。

  * 左下角添加小字标识 `MAGNETIC BOARD // DRAG · DBLCLICK TO EXTEND`。

* 影像画廊 `<section id="gallery">` 保持在背板下方，不改为磁帖（控制改造范围）。

### 2. 卡片改为绝对定位磁帖

* 六张核心卡片从 grid item 改为 `position: absolute`：

  * 初始坐标手动设定一组美观值，近似原网格布局（保证视觉迁移平滑）。

  * 卡片宽度固定（如 320px，原 col-span-2 的卡片 480px），高度自适应内容。

  * 保留 `card-clickable`、`data-view`、`glass-card` 等类与样式。

  * 新增 `data-card-id`、`data-level="0"`（0=原始，1=拓展）属性。

* 卡片样式补充：

  * 微弱投影增强磁帖悬浮感。

  * 拓展卡片（level=1）：虚线边框 + 右上角「拓展」角标，颜色随源卡片。

### 3. 拖拽交互（pointer events + 阈值区分点击）

* 为每张卡片绑定 `pointerdown` / `pointermove` / `pointerup`：

  * 记录起始坐标，设置 **5px 拖拽阈值**：

    * 未超过阈值即释放 → 触发原 `click` 行为（打开详情抽屉）。

    * 超过阈值 → 进入拖拽态。

  * 拖拽态：

    * 提升 `z-index` 至 50。

    * 添加 `dragging` 类（轻微缩放 1.02 + 阴影增强 + 光标 grabbing）。

    * 通过 `transform: translate(dx, dy)` 实时更新位置。

  * 释放：

    * 将 translate 累加到 `left/top`，重置 transform。

    * 约束在背板边界内（`clamp` 到 `0 ~ boardWidth - cardWidth`）。

    * 若为误触（未超过阈值），不阻止 click。

* 现有 `card-clickable` 的 click 监听保留，但改为在 pointerup 未拖拽时手动派发，避免双击冲突。

### 4. 双击拓展

* 为卡片绑定 `dblclick`：

  * 读取 `data-level`：

    * **level=0**：在源卡片右侧偏移 40px 位置生成一张拓展卡片：

      * 复用 `glass-card` 样式 + 拓展角标。

      * 内容取自新增的 `MOCK_EXTENSION[cardId]`（预定义补充情报，见下）。

      * 标记 `data-level="1"`、`data-source="<源卡片id>"`。

      * 绑定同样的拖拽 + 双击逻辑。

      * 出现动画：`fade-in-up` + 轻微弹出。

    * **level=1**：调用 `showToast('Demo 模式仅支持一级拓展')`，不再生成。

* 拓展卡片不参与视角切换高亮（仅原始卡片参与）。

### 5. 拓展内容数据 `MOCK_EXTENSION`

新增 JavaScript 对象，每张原始卡片对应一段补充情报：

* `summary`：巴威的气候学意义 + 与 2012 年「布拉万」等历史北上台风对比。

* `timeline`：每个关键节点的社会/经济后续影响（如登陆后朝鲜灾情、东北停课天数）。

* `metrics`：与同年其他超强台风（如海高斯）的核心数据对比表。

* `chart`：中心气压变化趋势补充 + 海温异常分析。

* `counter`：针对每条争议点的官方/学界回应。

* `game`：博弈后续演变（灾后理赔、应急预案修订、媒体复盘）。

### 6. Toast 提示组件

* 新增 `showToast(msg)` 函数：

  * 创建固定在顶部居中的 toast 元素，3 秒后淡出移除。

  * 样式：毛玻璃背景 + 青色边框 + 白色文字。

### 7. 视觉与细节

* 背板点阵纹理：`background-image: radial-gradient(rgba(0,240,255,0.08) 1px, transparent 1px); background-size: 24px 24px;`

* 卡片拖拽时轻微倾斜（`rotate(1deg)`）增强磁帖手感。

* 拓展卡片生成时与源卡片之间可绘制一条虚线连接（SVG 或 CSS 伪元素），提示"派生自"。

## Assumptions & Decisions

* **单击 vs 拖拽**：用 5px 阈值区分；未拖拽时保留原 click → 打开详情抽屉。

* **背板范围**：视口大小，卡片约束在背板内（不做无限画布平移，控制 Demo 复杂度）。

* **拓展层级**：仅一级；双击拓展卡片提示 toast。

* **影像画廊**：保留在背板下方原位，不改为磁帖。

* **初始位置**：手动设定一组美观坐标，近似原网格布局，保证加载后视觉平滑。

* **视角切换**：仅高亮原始卡片，拓展卡片不参与。

## Verification

1. 打开 `index.html`，搜索「台风巴威」，等待卡片加载完成。
2. 六张卡片以磁帖形式排列在背板上，背板有点阵纹理。
3. 拖动任意卡片到新位置 → 松开后停留；拖动过程中卡片有缩放/阴影反馈。
4. 单击卡片 → 详情抽屉正常打开（未被拖拽误触发）。
5. 双击原始卡片 → 右侧出现拓展卡片，带「拓展」角标。
6. 双击拓展卡片 → 顶部出现 toast「Demo 模式仅支持一级拓展」。
7. 拖动拓展卡片 → 可独立移动。
8. 视角切换（正面/反面/博弈）仍能高亮对应原始卡片。
9. 控制台无报错（`window.__omnivisionErrors` 为空）。
10. 主流桌面分辨率下无明显错位。

