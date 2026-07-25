/**
 * @file kwa-push.d.ts
 * @description 知识工作助手（KWA）插件推送 SDK 的 TypeScript 类型定义。
 *
 * 与 `kwa-push.js`（UMD 模块）的运行时导出一一对应，并与后端
 * `app/models/schemas.py` 中的 `PluginConversationRequest` /
 * `PluginConversationResponse` 字段对齐：
 *
 * - 后端请求体使用 snake_case（`conversation_markdown`），SDK 对外暴露
 *   camelCase（`conversationMarkdown`），转换在运行时完成。
 * - `metadata.conversation_id` 为后端幂等去重键来源（snake_case 保持不变，
 *   因其属于 metadata 自由字段）。
 *
 * 浏览器全局变量：当通过 `<script>` 标签引入时，挂载为 `window.KwaPush`，
 * 通过 `export as namespace KwaPush` 声明其全局命名空间。
 */

/// <reference lib="dom" />

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 推送对话时附带的可选元数据。
 *
 * - `conversation_id`：强烈推荐填写，后端基于 `{platform}:{conversation_id}`
 *   计算 `dedup_key`，在 24h 内对同一 id 的重复推送返回 `deduplicated: true`，
 *   不写新记录。
 * - `title` / `url` / `model`：若提供必须为 string（后端校验，否则 422）。
 * - 其余任意字段原样存入 `observations.metadata_json`。
 */
export interface PushMetadata {
  /** 对话唯一标识，用于 24h 幂等去重。强烈推荐填写。 */
  conversation_id?: string;
  /** 对话标题。 */
  title?: string;
  /** 对话原始 URL。 */
  url?: string;
  /** 模型名，如 'gpt-4o-mini'。 */
  model?: string;
  /** 任意附加字段，原样存入后端 metadata。 */
  [k: string]: unknown;
}

/**
 * `pushConversation` 的入参（camelCase）。
 *
 * 运行时 SDK 会将 `conversationMarkdown` 转为后端契约的
 * `conversation_markdown`。
 */
export interface PushConversationOptions {
  /** 来源平台，必须在 `SUPPORTED_PLATFORMS` 白名单内（'custom' 兜底）。 */
  platform: string;
  /** 对话发生时间，ISO8601 字符串，如 '2025-01-01T12:00:00+08:00'。 */
  timestamp: string;
  /** 对话原文 Markdown（非空），作为 Agent 抽取知识点的源材料。 */
  conversationMarkdown: string;
  /** 可选元数据；推荐填 `conversation_id` 用于幂等去重。 */
  metadata?: PushMetadata | null;
}

/**
 * SDK 运行时配置项。
 *
 * - 全局默认值通过 `configure()` 覆写。
 * - 单次调用可通过 `pushConversation(options, config)` 临时覆写。
 * - `createClient(options)` 创建持有独立配置副本的客户端实例。
 */
export interface KwaPushConfig {
  /**
   * 后端推送端点 URL。
   * @default 'http://127.0.0.1:8788/api/plugin/conversations'
   */
  webhookUrl?: string;
  /**
   * 单次请求超时（毫秒）。
   * @default 10000
   */
  timeout?: number;
  /**
   * 失败重试次数上限（不含首次尝试）。仅对网络错误与 5xx 重试，4xx 不重试。
   * @default 3
   */
  maxRetries?: number;
  /**
   * 指数退避基数（毫秒），实际等待 = `retryDelayMs * 2^attempt`。
   * @default 500
   */
  retryDelayMs?: number;
  /** 可选，支持取消整个推送流程（含退避等待期）。 */
  signal?: AbortSignal;
}

/**
 * `pushConversation` 成功时的响应，与后端 `PluginConversationResponse` 对齐。
 */
export interface PushConversationResponse {
  /** 是否已接收，固定为 true。 */
  received: boolean;
  /** 是否命中幂等去重（最近 24h 内同 dedup_key 已存在）。 */
  deduplicated: boolean;
  /** 持久化后的观察记录 ID（32 位十六进制）；命中去重时为既有记录 ID。 */
  observation_id: string;
}

// ============================================================================
// 错误类
// ============================================================================

/**
 * 推送过程中产生的运行时错误（网络错误 / 超时 / 5xx / 重试耗尽 / 调用方取消）。
 *
 * - `status === 0` 表示网络错误 / 超时 / 调用方取消（无 HTTP 响应）。
 * - `status >= 500` 表示服务端错误（已重试耗尽）。
 * - `status >= 400 && status < 500` 一般不会出现在本类（4xx 不重试，但若需
 *   区分也可读取）；4xx 实际由 `pushConversation` 直接抛出本类。
 */
export declare class KwaPushError extends Error {
  /** HTTP 状态码；网络错误 / 超时 / 取消时为 0。 */
  readonly status: number;
  /** 失败时所处的尝试序号（0 表示首次尝试）。 */
  attempt: number;
  /** 后端返回的解析后响应体（若可解析为 JSON），否则 undefined。 */
  readonly responseBody?: unknown;
  constructor(
    message: string,
    options?: {
      status?: number;
      attempt?: number;
      responseBody?: unknown;
    }
  );
}

/**
 * 客户端校验失败（字段缺失 / 类型不符 / 空值）时抛出。
 *
 * 校验在发起网络请求前同步完成（实际上以 rejected Promise 形式抛出，
 * 因为 `pushConversation` 是 async 函数）。
 */
export declare class KwaPushValidationError extends Error {
  /** 出错字段名（'platform' / 'timestamp' / 'conversationMarkdown' / 'metadata' / 'options'）。 */
  readonly field: string | null;
  constructor(message: string, field?: string | null);
}

// ============================================================================
// 客户端实例
// ============================================================================

/**
 * 独立客户端实例，持有自己的配置副本，互不影响。
 *
 * 适用场景：同时对接多个后端（dev / staging），每个后端一个 client。
 * 通过 `createClient(options)` 创建。
 */
export interface KwaPushClient {
  /** 当前客户端配置快照（`configure` 后会同步更新此对象的字段值）。 */
  readonly config: KwaPushConfig & {
    webhookUrl: string;
    timeout: number;
    maxRetries: number;
    retryDelayMs: number;
  };
  /**
   * 使用本客户端配置推送对话；可传入 `overrideConfig` 临时覆写部分字段
   * （仅覆写提供的字段，其余继承客户端配置）。
   */
  pushConversation(
    options: PushConversationOptions,
    overrideConfig?: KwaPushConfig
  ): Promise<PushConversationResponse>;
  /**
   * 更新本客户端配置（仅更新提供的字段，其余保持不变）。
   * 注意：`configure` 不支持 `signal`（signal 仅在单次 `pushConversation` 调用中传入）。
   */
  configure(options: Omit<KwaPushConfig, 'signal'>): void;
}

// ============================================================================
// 顶层导出
// ============================================================================

/**
 * 支持的来源平台白名单（与后端 `routers/plugin.py` 的 `SUPPORTED_PLATFORMS` 对齐）。
 * `custom` 用于插件自定义 / 未列举的平台兜底。
 */
export declare const SUPPORTED_PLATFORMS: readonly [
  'chatgpt',
  'claude',
  'gemini',
  'deepseek',
  'qwen',
  'doubao',
  'kimi',
  'fudan',
  'custom'
];

/**
 * 推送一条 AI 对话到后端。
 *
 * 行为：
 * 1. 客户端基本校验（`platform` / `timestamp` / `conversationMarkdown` 非空），
 *    失败抛 `KwaPushValidationError`。
 * 2. 将 camelCase 字段转为后端 snake_case 契约（`conversationMarkdown` →
 *    `conversation_markdown`）。
 * 3. 通过 `fetch` POST 到 `webhookUrl`，带 `AbortController` 超时控制。
 * 4. 失败重试：仅对网络错误与 5xx 重试，4xx 不重试；指数退避
 *    `retryDelayMs * 2^attempt`。
 * 5. 重试到达上限后抛出 `KwaPushError`（含 `status` / `attempt` 字段）。
 *
 * @param options 推送参数。
 * @param config  可选运行时配置（覆写全局默认与客户端默认）。
 * @throws {KwaPushValidationError} 客户端校验失败。
 * @throws {KwaPushError} 网络错误 / 超时 / 4xx / 5xx / 重试耗尽 / 调用方取消。
 */
export declare function pushConversation(
  options: PushConversationOptions,
  config?: KwaPushConfig
): Promise<PushConversationResponse>;

/**
 * 配置全局默认值，后续无 config 参数的 `pushConversation` 调用将使用此处的值。
 * 注意：`configure` 不支持 `signal`（signal 仅在单次调用中传入）。
 *
 * @param options 全局配置覆写项。
 */
export declare function configure(
  options: Omit<KwaPushConfig, 'signal'>
): void;

/**
 * 创建独立客户端实例，持有自己的配置副本，互不影响。
 *
 * 适用场景：同时对接多个后端（dev / staging），每个后端一个 client。
 *
 * @param options 初始配置（同 `KwaPushConfig`，可选）。
 * @returns 客户端实例，含 `pushConversation` / `configure` / `config`。
 */
export declare function createClient(options?: KwaPushConfig): KwaPushClient;

/**
 * 当通过 `<script>` 标签引入 UMD 包时，SDK 挂载为浏览器全局变量 `KwaPush`。
 * 此声明使其在 TS 中可被作为全局命名空间访问（同时仍支持 ESM / CJS import）。
 */
export as namespace KwaPush;
