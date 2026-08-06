// exporter-base.js - 导出器基础架构
// 依赖：adapter-registry.js（EXTRACTION_MODE, DOM_ADAPTERS）
// 仅支持 DOM 提取模式（网络拦截模式已移除）

// ============================================================
// 导出器基类
// ============================================================
class ChatExporterBase {
  constructor(platformName, mode = EXTRACTION_MODE.DOM) {
    this.platformName = platformName;
    this.mode = mode;

    // 当前对话 ID（用于检测对话切换，避免重复采集）
    this.currentConvId = null;

    // 基类功能
    this.capturedHashes = new Set();
    this.debounceTimer = null;
    this.floatingBall = null;

    console.log(`[Exporter] 已加载，平台: ${platformName}, 模式: ${mode}`);

    this.init();
  }

  // ===== 获取当前平台的适配器 =====
  getDomAdapter() {
    return window.DOM_ADAPTERS[this.platformName] || null;
  }

  // ===== 初始化 =====
  init() {
    // 等待DOM ready后再初始化UI和观察器
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.initUi());
    } else {
      this.initUi();
    }
  }

  initUi() {
    // 监听URL变化
    this.watchUrlChanges();

    // 启动DOM观察器
    this.startObserver();

    // 创建悬浮球
    this.floatingBall = new FloatingBall(this);
  }

  // ===== 导出 =====
  exportAll() {
    return this.exportFromDom();
  }

  // DOM模式导出
  exportFromDom() {
    const adapter = this.getDomAdapter();
    if (!adapter) {
      console.error(`[Exporter] ❌ 未找到 ${this.platformName} 的DOM适配器`);
      return null;
    }

    const messages = adapter.extractMessages();

    if (!messages || messages.length === 0) {
      // 页面可能未加载完或不在对话页面，静默返回
      return null;
    }

    console.log(`[Exporter] 从DOM提取: ${messages.length} 条消息`);

    return {
      id: adapter.getConversationId(),
      title: adapter.getTitle(),
      messages: messages,
      url: window.location.href,
      platform: adapter.name
    };
  }

  // ===== URL监听 =====
  watchUrlChanges() {
    let lastUrl = location.href;

    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;

    history.pushState = function(...args) {
      origPushState.apply(this, args);
      window.dispatchEvent(new Event('locationchange'));
    };

    history.replaceState = function(...args) {
      origReplaceState.apply(this, args);
      window.dispatchEvent(new Event('locationchange'));
    };

    window.addEventListener('popstate', () => {
      window.dispatchEvent(new Event('locationchange'));
    });

    window.addEventListener('hashchange', () => {
      window.dispatchEvent(new Event('locationchange'));
    });

    window.addEventListener('locationchange', () => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        console.log('[Exporter] URL 变化:', location.href);
        this.onConversationChange();
      }
    });

    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        console.log('[Exporter] URL 变化（定期检查）:', location.href);
        this.onConversationChange();
      }
    }, 1000);
  }

  onConversationChange() {
    const newConvId = this.getDomAdapter()?.getConversationId() || 'default';

    console.log('[Exporter/Debug] onConversationChange: currentConvId=%s, newConvId=%s, url=%s',
      this.currentConvId, newConvId, location.href);

    if (newConvId === this.currentConvId) {
      console.log('[Exporter/Debug] 对话ID未变化，跳过 (currentConvId=%s)', this.currentConvId);
      return;
    }

    console.log('[Exporter] 切换对话:', this.currentConvId, '->', newConvId);
    this.currentConvId = newConvId;
    this.capturedHashes.clear();

    this.debounceCapture(1500);
  }

  // ===== DOM观察器 =====
  startObserver() {
    if (this.observer) this.observer.disconnect();

    this.observer = new MutationObserver((mutations) => {
      const hasNewNodes = mutations.some(m => m.addedNodes.length > 0);
      if (hasNewNodes) {
        this.debounceCapture(500);
      }
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  debounceCapture(delay = 500) {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.captureCurrentConversation();
    }, delay);
  }

  // ===== 采集对话 =====
  async captureCurrentConversation() {
    try {
      // 流式输出检查：若适配器提供 isStreaming() 且返回 true，跳过本次采集并安排重试
      const domAdapter = this.getDomAdapter();
      if (domAdapter && typeof domAdapter.isStreaming === 'function') {
        if (domAdapter.isStreaming()) {
          console.log(`[Exporter/DOM] ${this.platformName} 流式输出进行中，跳过本次采集，1.5s 后重试`);
          this.debounceCapture(1500);
          return;
        }
      }

      const conversation = this.exportFromDom();

      if (!conversation) {
        console.log('[Exporter/Debug] DOM提取返回null，可能页面未加载完');
        return;
      }

      const newMessages = conversation.messages.filter(m => {
        const hash = this.messageHash(m.role, m.content);
        return !this.capturedHashes.has(hash);
      });

      if (newMessages.length === 0) return;

      newMessages.forEach(m => {
        const hash = this.messageHash(m.role, m.content);
        this.capturedHashes.add(hash);
      });

      const convData = {
        platform: this.platformName,
        platformConversationId: conversation.id,
        title: conversation.title,
        url: conversation.url || window.location.href,
        messages: newMessages.map(m => ({
          ...m,
          hash: this.messageHash(m.role, m.content)
        })),
        // DOM 模式滚动加载场景下，newMessages 只是当前 DOM 中"未见过的"消息，
        // 直接 push 到末尾会导致向上滚动加载的旧消息被错误追加到对话末尾。
        // 传入当前 DOM 完整快照的 hash 顺序，供 db.js 按真实位置重排合并。
        domOrder: conversation.messages.map(m => this.messageHash(m.role, m.content))
      };

      await this.saveConversation(convData);
    } catch (err) {
      if (err.message !== 'CONTEXT_INVALIDATED') console.error('[Exporter] 采集对话失败:', err);
    }
  }

  // ===== 保存对话 =====
  async saveConversation(convData) {
    console.log('[Exporter/Debug] saveConversation: platformConvId=%s, title=%s, messages=%d',
      convData.platformConversationId, convData.title, convData.messages?.length);
    const response = await this.sendMessage({ type: 'SAVE_CONVERSATION', data: convData });

    if (response && response.success) {
      console.log(`[Exporter] 保存成功: ${response.action}, 新消息 ${response.newMessages || response.messageCount || 0} 条`);

      const statusResp = await this.sendMessage({ type: 'GET_STATUS' });
      if (statusResp && this.floatingBall) {
        this.floatingBall.updateBadge(statusResp.totalConversations);
        if (this.floatingBall.isPanelOpen) {
          this.floatingBall.loadConversations();
        }
      }
    }
  }

  // ===== 工具方法 =====
  messageHash(role, content) {
    const str = `${role}:${content}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  sendMessage(msg) {
    return new Promise((resolve, reject) => {
      try {
        if (!chrome.runtime?.id) {
          reject(new Error('CONTEXT_INVALIDATED'));
          return;
        }
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) {
            const errMsg = chrome.runtime.lastError.message || '';
            if (errMsg.includes('Extension context invalidated') || errMsg.includes('message port closed')) {
              reject(new Error('CONTEXT_INVALIDATED'));
            } else {
              console.warn('[Exporter] 消息发送失败:', errMsg);
              resolve(null);
            }
            return;
          }
          resolve(response);
        });
      } catch (e) {
        reject(new Error('CONTEXT_INVALIDATED'));
      }
    });
  }

  // ===== 诊断 =====
  diagnose() {
    const report = {
      mode: this.mode,
      platform: this.platformName,
      domAdapter: !!this.getDomAdapter(),
      currentConversationId: this.currentConvId,
      diagnosis: []
    };

    if (!this.getDomAdapter()) {
      report.diagnosis.push('❌ 未找到DOM适配器');
    } else {
      report.diagnosis.push('✅ DOM适配器已加载');
    }

    return report;
  }
}
