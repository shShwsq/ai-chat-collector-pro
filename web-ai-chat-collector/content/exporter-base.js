// exporter-base.js - 导出器基础架构
// 依赖：adapter-registry.js（EXTRACTION_MODE, NETWORK_ADAPTERS, DOM_ADAPTERS）

// ============================================================
// 导出器基类
// ============================================================
class ChatExporterBase {
  constructor(platformName, mode = EXTRACTION_MODE.DOM) {
    this.platformName = platformName;
    this.mode = mode;
    
    // 网络模式：存储完整对话数据
    this.conversations = new Map();
    this.currentConvId = null;
    
    // 拦截器状态
    this.interceptor = {
      active: false,
      requestCount: 0,
      parseSuccessCount: 0,
      parseFailCount: 0,
      lastCaptureTime: 0
    };
    
    // 基类功能
    this.capturedHashes = new Set();
    this.debounceTimer = null;
    this.floatingBall = null;
    
    console.log(`[Exporter] 已加载，平台: ${platformName}, 模式: ${mode}`);
    
    this.init();
  }
  
  // ===== 获取当前平台的适配器 =====
  getNetworkAdapter() {
    return window.NETWORK_ADAPTERS[this.platformName] || null;
  }
  
  getDomAdapter() {
    return window.DOM_ADAPTERS[this.platformName] || null;
  }
  
  // ===== 初始化 =====
  init() {
    this._deletedConvIds = new Set();
    
    // 启动网络拦截（如果需要）—— 必须最早执行
    if (this.mode === EXTRACTION_MODE.NETWORK) {
      const adapter = this.getNetworkAdapter();
      if (adapter) {
        this.setupInterceptor();
      } else {
        console.warn(`[Exporter] 未找到 ${this.platformName} 的网络适配器`);
      }
    }
    
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
  
  // ===== 网络拦截 =====
  setupInterceptor() {
    this.interceptor.active = true;
    
    // 监听来自 MAIN world 的拦截数据
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      if (event.data?.type !== '__AI_CHAT_INTERCEPTED__') return;
      
      const { url, body, source, requestBody } = event.data;
      this.interceptor.requestCount++;
      this.interceptor.lastCaptureTime = Date.now();
      
      console.log('[Exporter/Debug] 收到拦截数据: source=%s, url=%s, bodyLength=%s, hasRequestBody=%s',
        source, url?.substring(0, 100), body?.length, !!requestBody);
      
      // 尝试解析为 JSON（普通 API 响应）
      try {
        const data = JSON.parse(body);
        this.parseResponse(url, data, requestBody);
        return;
      } catch (err) {
        // 非 JSON，可能是 SSE 流式响应
      }
      
      // 尝试解析为 SSE 流式响应
      if (body && body.includes('data:')) {
        console.log('[Exporter/Debug] 检测到 SSE 流式响应: url=%s', url?.substring(0, 100));
        this.parseResponse(url, body, requestBody);
        return;
      }
      
      console.log('[Exporter/Debug] 拦截数据无法解析，忽略: url=%s', url?.substring(0, 80));
    });
    
    console.log('[Exporter] 网络拦截器已启动');
  }
  
  parseResponse(url, data, requestBody) {
    const adapter = this.getNetworkAdapter();
    if (!adapter) {
      console.log('[Exporter/Debug] parseResponse: 无网络适配器, platformName=%s', this.platformName);
      return;
    }
    
    if (!adapter.matchApi(url)) {
      return;
    }
    
    const isStream = typeof data === 'string';
    console.log('[Exporter/Debug] parseResponse: URL匹配成功, url=%s, isStream=%s, hasRequestBody=%s',
      url?.substring(0, 100), isStream, !!requestBody);
    
    const conversation = adapter.parse(url, data, requestBody);

    if (!conversation) {
      // parse 返回 null 是正常的（如标题缓存类 API），不打 warn
      console.log('[Exporter/Debug] adapter.parse 返回 null, URL: %s', url?.substring(0, 80));
      return;
    }

    // 标题更新（来自会话信息 API，不携带消息）：只更新标题，不覆盖消息
    if (conversation.titleUpdate) {
      console.log('[Exporter/Debug] 标题更新: convId=%s, title=%s', conversation.id, conversation.title);
      // 同步更新内存中的对话标题
      const existing = this.conversations.get(conversation.id);
      if (existing) {
        existing.title = conversation.title;
      }
      this.saveConversation({
        platform: this.platformName,
        platformConversationId: conversation.id,
        title: conversation.title,
        url: conversation.url || window.location.href,
        mode: 'updateTitle',
        messages: []
      }).catch(err => {
        if (err.message !== 'CONTEXT_INVALIDATED') console.error('[Exporter] 更新标题失败:', err);
      });
      return;
    }
    
    this.interceptor.parseSuccessCount++;
    this.currentConvId = conversation.id;
    
    if (isStream) {
      // 流式响应：追加模式 - 与内存中已有数据合并，只保存新消息
      const existing = this.conversations.get(conversation.id);
      if (existing) {
        const existingHashes = new Set(existing.messages.map(m => this.messageHash(m.role, m.content)));
        const newMsgs = conversation.messages.filter(m => !existingHashes.has(this.messageHash(m.role, m.content)));
        if (newMsgs.length > 0) {
          existing.messages = [...existing.messages, ...newMsgs];
          console.log(`[Exporter] 合并流式消息到对话 ${conversation.id}: +${newMsgs.length} 条`);
        }
        if (conversation.title && !existing.title) {
          existing.title = conversation.title;
        }
      } else {
        this.conversations.set(conversation.id, conversation);
      }
      
      // 去重：只发送 capturedHashes 中没有的新消息
      const newMessages = conversation.messages.filter(m => {
        const hash = this.messageHash(m.role, m.content);
        return !this.capturedHashes.has(hash);
      });
      
      if (newMessages.length === 0) {
        console.log('[Exporter/Debug] 流式响应无新消息，跳过保存');
        return;
      }
      
      newMessages.forEach(m => {
        this.capturedHashes.add(this.messageHash(m.role, m.content));
      });
      
      this.saveConversation({
        platform: this.platformName,
        platformConversationId: conversation.id,
        title: conversation.title,
        url: conversation.url || window.location.href,
        mode: 'append',
        messages: newMessages.map(m => ({
          ...m,
          hash: this.messageHash(m.role, m.content)
        }))
      }).catch(err => {
        if (err.message !== 'CONTEXT_INVALIDATED') console.error('[Exporter] 保存流式对话失败:', err);
      });
    } else {
      // 历史对话响应：覆盖模式 - 直接用完整数据替换内存和存储
      this.conversations.set(conversation.id, conversation);
      conversation.messages.forEach(m => {
        this.capturedHashes.add(this.messageHash(m.role, m.content));
      });
      
      console.log('[Exporter] 历史对话覆盖: convId=%s, 消息数=%d', conversation.id, conversation.messages.length);
      
      this.saveConversation({
        platform: this.platformName,
        platformConversationId: conversation.id,
        title: conversation.title,
        url: conversation.url || window.location.href,
        mode: 'overwrite',
        messages: conversation.messages.map(m => ({
          ...m,
          hash: this.messageHash(m.role, m.content)
        }))
      }).catch(err => {
        if (err.message !== 'CONTEXT_INVALIDATED') console.error('[Exporter] 保存历史对话失败:', err);
      });
    }
  }
  
  // ===== 导出 =====
  exportAll() {
    if (this.mode === EXTRACTION_MODE.NETWORK) {
      return this.exportFromNetwork();
    } else {
      return this.exportFromDom();
    }
  }
  
  // 网络模式导出
  exportFromNetwork() {
    if (this.conversations.size === 0) {
      console.error('[Exporter] ❌ 未捕获到对话数据');
      console.error('[Exporter] 建议：刷新页面');
      return null;
    }
    
    const conversation = this.conversations.get(this.currentConvId);
    
    if (!conversation) {
      console.error('[Exporter] ❌ 未找到当前对话');
      return null;
    }
    
    console.log(`[Exporter] 导出对话: ${conversation.id}, 消息数: ${conversation.messages.length}`);
    return conversation;
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
    // 网络模式下优先从 URL 提取对话 ID
    let newConvId;
    if (this.mode === EXTRACTION_MODE.NETWORK) {
      newConvId = this.getConvIdFromUrl() || this.getDomAdapter()?.getConversationId() || 'default';
    } else {
      newConvId = this.getDomAdapter()?.getConversationId() || 'default';
    }
    
    console.log('[Exporter/Debug] onConversationChange: currentConvId=%s, newConvId=%s, deletedIds=[%s], mode=%s, url=%s',
      this.currentConvId, newConvId, [...(this._deletedConvIds || [])].join(','), this.mode, location.href);
    
    // 网络模式下，如果该对话已被删除，即使 URL 没变也要主动请求
    if (this.mode === EXTRACTION_MODE.NETWORK && this._deletedConvIds && this._deletedConvIds.has(newConvId)) {
      console.log('[Exporter/Debug] 检测到已删除对话，主动请求: %s (URL是否变化: %s)', newConvId, newConvId !== this.currentConvId);
      this._deletedConvIds.delete(newConvId);
      this.currentConvId = newConvId;
      this.capturedHashes.clear();
      this.requestConversationData(newConvId);
      return;
    }
    
    if (newConvId === this.currentConvId) {
      console.log('[Exporter/Debug] 对话ID未变化，跳过 (currentConvId=%s)', this.currentConvId);
      return;
    }
    
    console.log('[Exporter] 切换对话:', this.currentConvId, '->', newConvId);
    this.currentConvId = newConvId;
    this.capturedHashes.clear();
    
    // 网络模式下，切换对话时检查是否需要主动请求
    if (this.mode === EXTRACTION_MODE.NETWORK) {
      console.log('[Exporter/Debug] 网络模式切换对话，当前 conversations 中是否有该对话: %s', this.conversations.has(newConvId));
      return;
    }
    
    this.debounceCapture(1500);
  }
  
  // 从 URL 中提取对话 ID
  getConvIdFromUrl() {
    // DeepSeek: /a/chat/s/{id} 或 /a/chat/{id}
    let match = location.pathname.match(/\/chat\/(?:s\/)?([a-f0-9\-]+)/i);
    if (match) return match[1];
    // 千问: /chat/{id}
    match = location.pathname.match(/\/chat\/([a-f0-9]+)/i);
    if (match) return match[1];
    // 复旦: sess_id=xxx 或 /chat?...&sess_id=xxx
    const urlParams = new URLSearchParams(location.search);
    const sessId = urlParams.get('sess_id');
    if (sessId) return sessId;
    return null;
  }
  
  // 网络模式下主动请求对话数据
  requestConversationData(convId) {
    const adapter = this.getNetworkAdapter();
    console.log('[Exporter/Debug] requestConversationData: convId=%s, adapter=%s, fetchConversation=%s, platformName=%s',
      convId, !!adapter, !!(adapter && adapter.fetchConversation), this.platformName);
    if (!adapter || !adapter.fetchConversation) {
      console.warn('[Exporter/Debug] requestConversationData 失败: 无适配器或无 fetchConversation 方法');
      return;
    }
    
    console.log('[Exporter/Debug] 调用 adapter.fetchConversation(%s)...', convId);
    const result = adapter.fetchConversation(convId);
    console.log('[Exporter/Debug] fetchConversation 返回: %s (预期为 null，响应由拦截器异步处理)', result);
  }
  
  // ===== DOM观察器 =====
  startObserver() {
    if (this.observer) this.observer.disconnect();
    
    // 网络模式下不需要DOM观察器触发采集，拦截器直接保存
    if (this.mode === EXTRACTION_MODE.NETWORK) return;
    
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
    // 网络模式下由拦截器直接保存，此方法仅DOM模式使用
    if (this.mode === EXTRACTION_MODE.NETWORK) return;

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
  
  // ===== 模式切换 =====
  switchMode(newMode) {
    if (this.mode === newMode) return;
    
    console.log(`[Exporter] 切换模式: ${this.mode} -> ${newMode}`);
    this.mode = newMode;
    
    if (newMode === EXTRACTION_MODE.NETWORK && !this.interceptor.active) {
      this.setupInterceptor();
    }
  }
  
  // ===== 诊断 =====
  diagnose() {
    const report = {
      mode: this.mode,
      platform: this.platformName,
      networkAdapter: !!this.getNetworkAdapter(),
      domAdapter: !!this.getDomAdapter(),
      interceptor: this.interceptor,
      conversationsCount: this.conversations.size,
      currentConversationId: this.currentConvId,
      diagnosis: []
    };
    
    if (this.mode === EXTRACTION_MODE.NETWORK) {
      if (!this.getNetworkAdapter()) {
        report.diagnosis.push('❌ 未找到网络适配器');
      } else if (!this.interceptor.active) {
        report.diagnosis.push('❌ 拦截器未激活');
      } else {
        report.diagnosis.push('✅ 拦截器已激活');
      }
      
      if (this.interceptor.requestCount === 0) {
        report.diagnosis.push('❌ 未捕获到任何请求');
      } else {
        report.diagnosis.push(`✅ 捕获了 ${this.interceptor.requestCount} 个请求`);
      }
      
      if (this.conversations.size === 0) {
        report.diagnosis.push('❌ 未捕获到对话数据');
      } else {
        report.diagnosis.push(`✅ 捕获了 ${this.conversations.size} 个对话`);
      }
    } else {
      if (!this.getDomAdapter()) {
        report.diagnosis.push('❌ 未找到DOM适配器');
      } else {
        report.diagnosis.push('✅ DOM适配器已加载');
      }
    }
    
    return report;
  }
}
