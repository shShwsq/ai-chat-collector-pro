# Tasks

- [x] Task 1: 修复设置面板空白 bug
  - [ ] SubTask 1.1: 复现并定位根因——检查 `SettingsPanel.tsx` 渲染链路、`useAppStore.setActiveNav('settings')` 触发的 `loadLlmConfig`/`loadLlmRequests` 是否抛错被吞、`content-area--settings` 容器高度是否为 0、轮询定时器是否在面板未挂载时异常累积
  - [ ] SubTask 1.2: 修复根因（确保即使后端 `/api/llm/config` 或 `/api/llm/requests` 失败，UI 也显示明确错误提示而非空白；轮询定时器仅在组件挂载时运行；容器高度正确撑开）
  - [ ] SubTask 1.3: 验证点击设置图标后 API 配置区与请求队列区均可见，刷新/重新进入稳定显示

- [x] Task 2: 修复新建图谱输入框偶尔无法输入 bug
  - [ ] SubTask 2.1: 定位根因——`GraphList.tsx` 中 `creating` 态切换是否导致 input 重挂载、`useEffect` 焦点逻辑是否与列表刷新冲突、`newNameRef` 是否被覆盖
  - [ ] SubTask 2.2: 修复根因（确保 input 在 `creating=true` 期间稳定挂载、焦点不因列表数据刷新而丢失；可考虑用 `autoFocus` 替代手动 focus 或加 key 稳定化）
  - [ ] SubTask 2.3: 连续创建 5+ 次图谱，每次均能正常输入名字并提交

- [x] Task 3: SideNav 重构——设置下沉到底部
  - [ ] SubTask 3.1: 修改 `SideNav.tsx`：主导航只含 chat/graph，settings 单独渲染并用 `margin-top:auto` 推到底部，加 `side-nav__divider` 分隔线
  - [ ] SubTask 3.2: 新增「对话」图标红点角标 slot（供 Task 8 提醒通知写入），默认不显示
  - [ ] SubTask 3.3: 调整 `app.css` 中 `.side-nav__items` 为 `flex-direction:column; flex:1`，`.side-nav__bottom` 用 `margin-top:auto`；分隔线样式
  - [ ] SubTask 3.4: 验证点击 chat/graph/settings 均能正确切换 activeNav，settings 视觉上与主导航分隔

- [x] Task 4: 后端数据模型扩展与迁移
  - [ ] SubTask 4.1: 在 `db_models.py` 的 Node 模型新增 `last_reviewed_at`（DateTime nullable）、`review_count`（Int default 0）、`mention_count`（Int default 0）、`remind_at`（DateTime nullable）、`is_starred`（Boolean default False）
  - [ ] SubTask 4.2: 在 `graph_store.py` 的节点序列化/反序列化中包含新字段；旧数据读取时缺失字段取默认值
  - [ ] SubTask 4.3: 提供自动迁移逻辑（启动时检查列是否存在，缺失则 ALTER TABLE ADD COLUMN，复用步影/现有 migration 思路）；验证旧库启动不报错
  - [ ] SubTask 4.4: 前端 `types.ts` 的 `Node` 类型同步新增字段（可选字段，避免破坏旧代码）

- [x] Task 5: 后端推荐接口
  - [ ] SubTask 5.1: 新建 `backend/app/routers/recommendations.py`，实现 `GET /api/graphs/{gid}/recommendations?mode=study|work&limit=20`
  - [ ] SubTask 5.2: 学习推荐分算法：遗忘分（基于 `last_reviewed_at` 距今天数 + `review_count` 衰减）+ 热度分（`mention_count` 低且久未复习提分）+ 错误率分（Quiz 表统计该节点题目错误率）；综合归一化到 0-100
  - [ ] SubTask 5.3: 工作推荐分算法：到期（remind_at <= now）置顶标红 → 24h 内临近 → 星标 → 类型权重（承诺/风险优先）；每项附推荐理由字符串
  - [ ] SubTask 5.4: 在 `main.py` 注册 recommendations router；用 curl/手动测试两种 mode 返回结构正确

- [x] Task 6: 后端节点行为接口
  - [ ] SubTask 6.1: 在 `graph_store.py` 新增 `touch_node(node_id)`（更新 last_reviewed_at=now, review_count+=1）、`set_remind(node_id, dt)`、`clear_remind(node_id)`、`set_star(node_id, bool)`、`incr_mention(node_id)`
  - [ ] SubTask 6.2: 新增 router 端点：`POST /api/nodes/{id}/touch`、`POST /api/nodes/{id}/remind`（body: {remind_at}）、`DELETE /api/nodes/{id}/remind`、`POST /api/nodes/{id}/star`、`DELETE /api/nodes/{id}/star`
  - [ ] SubTask 6.3: 在 Agent 抽取/延伸/提问命中节点处调用 `incr_mention`（修改 `graph_agent.py` / `main_agent.py` 相关分支）
  - [ ] SubTask 6.4: 验证端点返回更新后的节点快照，前端可据此同步 store

- [x] Task 7: 前端 API 与 store 扩展
  - [ ] SubTask 7.1: `api.ts` 新增 `getRecommendations(gid, mode, limit)`、`touchNode(id)`、`setRemind(id, dt)`、`clearRemind(id)`、`setStar(id, bool)`
  - [ ] SubTask 7.2: `useAppStore.ts` 新增状态：`recommendations`、`recommendationsLoading`、`recommendationsMode`、`reminderCount`（到期数）；动作：`loadRecommendations(mode)`、`touchNode(id)`、`setRemind(id, dt)`、`clearRemind(id)`、`toggleStar(id)`、`loadReminderCount()`
  - [ ] SubTask 7.3: `setActiveNav('chat')` 时懒加载推荐列表；`setActiveNav('graph')` 时不清空（便于切回快速显示）
  - [ ] SubTask 7.4: 推荐列表与图谱节点变更后自动刷新（新增/删除节点/作答测验后调 `loadRecommendations`）

- [x] Task 8: ChatHome 瀑布流首页组件
  - [ ] SubTask 8.1: 新建 `components/ChatHome.tsx`：顶部居中输入框 + 下方瀑布流容器；mode 感知占位文案与卡片样式
  - [ ] SubTask 8.2: 新建 `components/RecommendationCard.tsx`：展示节点标题、类型标签、推荐理由、上次复习时间（study）/提醒时间（work）、错误率徽标（study）、星标/提醒按钮（work）
  - [ ] SubTask 8.3: 瀑布流用 CSS columns 或 grid masonry 实现，响应式 2-3 列；卡片点击跳转到图谱视图并选中该节点
  - [ ] SubTask 8.4: 新建 `components/ReminderBanner.tsx`：当 `reminderCount > 0` 时在首页顶部显示「N 项提醒已到期」横幅，点击滚动到第一张到期卡片
  - [ ] SubTask 8.5: SideNav「对话」图标红点角标：当 `reminderCount > 0` 时显示数字角标

- [x] Task 9: ChatPanel 重构
  - [ ] SubTask 9.1: `ChatPanel.tsx` Study 模式分支改为渲染 `<ChatHome mode="study" />`，移除原引导提示卡
  - [ ] SubTask 9.2: Work 模式：当 `qaMessages.length === 0` 时渲染 `<ChatHome mode="work" />`；有消息时渲染对话视图（保留顶部输入框 + 消息列表 + 「返回首页」按钮）
  - [ ] SubTask 9.3: Work 模式输入框提问逻辑保留（调用 `askWorkQuestion`）；Study 模式输入框暂作搜索入口（输入后过滤瀑布流或跳转图谱视图搜索，本次先实现过滤）
  - [ ] SubTask 9.4: 验证两种模式切换、首页 ↔ 对话视图切换流畅

- [x] Task 10: NodeDetailCard 新增提醒/星标/touch
  - [ ] SubTask 10.1: 详情卡挂载且 `pinned=true` 时调用 `store.touchNode(node.id)`（仅固定态触发，避免悬停频繁调用）
  - [ ] SubTask 10.2: Work 节点详情卡新增「提醒我」按钮：点击弹出 `<input type="datetime-local">`，确认后调 `store.setRemind`；已设置时显示提醒时间 + 「清除」按钮
  - [ ] SubTask 10.3: 所有节点详情卡新增「星标」按钮：点击切换 `store.toggleStar`，星标态高亮
  - [ ] SubTask 10.4: 验证 touch 不重复触发（同一节点同一固定态只 touch 一次）

- [x] Task 11: 联调验证与 UI 细节
  - [ ] SubTask 11.1: 端到端验证 Study 流程：打开对话首页 → 瀑布流显示推荐 → 点击卡片跳转图谱 → 打开详情卡触发 touch → 返回首页推荐顺序更新
  - [ ] SubTask 11.2: 端到端验证 Work 流程：首页显示工作推荐 → 设置提醒 → 到期后红点角标 + 横幅 → 点击横幅定位卡片 → 星标后排序提前
  - [ ] SubTask 11.3: 验证设置下沉、设置面板不空白、新建图谱输入稳定
  - [ ] SubTask 11.4: UI 细节打磨：卡片间距/阴影/悬停态、输入框聚焦态、红点角标位置、横幅配色

# Task Dependencies
- Task 4 depends on Task 1, Task 2（先修 bug 再扩模型，避免在 bug 环境下调试新功能）
- Task 5 depends on Task 4（推荐分依赖新字段）
- Task 6 depends on Task 4
- Task 7 depends on Task 5, Task 6
- Task 8 depends on Task 7
- Task 9 depends on Task 8
- Task 10 depends on Task 7
- Task 11 depends on Task 3, Task 9, Task 10
- Task 3 可与 Task 4 并行（前后端不同文件）
