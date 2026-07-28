/**
 * @file kwa-push.test.ts
 * @description 前端 SDK（plugin-sdk/kwa-push.js）单元测试。
 *
 * 覆盖 5 个用例：
 *   1. test_pushConversation_success            - 成功推送 + 请求体契约
 *   2. test_pushConversation_retry              - 失败重试 + 指数退避时长
 *   3. test_pushConversation_dedup             - 透传 deduplicated 字段
 *   4. test_pushConversation_all_retry_failed   - 重试耗尽抛错
 *   5. test_pushConversation_missing_required_field - 客户端校验失败
 *
 * 测试隔离：
 *   - mock global.fetch，不发真实网络请求
 *   - 每个 test 用 beforeEach/afterEach 重置 mock 与 SDK 全局配置
 *   - 重试用 vi.useFakeTimers + vi.advanceTimersByTimeAsync 精确推进退避时长
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// kwa-push.js 是 UMD/CJS 模块且无类型声明，TS 静态检查会报「找不到模块」，
// 用 @ts-ignore 抑制；运行时由 vite/esbuild 做 CJS interop，default 导出 = module.exports
// @ts-ignore
import KwaPush from '../../../../plugin-sdk/kwa-push.js';

// 被测 SDK 暴露的 API（factory 返回对象）
const { pushConversation, configure } = KwaPush as {
  pushConversation: (options: PushOptions, config?: PushConfig) => Promise<PushResult>;
  configure: (options: Partial<PushConfig>) => void;
};

// ===== 局部类型（仅用于测试，避免依赖 SDK 内部类型）=====

interface PushOptions {
  platform: string;
  timestamp: string;
  conversationMarkdown: string;
  metadata?: Record<string, unknown> | null;
}

interface PushConfig {
  // webhookUrl 仅通过 configure() 全局设置，pushConversation 调用时通常只覆写
  // timeout/maxRetries/retryDelayMs/signal，故此处标记为可选以反映实际用法。
  webhookUrl?: string;
  timeout: number;
  maxRetries: number;
  retryDelayMs: number;
  signal?: AbortSignal | null;
}

interface PushResult {
  received: boolean;
  deduplicated: boolean;
  observation_id: string;
}

// ===== 辅助函数 =====

/**
 * 构造 mock fetch 返回的 Response 对象（最小子集：ok / status / text()）。
 * kwa-push.js 的 doFetchOnce 只用到这三个字段。
 */
function makeResponse(status: number, body: unknown) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(text),
  };
}

/** SDK 默认 webhook 端点（用于断言请求 URL）。 */
const DEFAULT_WEBHOOK_URL = 'http://127.0.0.1:8788/api/plugin/conversations';

/** 测试用基础推送参数（每个测试可覆写部分字段）。 */
const BASE_OPTIONS: PushOptions = {
  platform: 'deepseek',
  timestamp: '2026-07-26T10:00:00Z',
  conversationMarkdown: '# 对话',
  metadata: { conversation_id: 'c1', title: '测试', url: 'http://x' },
};

// ===== 测试套件 =====

describe('kwa-push.js SDK', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // 每次 test 重建 fetch mock，避免跨用例污染
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    // 重置 SDK 全局默认配置，避免某个 test 改了 maxRetries/retryDelayMs 影响下一个
    configure({
      webhookUrl: DEFAULT_WEBHOOK_URL,
      timeout: 10000,
      maxRetries: 3,
      retryDelayMs: 500,
    });
  });

  // ------------------------------------------------------------------------

  it('test_pushConversation_success', async () => {
    // mock 后端返回 200 + 成功 body
    fetchMock.mockResolvedValue(
      makeResponse(200, { received: true, observation_id: 'abc' })
    );

    const result = await pushConversation({ ...BASE_OPTIONS });

    // 1. fetch 仅调用一次
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 2. 验证请求 URL / method / headers
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(DEFAULT_WEBHOOK_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });

    // 3. 验证请求体：camelCase → snake_case 转换正确
    const body = JSON.parse(init.body as string);
    expect(body.platform).toBe('deepseek');
    expect(body.timestamp).toBe('2026-07-26T10:00:00Z');
    expect(body.conversation_markdown).toBe('# 对话');
    expect(body.metadata).toEqual({
      conversation_id: 'c1',
      title: '测试',
      url: 'http://x',
    });

    // 4. 验证返回值：received / observation_id 正确，deduplicated 缺省为 false
    expect(result).toEqual({
      received: true,
      deduplicated: false,
      observation_id: 'abc',
    });
  });

  // ------------------------------------------------------------------------

  it('test_pushConversation_retry', async () => {
    // 用 fake timers 接管 setTimeout（kwa-push 的 sleep 与 timeout abort 都用它）
    vi.useFakeTimers();

    // 前 3 次失败（attempt 0/1/2），第 4 次（attempt 3 = maxRetries）成功
    // 退避序列预期：500ms(attempt=0) / 1000ms(attempt=1) / 2000ms(attempt=2)
    fetchMock
      .mockRejectedValueOnce(new Error('network error 1'))
      .mockRejectedValueOnce(new Error('network error 2'))
      .mockRejectedValueOnce(new Error('network error 3'))
      .mockResolvedValueOnce(
        makeResponse(200, { received: true, observation_id: 'abc' })
      );

    // 不 await，先拿到 promise 引用，便于分阶段推进时间
    const promise = pushConversation(
      { ...BASE_OPTIONS },
      {
        maxRetries: 3,
        retryDelayMs: 500,
        // 加大超时，避免 fake timer 推进过程中误触 abort（默认 10000ms）
        timeout: 100000,
      }
    );

    // attempt=0：让首个 fetch 微任务跑完（推进 0ms 仅 flush microtasks）
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 失败后 sleep 500ms（backoff = retryDelayMs * 2^0 = 500）
    // 推进不足 500ms 不应触发第 2 次 fetch
    await vi.advanceTimersByTimeAsync(499);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // 累计 500ms → 触发 attempt=1
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // 失败后 sleep 1000ms（backoff = retryDelayMs * 2^1 = 1000）
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); // 累计 1000ms → 触发 attempt=2
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // 失败后 sleep 2000ms（backoff = retryDelayMs * 2^2 = 2000）
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1); // 累计 2000ms → 触发 attempt=3（成功）
    expect(fetchMock).toHaveBeenCalledTimes(4);

    // 第 4 次成功 → 最终返回
    const result = await promise;
    expect(result).toEqual({
      received: true,
      deduplicated: false,
      observation_id: 'abc',
    });
  });

  // ------------------------------------------------------------------------

  it('test_pushConversation_dedup', async () => {
    // mock 后端返回 deduplicated: true（同 conversation_id 重复推送场景）
    fetchMock.mockResolvedValue(
      makeResponse(200, {
        received: true,
        deduplicated: true,
        observation_id: 'existing',
      })
    );

    const result = await pushConversation({ ...BASE_OPTIONS });

    // SDK 应原样透传 deduplicated 字段（而非吞掉）
    expect(result.received).toBe(true);
    expect(result.deduplicated).toBe(true);
    expect(result.observation_id).toBe('existing');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------------

  it('test_pushConversation_all_retry_failed', async () => {
    vi.useFakeTimers();

    // 所有 fetch 调用均 reject（网络错误）
    fetchMock.mockRejectedValue(new Error('network error'));

    const promise = pushConversation(
      { ...BASE_OPTIONS },
      { maxRetries: 3, retryDelayMs: 500, timeout: 100000 }
    );

    // 立即附 catch handler，避免 promise 在我们推进时间时异步 reject
    // 触发 vitest 的「Unhandled Rejection」告警
    const caughtErrorPromise = promise.catch((e: unknown) => e);

    // 推进时间让重试链跑完（500 + 1000 + 2000 = 3500ms）
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // attempt=0
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchMock).toHaveBeenCalledTimes(2); // attempt=1
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(3); // attempt=2
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(4); // attempt=3 = maxRetries（最后一次）

    // 重试耗尽 → SDK 抛 KwaPushError，且 fetch 调用次数 = maxRetries + 1 = 4
    const caughtError = await caughtErrorPromise;
    expect(caughtError).toBeInstanceOf(Error);
    expect((caughtError as Error).message).toMatch(/network error/);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // 再推进时间也不应有第 5 次 fetch（已停止重试）
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  // ------------------------------------------------------------------------

  it('test_pushConversation_missing_required_field', async () => {
    // 缺 platform 字段（客户端校验应直接抛错，不进入网络层）
    const invalidOptions = {
      timestamp: BASE_OPTIONS.timestamp,
      conversationMarkdown: BASE_OPTIONS.conversationMarkdown,
    } as unknown as PushOptions;

    await expect(pushConversation(invalidOptions)).rejects.toThrow(
      /platform is required/
    );

    // 校验失败 → 不应发出任何网络请求
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
