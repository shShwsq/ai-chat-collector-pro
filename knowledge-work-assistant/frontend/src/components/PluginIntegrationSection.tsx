/**
 * 设置面板「插件对接」分区（SubTask 2.5）。
 *
 * 渲染内容：
 *   1. Webhook URL 框（后端推送地址 + 复制按钮，复制成功显示「已复制」2s）；
 *   2. 支持平台 chip 列表（优先取 pluginContract.supported_platforms，兜底 9 个平台）；
 *   3. 「查看契约」按钮 → 弹窗显示 pluginContract JSON（<pre> + 复制）；
 *   4. 最近推送记录列表（platform chip / title / timestamp / 去重徽标 / 已处理徽标）；
 *   5. 顶部「刷新」按钮手动拉取最近记录。
 *
 * 数据流：
 * - 进入分区（组件挂载）时立即拉取一次最近记录与契约（懒加载）；
 * - WebSocket 收到新对话事件时由 App.tsx 统一弹 Toast，本分区通过「刷新」按钮或
 *   重新进入分区时获取最新记录。
 */

import { useEffect, useMemo, useState } from 'react'

import { useAppStore } from '../store/useAppStore'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { api } from '../lib/api'
import { formatShortTime } from '../lib/date'

/** 兜底平台列表（与后端 SUPPORTED_PLATFORMS 白名单对齐）。 */
const FALLBACK_PLATFORMS = [
  'chatgpt',
  'claude',
  'gemini',
  'deepseek',
  'qwen',
  'doubao',
  'kimi',
  'fudan',
  'custom',
]

/** 后端默认端口（与 lib/api.ts 的 FALLBACK_BACKEND_ORIGIN 对齐）。 */
const FALLBACK_BACKEND_ORIGIN = 'http://127.0.0.1:8788'

/** 「已复制」提示持续时长（ms）。 */
const COPIED_HINT_MS = 2000

/**
 * 解析后端绝对 origin，供浏览器插件作为 webhook 推送目标。
 *
 * - 生产环境（file://）：通过 preload 桥获取后端地址，兜底 127.0.0.1:8788；
 * - dev 环境：后端实际监听 8788（Vite 代理 /api → 后端），插件直连后端。
 */
function resolveBackendOrigin(): string {
  if (typeof window === 'undefined') return FALLBACK_BACKEND_ORIGIN
  if (window.location.protocol === 'file:') {
    return window.electronAPI?.backend?.getUrl() ?? FALLBACK_BACKEND_ORIGIN
  }
  return FALLBACK_BACKEND_ORIGIN
}

export function PluginIntegrationSection() {
  const pluginRecent = useAppStore((s) => s.pluginRecent)
  const pluginRecentLoading = useAppStore((s) => s.pluginRecentLoading)
  const pluginRecentError = useAppStore((s) => s.pluginRecentError)
  const pluginContract = useAppStore((s) => s.pluginContract)
  const loadPluginRecent = useAppStore((s) => s.loadPluginRecent)
  const loadPluginContract = useAppStore((s) => s.loadPluginContract)

  const [urlCopied, setUrlCopied] = useState(false)
  const [contractOpen, setContractOpen] = useState(false)
  const [contractCopied, setContractCopied] = useState(false)
  const [contractLoading, setContractLoading] = useState(false)
  const [pairCode, setPairCode] = useState('')
  const [pairing, setPairing] = useState(false)

  const webhookUrl = `${resolveBackendOrigin()}/api/plugin/conversations`
  const contractDialogRef = useDialogFocus<HTMLDivElement>({ active: contractOpen, initialFocus: '.plugin-contract-modal__actions button', onEscape: () => setContractOpen(false) })

  // 进入分区时立即拉取一次最近记录 + 契约（懒加载）
  useEffect(() => {
    void loadPluginRecent()
    void loadPluginContract()
  }, [loadPluginRecent, loadPluginContract])

  const platforms = useMemo<string[]>(() => {
    if (pluginContract) {
      const sp = pluginContract.supported_platforms
      if (Array.isArray(sp) && sp.length > 0) {
        return sp as string[]
      }
    }
    return FALLBACK_PLATFORMS
  }, [pluginContract])

  const contractJson = useMemo(
    () => (pluginContract ? JSON.stringify(pluginContract, null, 2) : ''),
    [pluginContract],
  )

  const handleRefresh = () => {
    void loadPluginRecent()
  }

  const handleCreatePairCode = async () => {
    setPairing(true)
    try {
      const result = await api.getPluginPairCode()
      setPairCode(result.code)
    } finally {
      setPairing(false)
    }
  }

  const handleCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl)
      setUrlCopied(true)
      window.setTimeout(() => setUrlCopied(false), COPIED_HINT_MS)
    } catch {
      // 剪贴板不可用时静默处理
    }
  }

  const handleViewContract = async () => {
    setContractOpen(true)
    setContractCopied(false)
    // 契约尚未加载时拉取（进入分区时通常已加载，此处兜底）
    if (!pluginContract) {
      setContractLoading(true)
      await loadPluginContract()
      setContractLoading(false)
    }
  }

  const handleCopyContract = async () => {
    if (!pluginContract) return
    try {
      await navigator.clipboard.writeText(contractJson)
      setContractCopied(true)
      window.setTimeout(() => setContractCopied(false), COPIED_HINT_MS)
    } catch {
      // 剪贴板不可用时静默处理
    }
  }

  return (
    <section className="settings-section">
      <header className="settings-section__header">
        <div>
          <h2 className="settings-section__title">插件对接</h2>
          <p className="settings-section__desc">
            浏览器插件采集对话后推送到本地后端。复制下方 Webhook URL 配置到插件，
            支持的平台见 chip 列表，最近推送记录可在此查看与刷新。
          </p>
        </div>
        <button
          type="button"
          className="settings-section__ghost-btn"
          onClick={handleRefresh}
          disabled={pluginRecentLoading}
          title="刷新最近推送记录"
        >
          {pluginRecentLoading ? '刷新中…' : '刷新'}
        </button>
      </header>

      <div className="plugin-url-box">
        <code>{pairCode || '点击生成一次性 6 位配对码'}</code>
        <button
          type="button"
          className="plugin-url-box__copy-btn"
          onClick={() => void handleCreatePairCode()}
          disabled={pairing}
        >
          {pairing ? '生成中…' : '生成配对码'}
        </button>
      </div>

      {/* 1. Webhook URL */}
      <div className="plugin-url-box">
        <code>{webhookUrl}</code>
        <button
          type="button"
          className={`plugin-url-box__copy-btn${urlCopied ? ' is-copied' : ''}`}
          onClick={handleCopyUrl}
          title="复制 Webhook URL"
        >
          {urlCopied ? '已复制' : '复制'}
        </button>
      </div>

      {/* 2. 支持平台 chips */}
      <div className="plugin-platform-chips">
        {platforms.map((p) => (
          <span key={p} className="plugin-platform-chip">
            {p}
          </span>
        ))}
      </div>

      {/* 3. 查看契约按钮 */}
      <div
        className="plugin-contract-actions"
        style={{ marginBottom: 16, marginTop: 4 }}
      >
        <button
          type="button"
          className="settings-section__ghost-btn"
          onClick={handleViewContract}
          title="查看插件对接接口契约 JSON"
        >
          查看契约
        </button>
      </div>

      {/* 4. 最近推送记录列表 */}
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--text)',
          margin: '4px 0 8px',
        }}
      >
        最近推送记录
      </div>

      {pluginRecentError && (
        <div className="settings-section__error">
          加载推送记录失败：{pluginRecentError}
        </div>
      )}

      {!pluginRecentError && pluginRecent.length === 0 ? (
        <div className="plugin-recent-empty">
          {pluginRecentLoading ? '正在加载…' : '暂无推送记录'}
        </div>
      ) : (
        <ul className="plugin-recent-list">
          {pluginRecent.map((item) => (
            <li
              key={item.observation_id}
              className="plugin-recent-list__item"
            >
              <span className="plugin-recent-list__platform">
                {item.platform}
              </span>
              <span
                className="plugin-recent-list__title"
                title={item.title}
              >
                {item.title || '(无标题)'}
              </span>
              {item.dedup_key !== null && item.dedup_key !== undefined && (
                <span className="plugin-recent-list__badge plugin-recent-list__badge--dedup">
                  去重
                </span>
              )}
              {item.processed && (
                <span className="plugin-recent-list__badge plugin-recent-list__badge--processed">
                  已处理
                </span>
              )}
              <span
                className="plugin-recent-list__time"
                title={item.created_at}
              >
                {formatShortTime(item.timestamp) || '-'}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* 5. 契约弹窗 */}
      {contractOpen && (
        <div
          ref={contractDialogRef}
          className="plugin-contract-modal"
          role="dialog"
          aria-modal="true"
          aria-label="插件对接契约"
          onClick={() => setContractOpen(false)}
        >
          <div
            className="plugin-contract-modal__box"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="plugin-contract-modal__header">
              <h3 className="plugin-contract-modal__title">插件对接契约</h3>
              <div className="plugin-contract-modal__actions">
                <button
                  type="button"
                  className={`plugin-url-box__copy-btn${contractCopied ? ' is-copied' : ''}`}
                  onClick={handleCopyContract}
                  disabled={!pluginContract}
                  title="复制契约 JSON"
                >
                  {contractCopied ? '已复制' : '复制'}
                </button>
                <button
                  type="button"
                  className="plugin-url-box__copy-btn"
                  onClick={() => setContractOpen(false)}
                  title="关闭"
                >
                  关闭
                </button>
              </div>
            </div>
            <div className="plugin-contract-modal__body">
              {contractLoading && !pluginContract ? (
                <pre>正在加载…</pre>
              ) : pluginContract ? (
                <pre>{contractJson}</pre>
              ) : (
                <pre>（契约加载失败）</pre>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
