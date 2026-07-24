# 全知视野 OmniVision Demo 规格说明

## Why
基于 TRAE AI 创造力大赛作品「全知视野」的设计思路，制作一个单 HTML 文件的前端 Demo。用户打开页面后搜索「台风巴威」，系统以结构化卡片 + 流式动画的形式，在数秒内呈现关于台风巴威的多维情报看板，无需后端与真实 API。

## What Changes
- 新建一个独立的 `index.html` 文件，内置所有 HTML、CSS、JavaScript 与模拟数据。
- 不接入任何真实 API，所有情报数据硬编码为台风巴威主题。
- 实现搜索页、档案解封加载动画、Bento Grid 情报看板。
- 实现六张核心情报卡片：定性概括、时间线、核心成就、趋势折线、反向视角、利益博弈。
- 实现影像卡片（图片画廊 + Lightbox）。
- 实现卡片展开、视角切换、基于卡片上下文的模拟追问回答交互。

## Impact
- 新增能力：全景情报看板、流式生成体验、结构化信息可视化、多视角探索。
- 新增代码：单个 HTML 文件，包含样式、脚本与模拟数据。

## ADDED Requirements

### Requirement: 单文件 Demo
The system SHALL be delivered as a single `index.html` file that runs entirely in the browser.

#### Scenario: 直接打开
- **WHEN** 用户在浏览器中打开 `index.html`
- **THEN** 页面无需构建、无需安装依赖、无需网络 API 即可正常显示与交互

### Requirement: 模拟情报生成
The system SHALL stream pre-defined intelligence data for the topic "台风巴威" after the user submits the query.

#### Scenario: 用户提交查询
- **WHEN** 用户在搜索框输入任意内容（默认/建议为「台风巴威」）并提交
- **THEN** 前端模拟 SSE 流式过程：按 `status` → `sections`（逐卡片）→ `images` → `complete` 顺序填充看板

### Requirement: 档案解封加载动画
The system SHALL display a full-screen loading sequence after query submission.

#### Scenario: 搜索进行中
- **WHEN** 用户点击搜索
- **THEN** 全屏遮罩显示「搜索中 → 找到档案 → 盖章 → 淡出」三阶段动画，包含扫描线、终端日志、毛玻璃效果

### Requirement: Bento Grid 情报看板
The system SHALL render a responsive Bento Grid layout containing six core cards.

#### Scenario: 卡片展示
- **WHEN** 模拟数据流式到达
- **THEN** 六张卡片按既定网格占位，逐张填充内容并显示骨架屏到内容的过渡

### Requirement: 核心情报卡片
The system SHALL provide six structured intelligence cards about 台风巴威.

#### Scenario: 定性概括
- **WHEN** 数据到达
- **THEN** 显示台风巴威的一句话定义、关键标签、背景摘要

#### Scenario: 时间线
- **WHEN** 数据到达
- **THEN** 显示 5-8 个关键事件节点，支持点击节点聚焦

#### Scenario: 核心成就
- **WHEN** 数据到达
- **THEN** 以数据指标 + 简短说明的形式列出 4-6 项台风关键数据（如风速、气压、影响范围）

#### Scenario: 趋势折线
- **WHEN** 数据到达
- **THEN** 使用折线图展示台风强度或路径关注度随时间变化趋势

#### Scenario: 反向视角
- **WHEN** 数据到达
- **THEN** 列出关于台风预报、防灾响应、媒体报道等方面的争议点或反面观点

#### Scenario: 利益博弈
- **WHEN** 数据到达
- **THEN** 列出气象部门、地方政府、媒体、公众等主要相关方及其立场/诉求

### Requirement: 影像卡片
The system SHALL display a gallery of related images when available.

#### Scenario: 图片展示
- **WHEN** 模拟图片数据到达
- **THEN** 在看板底部渲染 3×3 网格画廊，点击图片可全屏 Lightbox 查看

### Requirement: 深度探索交互
The system SHALL support interactive exploration of the generated intelligence.

#### Scenario: 卡片展开
- **WHEN** 用户点击卡片
- **THEN** 卡片展开为详情视图，显示更完整的内容

#### Scenario: 视角切换
- **WHEN** 用户在正面/反面/博弈视角间切换
- **THEN** 相关卡片高亮或重新组合展示

#### Scenario: 卡片追问
- **WHEN** 用户在卡片详情中输入追问
- **THEN** 系统基于卡片上下文模拟流式返回答案

### Requirement: 视觉风格
The system SHALL present a dark, cyber-intelligence visual style.

#### Scenario: 首页与标题
- **WHEN** 用户进入首页
- **THEN** 看到故障艺术风格的「全知视野」标题、居中搜索框、暗色科技背景

## MODIFIED Requirements
无

## REMOVED Requirements
- 原 Task 1 中 Express + TypeScript 后端、npm 工程化、Tavily/DeepSeek API 接入等内容不再适用，已移除。
