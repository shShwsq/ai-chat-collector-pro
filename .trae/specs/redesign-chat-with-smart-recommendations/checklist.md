# 验收清单

## Bug 修复
- [x] 点击 SideNav 设置图标后，SettingsPanel 正常显示 API 配置区 + 请求队列区，不出现空白
- [x] 后端 `/api/llm/config` 或 `/api/llm/requests` 失败时，UI 显示明确错误提示而非空白
- [x] 连续新建 5+ 次图谱，每次输入框都能稳定获取焦点并接收输入
- [x] 列表刷新/重渲染不会导致新建输入框失焦

## 设置下沉
- [x] SideNav 顶部主导航只显示「对话」「图谱」两项
- [x] 设置图标通过分隔线 + 顶部留白固定在 SideNav 最底部
- [x] 点击设置仍正确切换到 SettingsPanel
- [x] SideNav「对话」图标右上角在 `reminderCount > 0` 时显示红点数字角标

## 对话页瀑布流首页
- [x] Study 模式点击「对话」显示居中输入框 + 下方瀑布流推荐卡片
- [x] Study 输入框占位为「输入要复习/搜索的知识点」
- [x] Work 模式无对话消息时显示居中输入框 + 瀑布流工作推荐卡片
- [x] Work 输入框占位为「输入工作提问」
- [x] Work 模式发送第一条提问后切换为对话视图，含「返回首页」按钮
- [x] 瀑布流响应式 2-3 列，卡片点击跳转图谱视图并选中该节点

## 学习推荐分
- [x] `GET /api/graphs/{gid}/recommendations?mode=study` 返回按综合分排序的节点列表
- [x] 每项含推荐理由（遗忘/热度/错误率 哪项贡献最大）
- [x] 卡片显示节点标题、推荐理由、上次复习时间、错误率徽标
- [x] 打开详情卡触发 touch 后，返回首页该节点推荐分下降（已复习）

## 工作推荐分
- [x] `GET /api/graphs/{gid}/recommendations?mode=work` 返回按提醒时间+星标+类型排序的列表
- [x] 已到期 `remind_at` 置顶并标红
- [x] 24h 内临近卡片次之
- [x] 星标节点适度提前

## 节点提醒
- [x] Work 节点详情卡含「提醒我」按钮，点击弹出 datetime 选择器
- [x] 设置提醒后卡片显示提醒时间徽标
- [x] 提醒到期后 SideNav「对话」图标显示红点角标（数字=到期数）
- [x] 对话页顶部显示「N 项提醒已到期」横幅，点击滚动到对应卡片
- [x] 「清除提醒」按钮可清除 `remind_at`

## 节点星标
- [x] 节点详情卡含「星标」按钮，点击切换星标态
- [x] 星标态卡片显示星标图标
- [x] 星标节点在推荐排序中适度提前

## 学习行为追踪
- [x] 打开节点详情卡（固定态）触发 `POST /api/nodes/{id}/touch`
- [x] touch 后 `last_reviewed_at` 更新为 now，`review_count` +1
- [x] 同一节点同一固定态只 touch 一次，不重复
- [x] Agent 抽取/延伸/提问命中节点时 `mention_count` +1

## 数据模型扩展
- [x] Node 表含 `last_reviewed_at`、`review_count`、`mention_count`、`remind_at`、`is_starred` 五个新字段
- [x] 旧库启动时自动 ALTER TABLE ADD COLUMN，不报错
- [x] 旧数据新字段取默认值（null / 0 / false）
- [x] 前端 `types.ts` 的 `Node` 类型同步新增字段

## 端到端
- [x] Study 全流程：对话首页 → 瀑布流推荐 → 点击卡片跳图谱 → 详情卡 touch → 返回首页顺序更新
- [x] Work 全流程：首页工作推荐 → 设置提醒 → 到期红点+横幅 → 星标排序提前 → 提问切对话视图
- [x] 设置下沉 + 设置面板不空白 + 新建图谱输入稳定，三项均验证通过
