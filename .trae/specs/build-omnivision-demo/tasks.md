# Tasks

- [ ] Task 1: 创建单 HTML 文件与基础结构
  - [ ] SubTask 1.1: 新建 `index.html`，配置 viewport、引入 Tailwind CSS CDN
  - [ ] SubTask 1.2: 定义全局样式：暗色科技主题、故障艺术标题动画、毛玻璃卡片
  - [ ] SubTask 1.3: 编写页面基础结构：header、搜索区、加载层、看板区、详情抽屉

- [ ] Task 2: 准备台风巴威模拟数据
  - [ ] SubTask 2.1: 整理台风巴威的六维情报数据（定性概括、时间线、核心成就、趋势、反向视角、利益博弈）
  - [ ] SubTask 2.2: 准备 9 张相关图片 URL（使用占位图或符合规范的外部图片）
  - [ ] SubTask 2.3: 将数据组织为 JavaScript 对象，按卡片顺序分块

- [ ] Task 3: 实现搜索与模拟 SSE 流式逻辑
  - [ ] SubTask 3.1: 实现搜索框提交监听
  - [ ] SubTask 3.2: 实现模拟异步数据流函数，按 `status` → 逐卡片 `section` → `images` → `complete` 推送
  - [ ] SubTask 3.3: 将流式数据更新到全局状态并驱动 UI 重绘

- [ ] Task 4: 实现档案解封加载动画
  - [ ] SubTask 4.1: 创建全屏加载遮罩组件
  - [ ] SubTask 4.2: 实现三阶段动画：搜索中 → 找到档案 → 盖章 → 淡出
  - [ ] SubTask 4.3: 添加扫描线、终端日志、毛玻璃背景效果

- [ ] Task 5: 实现 Bento Grid 与六张核心卡片
  - [ ] SubTask 5.1: 创建响应式 Bento Grid 容器
  - [ ] SubTask 5.2: 实现定性概括卡片（标题、标签、摘要）
  - [ ] SubTask 5.3: 实现时间线卡片（节点列表、点击聚焦）
  - [ ] SubTask 5.4: 实现核心成就卡片（指标 + 说明）
  - [ ] SubTask 5.5: 实现趋势折线卡片（使用 SVG 或 Canvas 绘制折线图）
  - [ ] SubTask 5.6: 实现反向视角卡片（争议/风险列表）
  - [ ] SubTask 5.7: 实现利益博弈卡片（利益相关方与立场）
  - [ ] SubTask 5.8: 为所有卡片添加骨架屏与流式填充动画

- [ ] Task 6: 实现影像卡片与 Lightbox
  - [ ] SubTask 6.1: 创建 3×3 图片画廊组件
  - [ ] SubTask 6.2: 实现 Lightbox 全屏查看组件
  - [ ] SubTask 6.3: 在看板底部集成影像卡片

- [ ] Task 7: 实现深度探索交互
  - [ ] SubTask 7.1: 实现卡片点击展开详情抽屉
  - [ ] SubTask 7.2: 实现正面/反面/博弈视角切换按钮与高亮逻辑
  - [ ] SubTask 7.3: 实现卡片内追问输入框与模拟流式回答展示

- [ ] Task 8: 联调、验证与优化
  - [ ] SubTask 8.1: 在浏览器中打开 `index.html` 验证完整流程
  - [ ] SubTask 8.2: 验证加载动画、卡片填充、画廊、追问功能
  - [ ] SubTask 8.3: 修复 UI 细节问题，确保主流桌面分辨率下显示正常

# Task Dependencies
- Task 2 depends on Task 1
- Task 3 depends on Task 1, Task 2
- Task 4 depends on Task 3
- Task 5 depends on Task 3
- Task 6 depends on Task 3
- Task 7 depends on Task 5
- Task 8 depends on Task 4, Task 5, Task 6, Task 7
