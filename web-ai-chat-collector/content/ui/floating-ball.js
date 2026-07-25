// ui/floating-ball.js - 悬浮球 UI（球 + 面板）

class FloatingBall {
  constructor(collector) {
    this.collector = collector;
    this.ball = null;
    this.panel = null;
    this.viewer = null;
    this.isDragging = false;
    this.isPanelOpen = false;
    this.dragOffset = { x: 0, y: 0 };
    this.dragStartPos = { x: 0, y: 0 };
    this.hasMoved = false;
    this.searchQuery = '';

    AIChatStyles.inject();
    this.createBall();
    this.createPanel();
    this.viewer = new ConversationViewer();
  }

  createBall() {
    this.ball = document.createElement('div');
    this.ball.id = 'ai-chat-ball';
    this.ball.innerHTML = `
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
      </svg>
      <span class="badge" style="display:none">0</span>
    `;

    document.body.appendChild(this.ball);

    this.ball.addEventListener('mousedown', (e) => this.onMouseDown(e));
    document.addEventListener('mousemove', (e) => this.onMouseMove(e));
    document.addEventListener('mouseup', (e) => this.onMouseUp(e));
  }

  createPanel() {
    this.panel = document.createElement('div');
    this.panel.id = 'ai-chat-panel';
    this.panel.innerHTML = `
      <div class="panel-header">
        <h2>ai-chat-collector</h2>
        <button class="settings-btn" id="acc-settings-btn" title="打开设置">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" width="16" height="16">
            <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94 0 .31.04.64.09.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.21.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" fill="currentColor"/>
          </svg>
        </button>
        <button class="close-btn">&times;</button>
      </div>
      <div class="panel-search">
        <input type="text" id="acc-search-input" placeholder="搜索对话内容..." />
        <button id="acc-search-btn">搜索</button>
      </div>
      <div class="panel-toolbar">
        <select id="acc-platform-filter">
          <option value="">全部平台</option>
        </select>
        <button class="btn-primary" id="acc-export-all">导出</button>
        <button id="acc-refresh">刷新</button>
      </div>
      <div class="conv-list" id="acc-conv-list">
        <div class="empty">暂无对话记录</div>
      </div>
    `;

    document.body.appendChild(this.panel);

    // 面板拖拽（通过 header 拖动）
    makeDraggable(this.panel, this.panel.querySelector('.panel-header'));

    this.panel.querySelector('.close-btn').addEventListener('click', () => this.togglePanel(false));
    this.panel.querySelector('#acc-settings-btn').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_SETTINGS' });
    });
    this.panel.querySelector('#acc-refresh').addEventListener('click', () => this.loadConversations());
    this.panel.querySelector('#acc-export-all').addEventListener('click', () => this.exportAll());
    this.panel.querySelector('#acc-platform-filter').addEventListener('change', () => this.loadConversations());
    
    // 搜索
    this.panel.querySelector('#acc-search-btn').addEventListener('click', () => this.handleSearch());
    this.panel.querySelector('#acc-search-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleSearch();
    });
    this.panel.querySelector('#acc-search-input').addEventListener('input', (e) => {
      if (!e.target.value.trim() && this.searchQuery) {
        this.searchQuery = '';
        this.loadConversations();
      }
    });
  }

  onMouseDown(e) {
    this.isDragging = true;
    this.hasMoved = false;
    const rect = this.ball.getBoundingClientRect();
    this.dragOffset.x = e.clientX - rect.left;
    this.dragOffset.y = e.clientY - rect.top;
    this.dragStartPos.x = e.clientX;
    this.dragStartPos.y = e.clientY;
    this.ball.style.cursor = 'grabbing';
    e.preventDefault();
  }

  onMouseMove(e) {
    if (!this.isDragging) return;

    const dx = e.clientX - this.dragStartPos.x;
    const dy = e.clientY - this.dragStartPos.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      this.hasMoved = true;
    }

    const x = e.clientX - this.dragOffset.x;
    const y = e.clientY - this.dragOffset.y;

    const maxX = window.innerWidth - this.ball.offsetWidth;
    const maxY = window.innerHeight - this.ball.offsetHeight;

    this.ball.style.left = Math.max(0, Math.min(x, maxX)) + 'px';
    this.ball.style.top = Math.max(0, Math.min(y, maxY)) + 'px';
    this.ball.style.right = 'auto';
    this.ball.style.bottom = 'auto';
  }

  onMouseUp(e) {
    if (!this.isDragging) return;
    this.isDragging = false;
    this.ball.style.cursor = 'grab';

    if (!this.hasMoved) {
      this.togglePanel();
    }
  }

  togglePanel(forceState) {
    this.isPanelOpen = forceState !== undefined ? forceState : !this.isPanelOpen;

    if (this.isPanelOpen) {
      this.positionPanel();
      this.panel.classList.add('open');
      this.loadConversations();
    } else {
      this.panel.classList.remove('open');
    }
  }

  positionPanel() {
    const ballRect = this.ball.getBoundingClientRect();
    const panelW = 380;
    const panelH = 520;

    let left = ballRect.left - panelW + ballRect.width;
    let top = ballRect.top - panelH;

    if (left < 8) {
      left = ballRect.right + 8;
    }
    if (top < 8) {
      top = ballRect.bottom + 8;
    }
    if (left + panelW > window.innerWidth - 8) {
      left = window.innerWidth - panelW - 8;
    }
    if (top + panelH > window.innerHeight - 8) {
      top = window.innerHeight - panelH - 8;
    }

    this.panel.style.left = left + 'px';
    this.panel.style.top = top + 'px';
  }

  updateBadge(count) {
    const badge = this.ball.querySelector('.badge');
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : count;
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  }

  async loadConversations() {
    const listEl = this.panel.querySelector('#acc-conv-list');
    try {
      const platform = this.panel.querySelector('#acc-platform-filter').value;
      
      let response;
      if (this.searchQuery) {
        response = await this.sendMessage({
          type: 'SEARCH_CONVERSATIONS',
          query: this.searchQuery,
          filters: platform ? { platform } : {}
        });
      } else {
        response = await this.sendMessage({
          type: 'GET_CONVERSATIONS',
          filters: platform ? { platform } : {}
        });
      }

      const statusResp = await this.sendMessage({ type: 'GET_STATUS' });
      if (statusResp) {
        this.updateBadge(statusResp.totalConversations);
        this.updatePlatformFilter(statusResp.platforms);
      }

      if (!response || response.length === 0) {
        listEl.innerHTML = '<div class="empty">暂无对话记录<br><small style="color:#ccc">打开 AI 平台开始对话，数据将自动采集</small></div>';
        return;
      }

      const platformNames = {
        deepseek: 'DeepSeek', chatgpt: 'ChatGPT', claude: 'Claude',
        kimi: 'Kimi', qianwen: '千问', yiyan: '文心一言'
      };

      listEl.innerHTML = '';
      for (const conv of response) {
        const item = document.createElement('div');
        item.className = 'conv-item';
        const date = new Date(conv.updatedAt).toLocaleDateString('zh-CN');
        const tag = platformNames[conv.platform] || conv.platform;

        item.innerHTML = `
          <div class="conv-top">
            <div class="conv-title" title="${this.escapeHtml(conv.title)}">${this.escapeHtml(conv.title)}</div>
            <span class="conv-tag">${tag}</span>
          </div>
          <div class="conv-info">
            <span>${conv.messages.length} 条消息</span>
            <span>${date}</span>
          </div>
          <div class="conv-btns">
            <button class="btn-view" data-id="${conv.id}">查看</button>
            <button class="btn-export" data-id="${conv.id}" data-fmt="markdown">导出 MD</button>
            <button class="btn-export" data-id="${conv.id}" data-fmt="json">导出 JSON</button>
            <button class="btn-del" data-id="${conv.id}" data-platform-conv-id="${conv.platformConversationId}">删除</button>
          </div>
        `;

        item.addEventListener('click', (e) => {
          if (e.target.tagName === 'BUTTON') return;
          item.classList.toggle('expanded');
        });

        item.querySelectorAll('.btn-view').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            this.viewer.open(btn.dataset.id, (msg) => this.sendMessage(msg));
          });
        });

        item.querySelectorAll('.btn-export').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            await this.sendMessage({
              type: 'EXPORT_CONVERSATION',
              id: btn.dataset.id,
              format: btn.dataset.fmt
            });
          });
        });

        item.querySelectorAll('.btn-del').forEach(btn => {
          btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (confirm('确定删除这条对话？')) {
              const delId = btn.dataset.id;
              const platformConvId = btn.dataset.platformConvId;
              await this.sendMessage({ type: 'DELETE_CONVERSATION', id: delId });
              // 记录已删除的对话平台ID到 collector 实例，切换到该对话时自动重新采集
              if (this.collector && this.collector._deletedConvIds && platformConvId) {
                this.collector._deletedConvIds.add(platformConvId);
                console.log('[FloatingBall/Debug] 已记录删除对话ID: platformConvId=%s, convId=%s, 当前已删除列表: [%s]',
                  platformConvId, delId, [...this.collector._deletedConvIds].join(','));
              }
              // 如果当前正在查看该对话（URL匹配），立即触发重新采集
              const currentConvId = this.collector?.getConvIdFromUrl?.() || this.collector?.getDomAdapter?.()?.getConversationId?.();
              console.log('[FloatingBall/Debug] 删除后检查: platformConvId=%s, currentConvId=%s, 是否匹配=%s',
                platformConvId, currentConvId, platformConvId === currentConvId);
              if (platformConvId === currentConvId && this.collector) {
                console.log('[FloatingBall/Debug] 当前正在查看被删除的对话，立即触发重新采集');
                this.collector._deletedConvIds.delete(platformConvId);
                this.collector.capturedHashes.clear();
                // 按模式分流：网络模式主动请求 API，DOM 模式走 DOM 提取
                // Kimi 等仅 DOM 模式的平台无网络适配器，调用 requestConversationData 会失败
                if (this.collector.mode === EXTRACTION_MODE.NETWORK) {
                  this.collector.requestConversationData(platformConvId);
                } else {
                  this.collector.captureCurrentConversation();
                }
              }
              this.loadConversations();
            }
          });
        });

        listEl.appendChild(item);
      }
    } catch (e) {
      if (e.message === 'CONTEXT_INVALIDATED') {
        listEl.innerHTML = '<div class="empty" style="color:#e74c3c">扩展已更新或重载<br><small style="color:#999">请刷新当前页面后重试</small></div>';
      }
    }
  }

  updatePlatformFilter(platforms) {
    const select = this.panel.querySelector('#acc-platform-filter');
    const current = select.value;
    const platformNames = {
      deepseek: 'DeepSeek',
      kimi: 'Kimi',
      qianwen: '千问',
      yiyan: '文心一言'
    };
    const options = ['<option value="">全部平台</option>'];
    for (const p of platforms) {
      options.push(`<option value="${p}">${platformNames[p] || p}</option>`);
    }
    select.innerHTML = options.join('');
    select.value = current;
  }

  async exportAll() {
    const fmt = confirm('确定 = 导出 Markdown，取消 = 导出 JSON') ? 'markdown' : 'json';
    try {
      await this.sendMessage({ type: 'EXPORT_ALL', format: fmt });
    } catch (e) {
      if (e.message === 'CONTEXT_INVALIDATED') {
        alert('扩展已更新或重载，请刷新页面后重试');
      }
    }
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
              console.warn('[ai-chat-collector] 消息发送失败:', errMsg);
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

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  
  // ===== 搜索 =====
  handleSearch() {
    const input = this.panel.querySelector('#acc-search-input');
    this.searchQuery = input.value.trim();
    this.loadConversations();
  }
}
