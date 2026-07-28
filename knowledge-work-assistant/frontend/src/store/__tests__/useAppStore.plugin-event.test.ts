/**
 * @file useAppStore.plugin-event.test.ts
 * @description 前端 store 事件处理单元测试（Task 15）。
 *
 * 覆盖 5 个用例：
 *   1. test_handlePluginConversationReceived_toast
 *      - 收到插件对话事件后弹 Toast（文案含 title）
 *   2. test_handlePluginConversationReceived_refresh_pending_nodes
 *      - study 模式图谱视图下，事件触发 loadPendingObservations
 *   3. test_chat_token_event
 *      - chat token 事件累加 chatStreamingText + 更新最后一条 assistant 消息
 *   4. test_chat_tool_call_event
 *      - chat 工具调用事件追加 tool_calls
 *   5. test_chat_tool_confirmation_event
 *      - 工具确认事件设置 pendingToolConfirmation
 *      - confirmToolCall 调 API（approved=true）+ 清空
 *      - rejectToolCall 调 API（approved=false + reason）+ 清空
 *
 * 测试隔离：
 *   - mock ../../lib/api 模块（store 的 handlePluginConversationReceived /
 *     confirmToolCall / rejectToolCall 等会通过 api 调后端），不发真实网络请求
 *   - store 本身不直接 import ws.ts，事件处理函数由 App.tsx 订阅 WS 后调用，
 *     测试中直接调用 store 的 handle* 方法模拟 WS 事件到达，无需 mock WebSocket
 *   - 使用真实的 useAppStore（不 mock store 本身），通过 getState/setState 直接操作
 *   - beforeEach 用 setState({...initial}, true) 重置 store 到初始状态（浅拷贝避免
 *     污染原始 initial 快照），并 clearAllMocks 清空调用记录
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// mock api 模块：store 的 handlePluginConversationReceived / confirmToolCall /
// rejectToolCall 等会通过 api 调后端，测试中替换为 vi.fn 避免真实网络请求。
// 导出 ApiError 类以兼容 store 的 errMsg(e) instanceof ApiError 检查。
// 注意：mock 工厂中创建的 vi.fn() 不能预置 mockResolvedValue（会被 clearAllMocks
// 在某些 vitest 版本中清掉），改为在 beforeEach 中显式重设 mock 实现。
vi.mock('../../lib/api', () => ({
  api: {
    listObservations: vi.fn(),
    confirmChatToolCall: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    readonly code: string
    readonly status: number
    readonly detail?: string
    constructor(
      message: string,
      code = 'API_ERROR',
      status = 500,
      detail?: string,
    ) {
      super(message)
      this.name = 'ApiError'
      this.code = code
      this.status = status
      this.detail = detail
    }
  },
}))

import { useAppStore } from '../useAppStore'
import { api } from '../../lib/api'
import type { ChatMessage } from '../../lib/types'

// 把 api mock 强制断言为 vi.fn 实例，便于 beforeEach 中重设实现
const listObservationsMock = api.listObservations as ReturnType<typeof vi.fn>
const confirmChatToolCallMock = api.confirmChatToolCall as ReturnType<
  typeof vi.fn
>

// 捕获 store 初始状态快照，用于每个 test 前 reset（保留 actions 引用不变）。
// 注意：用浅拷贝 {...initial} 重置，避免 vi.spyOn 修改的方法污染原始快照。
const initialStoreState = useAppStore.getState()

/** 构造一条最小可用的 assistant 占位消息（用于 chat 事件测试预设）。 */
function makeAssistantPlaceholder(
  content = '',
  toolCalls: ChatMessage['tool_calls'] = [],
): ChatMessage {
  return {
    id: 'local-assistant-test',
    session_id: 'sess-test',
    role: 'assistant',
    content,
    attachments: [],
    created_at: '2026-07-26T10:00:00.000Z',
    tool_calls: toolCalls,
  }
}

/** 刷新微任务队列，让 fire-and-forget 的 void Promise 跑完。 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('useAppStore plugin/chat 事件处理', () => {
  beforeEach(() => {
    // 重置 store 状态到初始值（replace=true 完全覆盖；浅拷贝保护原始快照）
    useAppStore.setState({ ...initialStoreState }, true)
    // 清空 mock 调用记录（部分 vitest 版本会顺带清掉 mockResolvedValue，
    // 故下方显式重设实现）
    vi.clearAllMocks()
    // 显式重设 mock 返回值，确保每个 test 都有可用的 mock 实现
    listObservationsMock.mockResolvedValue([])
    confirmChatToolCallMock.mockResolvedValue({
      ok: true,
      request_id: 'r1',
      approved: true,
    })
  })

  afterEach(() => {
    // 还原 vi.spyOn 修改的方法
    vi.restoreAllMocks()
  })

  // ----------------------------------------------------------------------

  it('test_handlePluginConversationReceived_toast', async () => {
    // 默认 store 状态：activeNav='graph' + mode='study'，会触发 loadPendingObservations
    // （mock api.listObservations 返回 []，无副作用）
    const store = useAppStore.getState()
    store.handlePluginConversationReceived({
      observation_id: 'obs1',
      platform: 'deepseek',
      title: '测试对话',
      timestamp: '2026-07-26T10:00:00Z',
    })

    // 验证 Toast 文案含 title，类型为 info
    const toast = useAppStore.getState().toast
    expect(toast).not.toBeNull()
    expect(toast?.message).toBe('收到新对话：测试对话')
    expect(toast?.type).toBe('info')

    // 等待 fire-and-forget 的 loadPendingObservations 跑完，避免未捕获 Promise
    await flushMicrotasks()
  })

  // ----------------------------------------------------------------------

  it('test_handlePluginConversationReceived_refresh_pending_nodes', async () => {
    // 设置 store 处于 study 模式图谱视图（默认即为此状态，显式设置以表明意图）
    useAppStore.setState({ activeNav: 'graph', mode: 'study' })

    // 用 vi.spyOn 监视 loadPendingObservations 是否被调用
    const spy = vi.spyOn(
      useAppStore.getState(),
      'loadPendingObservations',
    )

    // 调用插件对话接收事件
    useAppStore.getState().handlePluginConversationReceived({
      observation_id: 'obs1',
      platform: 'deepseek',
      title: '测试对话',
      timestamp: '2026-07-26T10:00:00Z',
    })

    // loadPendingObservations 是 async + void 调用，需 flush 微任务让 Promise 跑完
    await flushMicrotasks()

    // 验证 loadPendingObservations 被调用 1 次
    expect(spy).toHaveBeenCalledTimes(1)
    // 顺便验证：study + graph 视图下，loadPendingObservations 调 api.listObservations
    // （mock 返回 []，pendingObservations 被设为空数组）
    expect(api.listObservations).toHaveBeenCalledWith({
      processed: false,
      limit: 100,
    })
    expect(useAppStore.getState().pendingObservations).toEqual([])
  })

  // ----------------------------------------------------------------------

  it('test_chat_token_event', () => {
    // 预设 chatMessages 为一条空 content 的 assistant 占位消息
    useAppStore.setState({
      chatMessages: [makeAssistantPlaceholder('')],
      chatStreamingText: '',
    })

    // 调用 handleChatToken（模拟 WS 推送 op="chat" 的 token 事件）
    useAppStore.getState().handleChatToken({
      type: 'graph_agent_token',
      op: 'chat',
      session_id: 'sess-test',
      request_id: 'r1',
      content: '你好',
      seq: 0,
    })

    const state = useAppStore.getState()
    // 验证 chatStreamingText 累加为 '你好'
    expect(state.chatStreamingText).toBe('你好')
    // 验证最后一条 assistant 消息 content 更新为 '你好'（打字机效果）
    const last = state.chatMessages[state.chatMessages.length - 1]
    expect(last.role).toBe('assistant')
    expect(last.content).toBe('你好')
  })

  // ----------------------------------------------------------------------

  it('test_chat_tool_call_event', () => {
    // 预设 chatMessages 为一条空 assistant 消息（含空 tool_calls 数组）
    useAppStore.setState({
      chatMessages: [makeAssistantPlaceholder('', [])],
    })

    // 调用 handleChatToolCall（模拟 WS 推送 chat_tool_call 事件）
    useAppStore.getState().handleChatToolCall({
      type: 'chat_tool_call',
      op: 'chat',
      session_id: 'sess-test',
      request_id: 'r1',
      tool: 'graph_query_nodes',
      args: { keyword: 'X' },
      tool_call_id: 'tc-1',
    })

    const state = useAppStore.getState()
    const last = state.chatMessages[state.chatMessages.length - 1]
    expect(last.role).toBe('assistant')
    // 验证 tool_calls 追加了一条 pending 项
    expect(last.tool_calls).toHaveLength(1)
    expect(last.tool_calls?.[0]).toMatchObject({
      tool: 'graph_query_nodes',
      args: { keyword: 'X' },
      status: 'pending',
    })
  })

  // ----------------------------------------------------------------------

  it('test_chat_tool_confirmation_event', async () => {
    // === 步骤 1：调用 handleChatToolConfirmation 设置 pendingToolConfirmation ===
    useAppStore.getState().handleChatToolConfirmation({
      type: 'chat_tool_call_confirmation',
      op: 'chat',
      tool: 'graph_extract_from_observation',
      args: { observation_id: 'o1', graph_type: 'study' },
      request_id: 'r1',
      timeout: 60,
    })

    // 验证 pendingToolConfirmation 被设置（含 request_id / tool / args / timeout）
    const pending = useAppStore.getState().pendingToolConfirmation
    expect(pending).not.toBeNull()
    expect(pending).toMatchObject({
      request_id: 'r1',
      tool: 'graph_extract_from_observation',
      args: { observation_id: 'o1', graph_type: 'study' },
      timeout: 60,
    })

    // === 步骤 2：调用 confirmToolCall → 验证调 API + 清空 ===
    const confirmResult = await useAppStore.getState().confirmToolCall()
    expect(confirmResult).toBe(true)
    // 验证 confirmChatToolCall API 被调用，approved=true
    expect(api.confirmChatToolCall).toHaveBeenCalledWith('r1', {
      approved: true,
    })
    // 验证 pendingToolConfirmation 被清空
    expect(useAppStore.getState().pendingToolConfirmation).toBeNull()

    // === 步骤 3：重新触发 confirmation 事件（为 rejectToolCall 测试准备）===
    useAppStore.getState().handleChatToolConfirmation({
      type: 'chat_tool_call_confirmation',
      op: 'chat',
      tool: 'graph_extract_from_observation',
      args: { observation_id: 'o1', graph_type: 'study' },
      request_id: 'r1',
      timeout: 60,
    })
    expect(useAppStore.getState().pendingToolConfirmation).not.toBeNull()

    // === 步骤 4：调用 rejectToolCall('用户拒绝') → 验证调 API + 清空 ===
    const rejectResult =
      await useAppStore.getState().rejectToolCall('用户拒绝')
    expect(rejectResult).toBe(true)
    // 验证 confirmChatToolCall API 被调用，approved=false + reason
    expect(api.confirmChatToolCall).toHaveBeenCalledWith('r1', {
      approved: false,
      reason: '用户拒绝',
    })
    // 验证 pendingToolConfirmation 被清空
    expect(useAppStore.getState().pendingToolConfirmation).toBeNull()
  })
})
