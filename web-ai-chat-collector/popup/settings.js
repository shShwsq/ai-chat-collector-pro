// settings.js - 设置页面逻辑

document.addEventListener('DOMContentLoaded', () => {
  const backBtn = document.getElementById('backBtn');
  const saveBtn = document.getElementById('saveBtn');
  const testEmbeddingBtn = document.getElementById('testEmbeddingBtn');
  const testLlmBtn = document.getElementById('testLlmBtn');
  const testVectorConnectionBtn = document.getElementById('testVectorConnectionBtn');
  const rebuildIndexBtn = document.getElementById('rebuildIndexBtn');
  const toast = document.getElementById('toast');

  // ---- 表单元素 ----
  const platformDeepseek = document.getElementById('platformDeepseek');
  const platformQianwen = document.getElementById('platformQianwen');
  const platformFudan = document.getElementById('platformFudan');
  const platformDoubao = document.getElementById('platformDoubao');
  const platformKimi = document.getElementById('platformKimi');
  const platformYuanbao = document.getElementById('platformYuanbao');
  const platformWenxin = document.getElementById('platformWenxin');

  const embeddingProvider = document.getElementById('embeddingProvider');
  const embeddingKeyLabel = document.getElementById('embeddingKeyLabel');
  const embeddingKeyHelp = document.getElementById('embeddingKeyHelp');
  const embeddingModel = document.getElementById('embeddingModel');
  const embeddingModelSelect = document.getElementById('embeddingModelSelect');
  const embeddingModelDropdown = document.getElementById('embeddingModelDropdown');
  const embeddingModelHelp = document.getElementById('embeddingModelHelp');
  const dashscopeEmbeddingKey = document.getElementById('dashscopeEmbeddingKey');
  const embeddingBaseUrl = document.getElementById('embeddingBaseUrl');
  const includeThinking = document.getElementById('includeThinking');
  const includeSearch = document.getElementById('includeSearch');
  const chunkSize = document.getElementById('chunkSize');
  const chunkOverlap = document.getElementById('chunkOverlap');

  // 召回设置
  const retrievalMode = document.getElementById('retrievalMode');
  const retrievalTopK = document.getElementById('retrievalTopK');
  const retrievalThreshold = document.getElementById('retrievalThreshold');
  const retrievalMaxContextChars = document.getElementById('retrievalMaxContextChars');
  const topKGroup = document.getElementById('topKGroup');
  const thresholdGroup = document.getElementById('thresholdGroup');
  const retrievalModeDesc = document.getElementById('retrievalModeDesc');

  const vectorStoreType = document.getElementById('vectorStoreType');
  const remoteVectorConfig = document.getElementById('remoteVectorConfig');
  const vectorUrl = document.getElementById('vectorUrl');
  const vectorApiKey = document.getElementById('vectorApiKey');
  const vectorCollection = document.getElementById('vectorCollection');

  const llmBackend = document.getElementById('llmBackend');
  const openaiLlmConfig = document.getElementById('openaiLlmConfig');
  const ollamaLlmConfig = document.getElementById('ollamaLlmConfig');
  const openaiPreset = document.getElementById('openaiPreset');
  const openaiBaseUrl = document.getElementById('openaiBaseUrl');
  const openaiApiKey = document.getElementById('openaiApiKey');
  const openaiApiKeyLabel = document.getElementById('openaiApiKeyLabel');
  const openaiApiKeyHelp = document.getElementById('openaiApiKeyHelp');
  const openaiModel = document.getElementById('openaiModel');
  const openaiModelSelect = document.getElementById('openaiModelSelect');
  const openaiModelDropdown = document.getElementById('openaiModelDropdown');
  const openaiThinkingGroup = document.getElementById('openaiThinkingGroup');
  const openaiEnableThinking = document.getElementById('openaiEnableThinking');
  const openaiThinkingHelp = document.getElementById('openaiThinkingHelp');
  const ollamaBaseUrl = document.getElementById('ollamaBaseUrl');
  const ollamaModel = document.getElementById('ollamaModel');

  // ---- 本地软件对接 ----
  const localAppEnabled = document.getElementById('localAppEnabled');
  const localAppBaseUrl = document.getElementById('localAppBaseUrl');
  const localAppPushOnSave = document.getElementById('localAppPushOnSave');
  const localAppAutoPush = document.getElementById('localAppAutoPush');
  const localAppInterval = document.getElementById('localAppInterval');
  const testLocalAppBtn = document.getElementById('testLocalAppBtn');
  const refreshLocalAppStatsBtn = document.getElementById('refreshLocalAppStatsBtn');
  const resetLocalAppPushedBtn = document.getElementById('resetLocalAppPushedBtn');

  // ---- 厂商清单（从 models.json 加载） ----
  let modelsCatalog = null;

  // ---- 未保存提示：表单快照 ----
  let formSnapshot = '';
  // 向量库保存的额外结果（清空旧后端 / 重建新后端），用于保存后的 toast 提示
  let vectorSaveExtra = null;
  function serializeForm() {
    return JSON.stringify({
      platformDeepseek: platformDeepseek.checked,
      platformQianwen: platformQianwen.checked,
      platformFudan: platformFudan.checked,
      platformDoubao: platformDoubao.checked,
      platformKimi: platformKimi.checked,
      platformYuanbao: platformYuanbao.checked,
      platformWenxin: platformWenxin.checked,
      embeddingProvider: embeddingProvider.value,
      embeddingModel: embeddingModel.value,
      dashscopeEmbeddingKey: dashscopeEmbeddingKey.value,
      includeThinking: includeThinking.checked,
      includeSearch: includeSearch.checked,
      chunkSize: chunkSize.value,
      chunkOverlap: chunkOverlap.value,
      retrievalMode: retrievalMode.value,
      retrievalTopK: retrievalTopK.value,
      retrievalThreshold: retrievalThreshold.value,
      retrievalMaxContextChars: retrievalMaxContextChars.value,
      vectorStoreType: vectorStoreType.value,
      vectorUrl: vectorUrl.value,
      vectorApiKey: vectorApiKey.value,
      vectorCollection: vectorCollection.value,
      llmBackend: llmBackend.value,
      openaiPreset: openaiPreset.value,
      openaiBaseUrl: openaiBaseUrl.value,
      openaiApiKey: openaiApiKey.value,
      openaiModel: openaiModel.value,
      openaiEnableThinking: openaiEnableThinking.checked,
      ollamaBaseUrl: ollamaBaseUrl.value,
      ollamaModel: ollamaModel.value,
      localAppEnabled: localAppEnabled.checked,
      localAppBaseUrl: localAppBaseUrl.value,
      localAppPushOnSave: localAppPushOnSave.checked,
      localAppAutoPush: localAppAutoPush.checked,
      localAppInterval: localAppInterval.value
    });
  }
  function isFormDirty() {
    return formSnapshot !== '' && serializeForm() !== formSnapshot;
  }

  // ---- 加载设置（先加载厂商清单，再加载用户配置） ----
  loadModelsCatalog().then(() => loadSettings());

  // ---- 加载 models.json 厂商清单 ----
  async function loadModelsCatalog() {
    try {
      const url = chrome.runtime.getURL('models.json');
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      modelsCatalog = await resp.json();
    } catch (e) {
      console.error('[Settings] 加载 models.json 失败:', e);
      modelsCatalog = { llmProviders: [], embeddingProviders: [] };
    }

    // 填充 Embedding 厂商下拉（含"自定义"选项）
    embeddingProvider.innerHTML = '<option value="">自定义（手动填写下方字段）</option>';
    for (const p of (modelsCatalog.embeddingProviders || [])) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      embeddingProvider.appendChild(opt);
    }

    // 填充 OpenAI 兼容厂商预设下拉（含 DashScope，已统一走 OpenAI 兼容端点）
    openaiPreset.innerHTML = '<option value="">自定义（手动填写下方字段）</option>';
    for (const p of (modelsCatalog.llmProviders || [])) {
      if (p.backend !== 'openai') continue;
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      openaiPreset.appendChild(opt);
    }
  }

  // 根据 OpenAI 预设厂商更新 BaseUrl、API Key 标签、模型列表、思考开关
  function applyOpenaiPreset(providerId) {
    if (!modelsCatalog) return;
    const provider = (modelsCatalog.llmProviders || []).find(p => p.id === providerId);
    // 重置下拉选项
    openaiModelDropdown.innerHTML = '';
    if (!provider) {
      // 自定义：清空思考开关
      openaiThinkingGroup.style.display = 'none';
      openaiApiKeyLabel.textContent = 'API Key';
      openaiApiKeyHelp.textContent = '';
      return;
    }
    // 自动填充 baseUrl（仅当用户当前 baseUrl 为空或与其它预设匹配时覆盖）
    if (provider.baseUrl) {
      openaiBaseUrl.value = provider.baseUrl;
    }
    // 更新 API Key 标签
    if (provider.apiKeyLabel) openaiApiKeyLabel.textContent = provider.apiKeyLabel;
    openaiApiKeyHelp.innerHTML = provider.apiKeyUrl
      ? `在 <a href="${provider.apiKeyUrl}" target="_blank">${provider.apiKeyUrl}</a> 获取`
      : '';

    // 填充模型下拉选项
    for (const m of (provider.models || [])) {
      const opt = document.createElement('div');
      opt.className = 'model-option';
      opt.dataset.value = m.id;
      opt.innerHTML = `<span class="model-name">${m.name}</span><span class="model-id">${m.id}</span>`;
      openaiModelDropdown.appendChild(opt);
    }

    // 思考开关
    if (provider.supportsThinking) {
      openaiThinkingGroup.style.display = '';
      // 选预设后默认按模型默认值设置
      // 自定义模型 ID（如豆包 Endpoint ID ep-xxx）匹配不上时，用 provider.fallbackThinking
      const curModel = (provider.models || []).find(m => m.id === openaiModel.value);
      const thinking = curModel?.thinking || provider.fallbackThinking || 'none';
      if (thinking === 'only') {
        openaiEnableThinking.checked = true;
        openaiEnableThinking.disabled = true;
        openaiThinkingHelp.textContent = '该模型为仅思考模式，无法关闭';
      } else if (thinking === 'hybrid') {
        openaiEnableThinking.disabled = false;
        openaiEnableThinking.checked = curModel?.thinkingDefault ?? true;
        openaiThinkingHelp.textContent = curModel
          ? '混合思考模式，可切换开关'
          : '自定义模型（按混合思考模式处理），可切换开关';
      } else {
        openaiEnableThinking.disabled = false;
        openaiThinkingHelp.textContent = '当前模型不支持思考';
      }
    } else {
      openaiThinkingGroup.style.display = 'none';
    }
  }

  // OpenAI 区模型输入变化时，根据预设厂商更新思考开关
  function updateOpenaiThinkingByModel() {
    if (!modelsCatalog) return;
    const providerId = openaiPreset.value;
    if (!providerId) return;
    const provider = (modelsCatalog.llmProviders || []).find(p => p.id === providerId);
    if (!provider || !provider.supportsThinking) return;
    // 自定义模型 ID（如豆包 Endpoint ID ep-xxx）匹配不上时，用 provider.fallbackThinking
    const curModel = (provider.models || []).find(m => m.id === openaiModel.value);
    const thinking = curModel?.thinking || provider.fallbackThinking || 'none';
    if (thinking === 'only') {
      openaiEnableThinking.checked = true;
      openaiEnableThinking.disabled = true;
      openaiThinkingHelp.textContent = '该模型为仅思考模式，无法关闭';
    } else if (thinking === 'hybrid') {
      openaiEnableThinking.disabled = false;
      if (!openaiEnableThinking.dataset.userTouched) {
        openaiEnableThinking.checked = curModel?.thinkingDefault ?? true;
      }
      openaiThinkingHelp.textContent = curModel
        ? '混合思考模式，可切换开关'
        : '自定义模型（按混合思考模式处理），可切换开关';
    } else {
      openaiEnableThinking.disabled = false;
      openaiThinkingHelp.textContent = '当前模型不支持思考';
    }
  }

  // ---- 事件绑定 ----
  backBtn.addEventListener('click', () => {
    if (isFormDirty() && !confirm('有未保存的修改，确定离开吗？')) return;
    window.location.href = 'popup.html';
  });

  vectorStoreType.addEventListener('change', () => {
    remoteVectorConfig.style.display = vectorStoreType.value !== 'local' ? 'block' : 'none';
    updateVectorHelpLink();
  });

  llmBackend.addEventListener('change', () => {
    openaiLlmConfig.style.display = llmBackend.value === 'openai' ? 'block' : 'none';
    ollamaLlmConfig.style.display = llmBackend.value === 'ollama' ? 'block' : 'none';
  });

  // Embedding 厂商切换：更新 API Key 标签和模型下拉
  embeddingProvider.addEventListener('change', () => {
    if (!modelsCatalog) return;
    const provider = (modelsCatalog.embeddingProviders || []).find(p => p.id === embeddingProvider.value);
    // 自定义厂商：清空预设字段，保留用户手填
    if (!provider) {
      embeddingKeyLabel.textContent = 'API Key';
      embeddingKeyHelp.innerHTML = '';
      embeddingModelDropdown.innerHTML = '';
      embeddingModel.value = '';
      updateEmbeddingModelHelp();
      return;
    }
    if (provider.apiKeyLabel) embeddingKeyLabel.textContent = provider.apiKeyLabel;
    embeddingKeyHelp.innerHTML = provider.apiKeyUrl
      ? `在 <a href="${provider.apiKeyUrl}" target="_blank">${provider.apiKeyUrl}</a> 获取`
      : '';
    // 自动填充 baseUrl（用户可手动修改）
    embeddingBaseUrl.value = provider.baseUrl || '';
    // 重填模型下拉选项
    embeddingModelDropdown.innerHTML = '';
    embeddingModel.value = '';
    for (const m of (provider.models || [])) {
      const opt = document.createElement('div');
      opt.className = 'model-option';
      opt.dataset.value = m.id;
      opt.innerHTML = `<span class="model-name">${m.name}</span><span class="model-id">${m.id}</span>`;
      embeddingModelDropdown.appendChild(opt);
    }
    updateEmbeddingModelHelp();
  });

  // ---- Embedding 模型自定义下拉交互 ----
  let embDropdownItems = [];

  function renderEmbeddingOptions(keyword) {
    const provider = (modelsCatalog?.embeddingProviders || []).find(p => p.id === embeddingProvider.value);
    embeddingModelDropdown.innerHTML = '';
    if (!provider) return;
    const kw = (keyword || '').toLowerCase().trim();
    const models = (provider.models || []).filter(m =>
      !kw || m.id.toLowerCase().includes(kw) || m.name.toLowerCase().includes(kw)
    );
    if (models.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'model-option empty';
      empty.textContent = '无匹配模型，可直接输入 Endpoint ID';
      embeddingModelDropdown.appendChild(empty);
      embDropdownItems = [];
      return;
    }
    embDropdownItems = models.map(m => {
      const opt = document.createElement('div');
      opt.className = 'model-option';
      opt.dataset.value = m.id;
      opt.innerHTML = `<span class="model-name">${m.name}</span><span class="model-id">${m.id}</span>`;
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault();
        embeddingModel.value = m.id;
        closeEmbeddingDropdown();
        updateEmbeddingModelHelp();
      });
      embeddingModelDropdown.appendChild(opt);
      return opt;
    });
  }

  function openEmbeddingDropdown() {
    if (!embeddingProvider.value) return;
    renderEmbeddingOptions(embeddingModel.value);
    embeddingModelSelect.classList.add('open');
  }

  function closeEmbeddingDropdown() {
    embeddingModelSelect.classList.remove('open');
  }

  embeddingModel.addEventListener('focus', openEmbeddingDropdown);
  embeddingModel.addEventListener('click', openEmbeddingDropdown);
  embeddingModel.addEventListener('input', () => {
    if (embeddingModelSelect.classList.contains('open')) {
      renderEmbeddingOptions(embeddingModel.value);
    }
    updateEmbeddingModelHelp();
  });
  embeddingModel.addEventListener('keydown', (e) => {
    if (!embeddingModelSelect.classList.contains('open')) return;
    if (e.key === 'Escape') {
      closeEmbeddingDropdown();
    } else if (e.key === 'Enter' && embDropdownItems.length > 0) {
      e.preventDefault();
      embeddingModel.value = embDropdownItems[0].dataset.value;
      closeEmbeddingDropdown();
      updateEmbeddingModelHelp();
    }
  });
  document.addEventListener('click', (e) => {
    if (!embeddingModelSelect.contains(e.target)) {
      closeEmbeddingDropdown();
    }
  });

  function updateEmbeddingModelHelp() {
    const provider = (modelsCatalog?.embeddingProviders || []).find(p => p.id === embeddingProvider.value);
    if (!provider) {
      embeddingModelHelp.textContent = embeddingModel.value
        ? `自定义模型（OpenAI 兼容，标准 /embeddings 端点，期望 1024 维）`
        : '';
      return;
    }
    const modelMeta = (provider.models || []).find(m => m.id === embeddingModel.value);
    // 自定义 Endpoint ID 时用 provider 级别 fallback
    const dim = modelMeta?.dimension || provider.fallbackDimension || 1024;
    const mm = modelMeta?.multimodal || provider.fallbackMultimodal || false;
    const dp = modelMeta?.dimensionsParam || provider.fallbackDimensionsParam || false;
    let text = `维度: ${dim}`;
    if (mm) text += '；多模态（支持文本+图片+视频）';
    if (dp) text += '；将通过 dimensions 参数指定为 1024';
    if (!modelMeta) text += '；自定义模型 ID';
    embeddingModelHelp.textContent = text;
  }

  // OpenAI 预设厂商切换：自动填充
  openaiPreset.addEventListener('change', () => {
    applyOpenaiPreset(openaiPreset.value);
  });
  openaiModel.addEventListener('input', updateOpenaiThinkingByModel);
  openaiModel.addEventListener('change', updateOpenaiThinkingByModel);

  // ---- 自定义模型下拉组件交互 ----
  // 当前过滤后的选项列表（缓存，供键盘导航用）
  let modelDropdownItems = [];

  // 渲染下拉选项（根据关键词过滤）
  function renderModelOptions(keyword) {
    const providerId = openaiPreset.value;
    const provider = (modelsCatalog?.llmProviders || []).find(p => p.id === providerId);
    openaiModelDropdown.innerHTML = '';
    if (!provider) return;
    const kw = (keyword || '').toLowerCase().trim();
    const models = (provider.models || []).filter(m =>
      !kw || m.id.toLowerCase().includes(kw) || m.name.toLowerCase().includes(kw)
    );
    if (models.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'model-option empty';
      empty.textContent = '无匹配模型，可直接输入自定义 ID';
      openaiModelDropdown.appendChild(empty);
      modelDropdownItems = [];
      return;
    }
    modelDropdownItems = models.map(m => {
      const opt = document.createElement('div');
      opt.className = 'model-option';
      opt.dataset.value = m.id;
      opt.innerHTML = `<span class="model-name">${m.name}</span><span class="model-id">${m.id}</span>`;
      // 点击选中
      opt.addEventListener('mousedown', (e) => {
        e.preventDefault(); // 防止 input 失焦
        openaiModel.value = m.id;
        closeModelDropdown();
        updateOpenaiThinkingByModel();
      });
      openaiModelDropdown.appendChild(opt);
      return opt;
    });
  }

  function openModelDropdown() {
    if (!openaiPreset.value) return; // 未选厂商时不展开
    renderModelOptions(openaiModel.value);
    openaiModelSelect.classList.add('open');
  }

  function closeModelDropdown() {
    openaiModelSelect.classList.remove('open');
  }

  // 点击 input 或箭头区域展开/关闭
  openaiModel.addEventListener('focus', openModelDropdown);
  openaiModel.addEventListener('click', openModelDropdown);

  // 输入时实时过滤（已展开则刷新选项）
  openaiModel.addEventListener('input', () => {
    if (openaiModelSelect.classList.contains('open')) {
      renderModelOptions(openaiModel.value);
    }
  });

  // 键盘导航：Enter 选中第一个匹配项，Escape 关闭
  openaiModel.addEventListener('keydown', (e) => {
    if (!openaiModelSelect.classList.contains('open')) return;
    if (e.key === 'Escape') {
      closeModelDropdown();
    } else if (e.key === 'Enter' && modelDropdownItems.length > 0) {
      e.preventDefault();
      openaiModel.value = modelDropdownItems[0].dataset.value;
      closeModelDropdown();
      updateOpenaiThinkingByModel();
    }
  });

  // 点击组件外部关闭下拉
  document.addEventListener('click', (e) => {
    if (!openaiModelSelect.contains(e.target)) {
      closeModelDropdown();
    }
  });
  openaiEnableThinking.addEventListener('change', () => {
    openaiEnableThinking.dataset.userTouched = '1';
  });

  // 召回模式切换：按模式显示/隐藏 Top-K 和阈值输入框，并更新说明
  function updateRetrievalModeUI() {
    const mode = retrievalMode.value;
    const descs = {
      topk: '仅按 Top-K 召回前 N 条候选，不应用相似度过滤',
      threshold: '拉取大量候选（Top-K=100）后只保留相似度达标的，可能召回较多或较少',
      combined: '先按 Top-K 召回候选，再过滤掉相似度低于阈值的结果'
    };
    retrievalModeDesc.textContent = descs[mode] || descs.combined;
    topKGroup.style.display = (mode === 'topk' || mode === 'combined') ? 'block' : 'none';
    thresholdGroup.style.display = (mode === 'threshold' || mode === 'combined') ? 'block' : 'none';
  }
  retrievalMode.addEventListener('change', updateRetrievalModeUI);

  // 切片重叠必须小于切片大小：实时校验提示
  chunkSize.addEventListener('input', () => {
    const size = parseInt(chunkSize.value, 10);
    const overlap = parseInt(chunkOverlap.value, 10);
    if (!isNaN(size) && !isNaN(overlap) && overlap >= size) {
      chunkOverlap.setCustomValidity('重叠必须小于切片大小');
      chunkOverlap.reportValidity();
    } else {
      chunkOverlap.setCustomValidity('');
    }
  });
  chunkOverlap.addEventListener('input', () => {
    chunkSize.dispatchEvent(new Event('input'));
  });

  saveBtn.addEventListener('click', saveSettings);
  testEmbeddingBtn.addEventListener('click', testEmbedding);
  testLlmBtn.addEventListener('click', testLLM);
  testVectorConnectionBtn.addEventListener('click', testVectorConnection);
  rebuildIndexBtn.addEventListener('click', rebuildIndex);
  testLocalAppBtn.addEventListener('click', testLocalApp);
  refreshLocalAppStatsBtn.addEventListener('click', loadLocalAppStats);
  resetLocalAppPushedBtn.addEventListener('click', resetLocalAppPushed);

  // ---- 顶部导航条 ----
  const navStorageBtn = document.getElementById('navStorageBtn');
  const navDataBtn = document.getElementById('navDataBtn');
  const storageSection = document.querySelector('.storage-info-section');
  const dataSection = document.querySelector('.danger-zone');

  // 点击跳转到对应区域（scroll-margin-top 已配置，标题不会被 sticky 遮挡）
  navStorageBtn.addEventListener('click', () => {
    storageSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  navDataBtn.addEventListener('click', () => {
    dataSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // 滚动监听：当「存储位置」或「数据管理」标题滚动到 header 下方时，隐藏「保存设置」按钮
  let storageVisible = false;
  let dataVisible = false;
  const sectionObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.target === storageSection) storageVisible = entry.isIntersecting;
      else if (entry.target === dataSection) dataVisible = entry.isIntersecting;
    });
    saveBtn.classList.toggle('hidden', storageVisible || dataVisible);
  }, {
    // 顶部排除 sticky header（约 36px）；底部 -100% 把 root 收缩成 header 下边缘的一条线，
    // 只有当 section 顶部真正抵达 header 下方时才触发隐藏
    rootMargin: '-36px 0px -100% 0px',
    threshold: 0
  });
  sectionObserver.observe(storageSection);
  sectionObserver.observe(dataSection);

  const clearConversationsBtn = document.getElementById('clearConversationsBtn');
  const resetSettingsBtn = document.getElementById('resetSettingsBtn');
  clearConversationsBtn.addEventListener('click', clearConversations);
  resetSettingsBtn.addEventListener('click', resetSettings);

  // ---- 帮助弹窗 ----
  const vectorHelpLink = document.getElementById('vectorHelpLink');
  const vectorHelpLinkText = document.getElementById('vectorHelpLinkText');
  const helpOverlay = document.getElementById('helpOverlay');
  const helpTitle = document.getElementById('helpTitle');
  const helpBody = document.getElementById('helpBody');
  const helpClose = document.getElementById('helpClose');

  // 各向量库对应的帮助文档映射
  const VECTOR_HELP_MAP = {
    chroma:    { title: 'ChromaDB 部署说明',                file: 'docs/chroma-setup.md' },
    milvus:    { title: 'Milvus 部署说明',                  file: 'docs/milvus-setup.md' },
    pgvector:  { title: 'PostgreSQL + pgvector 部署说明',   file: 'docs/pgvector-setup.md' },
    supabase:  { title: 'Supabase 部署说明',                file: 'docs/supabase-setup.md' },
    qdrant:    { title: 'Qdrant 部署说明',                  file: 'docs/qdrant-setup.md' }
  };

  // 根据当前选中的向量库类型，显示/隐藏帮助链接
  function updateVectorHelpLink() {
    const type = vectorStoreType.value;
    const info = VECTOR_HELP_MAP[type];
    if (info) {
      vectorHelpLink.style.display = 'block';
      vectorHelpLinkText.textContent = `查看 ${info.title}`;
    } else {
      vectorHelpLink.style.display = 'none';
    }
  }

  vectorHelpLink.addEventListener('click', (e) => {
    e.preventDefault();
    openHelp(vectorStoreType.value);
  });
  helpClose.addEventListener('click', closeHelp);
  helpOverlay.addEventListener('click', (e) => {
    if (e.target === helpOverlay) closeHelp();
  });

  // ---- 存储位置信息 ----
  const copyExtensionIdBtn = document.getElementById('copyExtensionIdBtn');
  const openExtensionsBtn = document.getElementById('openExtensionsBtn');
  const refreshStorageInfoBtn = document.getElementById('refreshStorageInfoBtn');
  const dbDetailToggle = document.getElementById('dbDetailToggle');
  const dbDetailBody = document.getElementById('dbDetailBody');
  const filePathToggle = document.getElementById('filePathToggle');
  const filePathBody = document.getElementById('filePathBody');
  const devtoolsToggle = document.getElementById('devtoolsToggle');
  const devtoolsBody = document.getElementById('devtoolsBody');

  copyExtensionIdBtn.addEventListener('click', copyExtensionId);
  openExtensionsBtn.addEventListener('click', openExtensionsPage);
  refreshStorageInfoBtn.addEventListener('click', loadStorageInfo);

  // 折叠区域切换
  dbDetailToggle.addEventListener('click', () => toggleCollapse(dbDetailToggle, dbDetailBody));
  filePathToggle.addEventListener('click', () => toggleCollapse(filePathToggle, filePathBody));
  devtoolsToggle.addEventListener('click', () => toggleCollapse(devtoolsToggle, devtoolsBody));

  // 页面加载时拉取一次存储信息
  loadStorageInfo();

  // ---- 向量库数据管理 ----
  const refreshVectorStatsBtn = document.getElementById('refreshVectorStatsBtn');
  const clearVectorStoreBtn = document.getElementById('clearVectorStoreBtn');
  const remoteConfigToggle = document.getElementById('remoteConfigToggle');
  const remoteConfigBody = document.getElementById('remoteConfigBody');

  refreshVectorStatsBtn.addEventListener('click', loadVectorStoreStats);
  clearVectorStoreBtn.addEventListener('click', clearVectorStore);
  remoteConfigToggle.addEventListener('click', () => toggleCollapse(remoteConfigToggle, remoteConfigBody));

  // 页面加载时拉取一次向量库统计
  loadVectorStoreStats();

  // ---- 加载设置 ----
  async function loadSettings() {
    // 平台提取设置
    const platformResp = await sendMessage({ type: 'GET_SETTINGS', category: 'platforms' });
    if (platformResp) {
      platformDeepseek.checked = platformResp.deepseek === true;
      platformQianwen.checked = platformResp.qianwen === true;
      platformFudan.checked = platformResp.fudan !== false;
      platformDoubao.checked = platformResp.doubao === true;
      platformKimi.checked = platformResp.kimi === true;
      platformYuanbao.checked = platformResp.yuanbao === true;
      platformWenxin.checked = platformResp.wenxin === true;
    }

    // 平台提取模式（网络拦截 / DOM提取）
    const modeResp = await sendMessage({ type: 'GET_SETTINGS', category: 'platformModes' });
    if (modeResp) {
      const setMode = (platform, mode) => {
        const radio = document.querySelector(`input[name="${platform}-mode"][value="${mode}"]`);
        if (radio) radio.checked = true;
      };
      setMode('deepseek', modeResp.deepseek || 'dom');
      setMode('qianwen', modeResp.qianwen || 'dom');
      setMode('fudan', modeResp.fudan || 'dom');
      setMode('doubao', modeResp.doubao || 'dom');
      // Kimi/元宝/文心 固定 DOM，无 radio 可设
    }

    // Embedding 设置
    const embResp = await sendMessage({ type: 'GET_SETTINGS', category: 'embedding' });
    if (embResp) {
      // 厂商：兼容旧数据（无 provider 字段时按 model 推断 dashscope）
      const savedProvider = embResp.provider || 'dashscope';
      if (embeddingProvider) {
        embeddingProvider.value = savedProvider;
        // 触发 change 重填模型下拉与 API Key 标签
        embeddingProvider.dispatchEvent(new Event('change'));
      }
      // 设置已保存的模型（需在厂商 change 重填下拉后）
      if (embResp.model) {
        embeddingModel.value = embResp.model;
      }
      // 若厂商未匹配上（旧 model 不在当前厂商列表），回退到 dashscope
      if (!embeddingModel.value && embResp.model) {
        embeddingProvider.value = 'dashscope';
        embeddingProvider.dispatchEvent(new Event('change'));
        embeddingModel.value = embResp.model;
      }
      updateEmbeddingModelHelp();
      dashscopeEmbeddingKey.value = embResp.dashscopeKey || embResp.apiKey || '';
      // 恢复用户自定义 baseUrl（若有）
      if (embResp.baseUrl) {
        embeddingBaseUrl.value = embResp.baseUrl;
      }
      includeThinking.checked = embResp.includeThinking === true;
      includeSearch.checked = embResp.includeSearch === true;
      chunkSize.value = embResp.chunkSize || 500;
      chunkOverlap.value = embResp.chunkOverlap ?? 50;
    }

    // 召回设置
    const retResp = await sendMessage({ type: 'GET_SETTINGS', category: 'retrieval' });
    if (retResp) {
      retrievalMode.value = retResp.mode || 'combined';
      retrievalTopK.value = retResp.topK || 20;
      retrievalThreshold.value = retResp.scoreThreshold ?? 0.3;
      retrievalMaxContextChars.value = retResp.maxContextChars || 8000;
      updateRetrievalModeUI();
    }

    // 向量库设置
    const vecResp = await sendMessage({ type: 'GET_SETTINGS', category: 'vectorStore' });
    if (vecResp) {
      const config = vecResp.config || {};
      vectorStoreType.value = vecResp.backend === 'local' ? 'local' : (config.type || 'local');
      vectorUrl.value = config.url || '';
      vectorApiKey.value = config.apiKey || '';
      vectorCollection.value = config.collection || '';
      remoteVectorConfig.style.display = vecResp.backend !== 'local' ? 'block' : 'none';
      updateVectorHelpLink();
    }

    // LLM 设置
    const llmResp = await sendMessage({ type: 'GET_SETTINGS', category: 'llm' });
    if (llmResp) {
      const config = llmResp.config || {};
      // 兼容旧数据：dashscope 后端已合并到 openai
      const backend = llmResp.backend === 'dashscope' ? 'openai' : (llmResp.backend || 'openai');
      // 旧 dashscope 后端的配置需要补全 baseUrl/provider
      const llmConfig = llmResp.backend === 'dashscope' ? {
        provider: 'dashscope',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: config.apiKey || '',
        model: config.model || '',
        enableThinking: config.enableThinking
      } : config;

      llmBackend.value = backend;

      // OpenAI 兼容：根据已保存的 baseUrl 反向匹配预设厂商
      openaiBaseUrl.value = llmConfig.baseUrl || '';
      openaiApiKey.value = llmConfig.apiKey || '';
      openaiModel.value = llmConfig.model || '';
      // 优先用已保存的 provider，否则按 baseUrl 反向匹配
      const matchedPreset = llmConfig.provider
        ? { id: llmConfig.provider }
        : (modelsCatalog?.llmProviders || []).find(p =>
            p.backend === 'openai' && p.baseUrl && p.baseUrl === llmConfig.baseUrl
          );
      openaiPreset.value = matchedPreset?.id || '';
      applyOpenaiPreset(openaiPreset.value);
      // 应用预设后模型可能被覆盖，恢复用户保存的模型
      if (llmConfig.model) openaiModel.value = llmConfig.model;
      if (llmConfig.enableThinking !== undefined) {
        openaiEnableThinking.checked = !!llmConfig.enableThinking;
        openaiEnableThinking.dataset.userTouched = '1';
      }
      updateOpenaiThinkingByModel();

      ollamaBaseUrl.value = config.baseUrl || '';
      ollamaModel.value = config.model || '';

      openaiLlmConfig.style.display = backend === 'openai' ? 'block' : 'none';
      ollamaLlmConfig.style.display = backend === 'ollama' ? 'block' : 'none';
    }

    // 本地软件对接设置
    const localAppResp = await sendMessage({ type: 'GET_SETTINGS', category: 'localApp' });
    if (localAppResp && !localAppResp.error) {
      localAppEnabled.checked = !!localAppResp.enabled;
      localAppBaseUrl.value = localAppResp.baseUrl || 'http://localhost:8788';
      localAppPushOnSave.checked = localAppResp.pushOnSave !== false; // 默认 true
      localAppAutoPush.checked = !!localAppResp.autoPush;
      localAppInterval.value = String(localAppResp.intervalMinutes || 1);
    }

    // 加载已推送统计
    loadLocalAppStats();

    // 加载完成后记录表单快照，用于未保存提示
    formSnapshot = serializeForm();
  }

  // ---- 保存设置 ----
  async function saveSettings() {
    // 平台提取设置
    await sendMessage({
      type: 'SAVE_SETTINGS',
      category: 'platforms',
      settings: {
        deepseek: platformDeepseek.checked,
        qianwen: platformQianwen.checked,
        fudan: platformFudan.checked,
        doubao: platformDoubao.checked,
        kimi: platformKimi.checked,
        yuanbao: platformYuanbao.checked,
        wenxin: platformWenxin.checked
      }
    });

    // 平台提取模式（网络拦截 / DOM提取）
    const getMode = (platform) => {
      const radio = document.querySelector(`input[name="${platform}-mode"]:checked`);
      return radio ? radio.value : 'dom';
    };
    await sendMessage({
      type: 'SAVE_SETTINGS',
      category: 'platformModes',
      settings: {
        deepseek: getMode('deepseek'),
        qianwen: getMode('qianwen'),
        fudan: getMode('fudan'),
        doubao: getMode('doubao'),
        kimi: 'dom',
        yuanbao: 'dom',
        wenxin: 'dom'
      }
    });

    // Embedding
    // 切片重叠必须严格小于切片大小，提交前再校验一次
    const sizeVal = parseInt(chunkSize.value, 10);
    const overlapVal = parseInt(chunkOverlap.value, 10);
    if (isNaN(sizeVal) || sizeVal < 100) {
      showToast('切片大小需为不小于 100 的整数');
      return false;
    }
    if (isNaN(overlapVal) || overlapVal < 0) {
      showToast('切片重叠需为不小于 0 的整数');
      return false;
    }
    if (overlapVal >= sizeVal) {
      showToast('切片重叠必须小于切片大小');
      return false;
    }
    await sendMessage({
      type: 'SAVE_SETTINGS',
      category: 'embedding',
      settings: {
        provider: embeddingProvider.value,
        model: embeddingModel.value,
        baseUrl: embeddingBaseUrl.value.trim(),
        apiKey: dashscopeEmbeddingKey.value,
        dashscopeKey: dashscopeEmbeddingKey.value, // 兼容旧代码读取
        includeThinking: includeThinking.checked,
        includeSearch: includeSearch.checked,
        chunkSize: sizeVal,
        chunkOverlap: overlapVal
      }
    });

    // 召回设置
    const retTopK = parseInt(retrievalTopK.value, 10);
    const retThreshold = parseFloat(retrievalThreshold.value);
    const retMaxCtx = parseInt(retrievalMaxContextChars.value, 10);
    await sendMessage({
      type: 'SAVE_SETTINGS',
      category: 'retrieval',
      settings: {
        mode: retrievalMode.value,
        topK: (isNaN(retTopK) || retTopK < 1) ? 20 : retTopK,
        scoreThreshold: (isNaN(retThreshold) || retThreshold < 0) ? 0 : retThreshold,
        maxContextChars: (isNaN(retMaxCtx) || retMaxCtx < 500) ? 8000 : retMaxCtx
      }
    });

    // 向量库（含后端切换询问，测试连通性时复用此函数的静默模式）
    const vecResult = await saveVectorStoreSettings({ interactive: true });
    vectorSaveExtra = vecResult.extra;

    // LLM
    const llmType = llmBackend.value;
    let llmConfig = {};
    switch (llmType) {
      case 'openai':
        llmConfig = {
          provider: openaiPreset.value || '',
          baseUrl: openaiBaseUrl.value,
          apiKey: openaiApiKey.value,
          model: openaiModel.value,
          enableThinking: openaiEnableThinking.checked && !openaiEnableThinking.disabled
        };
        break;
      case 'ollama':
        llmConfig = { baseUrl: ollamaBaseUrl.value, model: ollamaModel.value };
        break;
    }
    await sendMessage({
      type: 'SAVE_SETTINGS',
      category: 'llm',
      settings: { backend: llmType, config: llmConfig }
    });

    // 本地软件对接
    const localAppIntervalVal = parseInt(localAppInterval.value, 10);
    await sendMessage({
      type: 'SAVE_SETTINGS',
      category: 'localApp',
      settings: {
        enabled: localAppEnabled.checked,
        baseUrl: localAppBaseUrl.value.trim() || 'http://localhost:8788',
        pushOnSave: localAppPushOnSave.checked,
        autoPush: localAppAutoPush.checked,
        intervalMinutes: (isNaN(localAppIntervalVal) || localAppIntervalVal < 1) ? 1 : localAppIntervalVal
      }
    });

    // 保存成功后更新快照，避免返回时误报未保存
    formSnapshot = serializeForm();

    // 根据向量库切换的额外结果拼接提示
    let toastMsg = '设置已保存';
    if (vectorSaveExtra) {
      if (vectorSaveExtra.cleared) {
        toastMsg += vectorSaveExtra.cleared.success === false
          ? `；旧后端清空失败: ${vectorSaveExtra.cleared.error || '未知错误'}`
          : '；旧后端已清空';
      }
      if (vectorSaveExtra.rebuilt) {
        toastMsg += vectorSaveExtra.rebuilt.success
          ? `；新后端索引已重建（${vectorSaveExtra.rebuilt.count} 条）`
          : `；索引重建失败: ${vectorSaveExtra.rebuilt.error || '未知错误'}`;
      }
    }
    toastMsg += '；更改需刷新已打开的 AI 平台网页才会生效';
    showToast(toastMsg);
    vectorSaveExtra = null;

    // 保存完成后，若向量库为远程且尚未持有该域权限，则申请
    // 放在最后：权限弹窗会导致 popup 失焦关闭，但此时配置已持久化，用户重开即可继续
    const vecType2 = vectorStoreType.value;
    if (vecType2 !== 'local') {
      const origin = urlToOrigin(vectorUrl.value.trim());
      if (origin) {
        const has = await new Promise((r) => chrome.permissions.contains({ origins: [`${origin}/*`] }, r));
        if (!has) {
          // 不强制：用户拒绝也无所谓，配置已保存；下次测试/保存还会再问
          await ensureHostPermission(vectorUrl.value.trim());
        }
      }
    }
    return true;
  }

  // 保存向量库设置；interactive=true 会弹后端切换询问，false（测试连通性用）静默保存
  // 返回 { extra } 供 saveSettings 拼接 toast
  async function saveVectorStoreSettings({ interactive = true } = {}) {
    const vecType = vectorStoreType.value;
    const newVecSettings = {
      backend: vecType === 'local' ? 'local' : 'remote',
      config: vecType === 'local' ? {} : {
        type: vecType,
        url: vectorUrl.value.trim(),
        apiKey: vectorApiKey.value.trim(),
        collection: vectorCollection.value.trim() || 'ai_chat_vectors'
      }
    };

    let clearOld = false;
    let rebuildNew = false;

    if (interactive) {
      // 检测向量库后端是否变化（忽略单独的 apiKey 变化，因为它不改变数据位置）
      const oldVec = await sendMessage({ type: 'GET_SETTINGS', category: 'vectorStore' });
      const oldBackend = oldVec?.backend || 'local';
      const oldConfig = oldVec?.config || {};
      const backendChanged = oldBackend !== newVecSettings.backend ||
        (oldBackend === 'remote' && newVecSettings.backend === 'remote' && (
          oldConfig.type !== newVecSettings.config.type ||
          oldConfig.url !== newVecSettings.config.url ||
          oldConfig.collection !== newVecSettings.config.collection
        ));

      // 后端切换时询问是否清空旧后端、是否为新后端重建索引
      if (backendChanged) {
        clearOld = confirm(
          '检测到向量库后端已切换。\n\n' +
          '旧后端的索引数据不会自动清理，是否清空旧后端的索引？\n\n' +
          '（确定 = 清空旧后端；取消 = 保留旧后端数据）'
        );
        rebuildNew = confirm(
          '是否立即为新后端重建索引？\n\n' +
          '（需要已配置 Embedding API Key，可能耗时较长；取消可稍后手动重建）'
        );
      }
    }

    const extra = await sendMessage({
      type: 'SAVE_SETTINGS',
      category: 'vectorStore',
      settings: {
        ...newVecSettings,
        clearOld,
        rebuildNew
      }
    });

    return { extra };
  }

  // ---- 测试 Embedding ----
  async function testEmbedding() {
    testEmbeddingBtn.disabled = true;
    testEmbeddingBtn.textContent = '保存并测试中...';
    try {
      // 先保存当前设置，保存失败则不进行测试
      const ok = await saveSettings();
      if (!ok) {
        testEmbeddingBtn.disabled = false;
        testEmbeddingBtn.textContent = '测试 Embedding';
        return;
      }
      const resp = await sendMessage({ type: 'TEST_EMBEDDING', text: '你好，这是一个测试' });
      if (resp && resp.success) {
        showToast(`Embedding 测试成功！向量维度: ${resp.dimension}，耗时: ${resp.time}ms`);
      } else {
        showToast(`Embedding 测试失败: ${resp?.error || '未知错误'}`, true);
      }
    } catch (e) {
      showToast(`测试异常: ${e.message}`, true);
    }
    testEmbeddingBtn.disabled = false;
    testEmbeddingBtn.textContent = '测试 Embedding';
  }

  // ---- 测试 LLM ----
  async function testLLM() {
    testLlmBtn.disabled = true;
    testLlmBtn.textContent = '保存并测试中...';
    try {
      // 先保存当前设置，保存失败则不进行测试
      const ok = await saveSettings();
      if (!ok) {
        testLlmBtn.disabled = false;
        testLlmBtn.textContent = '测试 LLM';
        return;
      }
      const resp = await sendMessage({ type: 'TEST_LLM', prompt: '你好，请用一句话介绍自己' });
      if (resp && resp.success) {
        showToast(`LLM 测试成功！回复: ${resp.content.substring(0, 50)}...`);
      } else {
        showToast(`LLM 测试失败: ${resp?.error || '未知错误'}`, true);
      }
    } catch (e) {
      showToast(`测试异常: ${e.message}`, true);
    }
    testLlmBtn.disabled = false;
    testLlmBtn.textContent = '测试 LLM';
  }

  // ---- 测试向量库连通性 ----
  async function testVectorConnection() {
    // 1. 先静默保存向量库配置（不弹后端切换询问），便于用户调试后直接持久化
    testVectorConnectionBtn.disabled = true;
    testVectorConnectionBtn.textContent = '保存并测试中...';
    try {
      await saveVectorStoreSettings({ interactive: false });
      // 同步更新快照，避免返回时误报未保存
      formSnapshot = serializeForm();
    } catch (e) {
      showToast(`保存配置失败: ${e.message}`, true);
      testVectorConnectionBtn.disabled = false;
      testVectorConnectionBtn.textContent = '测试连通性';
      return;
    }

    const config = {
      type: vectorStoreType.value,
      url: vectorUrl.value.trim(),
      apiKey: vectorApiKey.value.trim(),
      collection: vectorCollection.value.trim() || 'ai_chat_vectors'
    };

    // 2. 检查并申请 host 权限（若无权限则弹窗，popup 可能因此关闭，但配置已保存）
    if (config.type !== 'local') {
      const origin = urlToOrigin(config.url);
      if (!origin) {
        showToast('服务地址格式不正确', true);
        testVectorConnectionBtn.disabled = false;
        testVectorConnectionBtn.textContent = '测试连通性';
        return;
      }
      const has = await new Promise((r) => chrome.permissions.contains({ origins: [`${origin}/*`] }, r));
      if (!has) {
        // 弹窗申请：用户允许则继续测试；拒绝则提示后返回
        const granted = await ensureHostPermission(config.url);
        if (!granted) {
          showToast('未授予该域访问权限，无法测试连通性（配置已保存，可稍后再试）', true);
          testVectorConnectionBtn.disabled = false;
          testVectorConnectionBtn.textContent = '测试连通性';
          return;
        }
      }
    }

    // 3. 发起测试请求
    try {
      const resp = await sendMessage({ type: 'TEST_VECTOR_CONNECTION', config });
      if (resp && resp.success) {
        const countText = (resp.count === null || resp.count === undefined)
          ? ''
          : `，向量 ${resp.count} 条`;
        showToast(`连通性测试成功！耗时 ${resp.latency}ms${countText}`);
      } else {
        showToast(`连通性测试失败: ${resp?.error || '未知错误'}`, true);
      }
    } catch (e) {
      showToast(`测试异常: ${e.message}`, true);
    }
    testVectorConnectionBtn.disabled = false;
    testVectorConnectionBtn.textContent = '测试连通性';
  }

  // ---- 重建向量索引 ----
  async function rebuildIndex() {
    if (!confirm('重建向量索引将重新计算所有对话的 embedding，可能需要较长时间。确定继续？')) return;

    rebuildIndexBtn.disabled = true;
    rebuildIndexBtn.textContent = '重建中...';
    try {
      const resp = await sendMessage({ type: 'REBUILD_VECTOR_INDEX' });
      if (resp && resp.success) {
        showToast(`索引重建完成！共处理 ${resp.count} 条消息`);
      } else {
        showToast(`重建失败: ${resp?.error || '未知错误'}`, true);
      }
    } catch (e) {
      showToast(`重建异常: ${e.message}`, true);
    }
    rebuildIndexBtn.disabled = false;
    rebuildIndexBtn.textContent = '重建向量索引';
  }

  // ---- 清空所有对话 ----
  async function clearConversations() {
    if (!confirm('确定要清空所有对话记录吗？此操作不可撤销，关联的向量索引也会被删除。')) return;
    clearConversationsBtn.disabled = true;
    clearConversationsBtn.textContent = '清理中...';
    try {
      const resp = await sendMessage({ type: 'CLEAR_ALL_CONVERSATIONS' });
      if (resp && resp.success) {
        showToast(`已清空所有对话，共删除 ${resp.count} 条`);
        // 同步刷新向量库统计（对话连带向量已清空）
        await loadVectorStoreStats();
      } else {
        showToast(`清空失败: ${resp?.error || '未知错误'}`, true);
      }
    } catch (e) {
      showToast(`操作异常: ${e.message}`, true);
    }
    clearConversationsBtn.disabled = false;
    clearConversationsBtn.textContent = '清空所有对话';
  }

  // ---- 重置全部设置 ----
  async function resetSettings() {
    if (!confirm('确定要重置所有设置为默认值吗？此操作不可撤销。')) return;
    try {
      const resp = await sendMessage({ type: 'RESET_ALL_SETTINGS' });
      if (resp && resp.success) {
        showToast('设置已重置为默认值');
        // 重新加载页面以刷新表单
        setTimeout(() => location.reload(), 500);
      } else {
        showToast(`重置失败: ${resp?.error || '未知错误'}`, true);
      }
    } catch (e) {
      showToast(`操作异常: ${e.message}`, true);
    }
  }

  // ---- 工具函数 ----
  function sendMessage(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (response) => {
        resolve(response);
      });
    });
  }

  // 从 URL 提取 origin（协议+主机+端口），如 "http://1.2.3.4:3000/rest/v1/x" → "http://1.2.3.4:3000"
  function urlToOrigin(rawUrl) {
    try {
      const u = new URL(rawUrl);
      return u.origin;
    } catch (e) {
      return null;
    }
  }

  // 确保扩展拥有目标域的 host 权限；已有则直接返回 true，否则弹窗申请
  // 必须在用户手势（如 click）上下文中调用，否则 chrome.permissions.request 会被拒绝
  async function ensureHostPermission(rawUrl) {
    const origin = urlToOrigin(rawUrl);
    if (!origin) return false;
    const pattern = `${origin}/*`;
    const already = await new Promise((resolve) => {
      chrome.permissions.contains({ origins: [pattern] }, resolve);
    });
    if (already) return true;
    return await new Promise((resolve) => {
      chrome.permissions.request({ origins: [pattern] }, (granted) => {
        resolve(!!granted);
      });
    });
  }

  function showToast(message, isError = false) {
    toast.textContent = message;
    toast.className = `toast show ${isError ? 'error' : 'success'}`;
    setTimeout(() => {
      toast.className = 'toast';
    }, 4500);
  }

  // ---- 存储位置信息相关 ----

  // 格式化字节数为人类可读
  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
  }

  // 折叠/展开
  function toggleCollapse(headerEl, bodyEl) {
    headerEl.classList.toggle('collapsed');
    bodyEl.classList.toggle('collapsed');
  }

  // 加载存储信息
  async function loadStorageInfo() {
    const extIdEl = document.getElementById('storageExtensionId');
    const usageEl = document.getElementById('storageUsage');
    const dbDetailEl = document.getElementById('dbDetailContent');
    const filePathEl = document.getElementById('storageFilePath');

    extIdEl.textContent = '加载中...';
    usageEl.textContent = '加载中...';
    dbDetailEl.textContent = '加载中...';
    filePathEl.textContent = '加载中...';

    try {
      const resp = await sendMessage({ type: 'GET_STORAGE_INFO' });
      if (!resp || resp.error) {
        const msg = resp?.error || '获取失败';
        extIdEl.textContent = msg;
        usageEl.textContent = msg;
        dbDetailEl.textContent = msg;
        filePathEl.textContent = msg;
        return;
      }

      // 扩展 ID
      const extId = resp.extensionId || chrome.runtime.id || '(未知)';
      extIdEl.textContent = extId;

      // 估算占用
      if (resp.usage) {
        const used = formatBytes(resp.usage.usage);
        const quota = formatBytes(resp.usage.quota);
        const pct = resp.usage.quota > 0
          ? ((resp.usage.usage / resp.usage.quota) * 100).toFixed(1)
          : '?';
        usageEl.textContent = `已用 ${used} / 配额 ${quota}（${pct}%）`;
      } else {
        usageEl.textContent = '（当前环境不支持估算）';
      }

      // 数据库详情
      if (resp.databases && resp.databases.length > 0) {
        const rows = resp.databases.map(db => {
          const storeRows = (db.stores || [])
            .map(s => `    └─ ${s.name}: ${s.count} 条`)
            .join('\n');
          return `◆ ${db.name} (v${db.version})\n${storeRows || '    (无 store)'}`;
        });
        dbDetailEl.innerHTML = '';
        const pre = document.createElement('pre');
        pre.className = 'info-code-block';
        pre.textContent = rows.join('\n\n');
        dbDetailEl.appendChild(pre);
      } else {
        dbDetailEl.textContent = '（暂无数据库）';
      }

      // 文件路径（Windows 默认路径模板）
      const winPath = `%LOCALAPPDATA%\\Google\\Chrome\\User Data\\Default\\IndexedDB\\chrome-${extId}_0.indexeddb.leveldb\\`;
      filePathEl.textContent = winPath;
    } catch (e) {
      const msg = `加载失败: ${e.message}`;
      extIdEl.textContent = msg;
      usageEl.textContent = msg;
      dbDetailEl.textContent = msg;
      filePathEl.textContent = msg;
    }
  }

  // 复制扩展 ID
  async function copyExtensionId() {
    const extId = document.getElementById('storageExtensionId').textContent.trim();
    if (!extId || extId === '加载中...' || extId.startsWith('加载失败')) {
      showToast('扩展 ID 尚未加载', true);
      return;
    }
    try {
      await navigator.clipboard.writeText(extId);
      showToast(`已复制: ${extId}`);
    } catch (e) {
      // 降级方案
      const ta = document.createElement('textarea');
      ta.value = extId;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        showToast(`已复制: ${extId}`);
      } catch (e2) {
        showToast('复制失败，请手动选择文本复制', true);
      }
      document.body.removeChild(ta);
    }
  }

  // 打开 chrome://extensions
  function openExtensionsPage() {
    chrome.tabs.create({ url: 'chrome://extensions/' });
  }

  // ---- 帮助弹窗 ----

  // 帮助文档缓存（避免重复 fetch）
  const helpCache = {};

  async function openHelp(type) {
    const info = VECTOR_HELP_MAP[type];
    if (!info) return;

    helpTitle.textContent = info.title;

    // 已缓存则直接使用
    if (helpCache[type]) {
      helpBody.innerHTML = helpCache[type];
      helpOverlay.classList.add('open');
      return;
    }

    // 加载中提示
    helpBody.innerHTML = '<p style="text-align:center;color:#6b7280;">加载中...</p>';
    helpOverlay.classList.add('open');

    try {
      const url = chrome.runtime.getURL(info.file);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const md = await resp.text();
      let html;
      if (typeof marked !== 'undefined') {
        html = marked.parse(md, { breaks: true, gfm: true });
      } else {
        // 降级：转义后用 <pre> 显示原始 markdown
        const div = document.createElement('div');
        div.textContent = md;
        html = `<pre style="white-space:pre-wrap;">${div.innerHTML}</pre>`;
      }
      helpCache[type] = html;
      helpBody.innerHTML = html;
    } catch (e) {
      helpBody.innerHTML = `<p style="color:#dc2626;">加载失败：${e.message}</p>
        <p>可直接打开 <code>${info.file}</code> 查看</p>`;
    }
  }

  function closeHelp() {
    helpOverlay.classList.remove('open');
  }

  // ---- 向量库数据管理相关 ----

  // 后端类型的中文显示
  const VENDOR_LABELS = {
    local: '本地 IndexedDB',
    chroma: 'ChromaDB',
    milvus: 'Milvus',
    pgvector: 'PostgreSQL + pgvector',
    supabase: 'Supabase',
    qdrant: 'Qdrant'
  };

  // 加载向量库统计
  async function loadVectorStoreStats() {
    const backendLabelEl = document.getElementById('vectorBackendLabel');
    const countEl = document.getElementById('vectorCount');
    const remoteConfigGroup = document.getElementById('remoteConfigGroup');
    const remoteConfigContent = document.getElementById('remoteConfigContent');

    backendLabelEl.textContent = '加载中...';
    countEl.textContent = '加载中...';

    try {
      const resp = await sendMessage({ type: 'GET_VECTOR_STORE_STATS' });
      if (!resp || resp.error) {
        const msg = resp?.error || '获取失败';
        backendLabelEl.textContent = msg;
        countEl.textContent = msg;
        return;
      }

      // 后端名称
      const type = resp.backend || 'local';
      backendLabelEl.textContent = VENDOR_LABELS[type] || type;

      // Milvus 计数有分钟级延迟，显示提示
      const countHintEl = document.getElementById('vectorCountHint');
      if (countHintEl) countHintEl.style.display = (type === 'milvus') ? '' : 'none';

      // 向量条数
      if (resp.count === null || resp.count === undefined) {
        if (resp.error) {
          countEl.textContent = `无法获取（${resp.error}）`;
        } else if (!resp.configured) {
          countEl.textContent = '未配置（请在上方填写远程配置并保存）';
        } else {
          countEl.textContent = '当前后端不支持统计';
        }
      } else {
        countEl.textContent = `${resp.count} 条`;
      }

      // 远程配置详情（仅远程后端显示）
      if (type !== 'local' && resp.config) {
        remoteConfigGroup.style.display = '';
        remoteConfigContent.innerHTML = '';
        const lines = [
          `类型：${VENDOR_LABELS[resp.config.type] || resp.config.type || '-'}`
        ];
        if (resp.config.url) lines.push(`地址：${resp.config.url}`);
        if (resp.config.collection) lines.push(`集合/表名：${resp.config.collection}`);
        const pre = document.createElement('pre');
        pre.className = 'info-code-block';
        pre.textContent = lines.join('\n');
        remoteConfigContent.appendChild(pre);
      } else {
        remoteConfigGroup.style.display = 'none';
      }
    } catch (e) {
      const msg = `加载失败: ${e.message}`;
      backendLabelEl.textContent = msg;
      countEl.textContent = msg;
    }
  }

  // 清空当前向量库
  async function clearVectorStore() {
    // 先获取统计以确认当前后端和条数
    const stats = await sendMessage({ type: 'GET_VECTOR_STORE_STATS' });
    const type = stats?.backend || 'local';
    const count = stats?.count;
    const typeLabel = VENDOR_LABELS[type] || type;

    const countText = (count === null || count === undefined)
      ? ''
      : `（当前 ${count} 条）`;
    const warning = type === 'local'
      ? `确定要清空本地向量库${countText}吗？此操作不可撤销。`
      : `确定要清空远程 ${typeLabel} 向量库${countText}吗？\n\n这会删除远程服务器上该集合内的所有向量数据，操作不可撤销。`;

    if (!confirm(warning)) return;

    clearVectorStoreBtn.disabled = true;
    clearVectorStoreBtn.textContent = '清理中...';

    try {
      const resp = await sendMessage({ type: 'CLEAR_VECTOR_STORE' });
      if (resp && resp.success) {
        const text = resp.count !== null && resp.count !== undefined
          ? `已清空 ${typeLabel}，共删除 ${resp.count} 条`
          : `已清空 ${typeLabel}`;
        showToast(text);
        // 刷新统计
        await loadVectorStoreStats();
      } else {
        const errMsg = resp?.error || '未知错误';
        showToast(`清空失败: ${errMsg}`, true);
      }
    } catch (e) {
      showToast(`操作异常: ${e.message}`, true);
    }
    clearVectorStoreBtn.disabled = false;
    clearVectorStoreBtn.textContent = '清空当前向量库';
  }

  // ---- 本地软件对接 ----

  // 测试本地软件连通性（使用当前填写的 baseUrl，未保存也可测）
  async function testLocalApp() {
    testLocalAppBtn.disabled = true;
    const originalText = testLocalAppBtn.textContent;
    testLocalAppBtn.textContent = '测试中...';
    try {
      // 先静默保存（不弹向量库切换询问）
      const baseUrl = localAppBaseUrl.value.trim() || 'http://localhost:8788';
      const intervalVal = parseInt(localAppInterval.value, 10) || 1;
      await sendMessage({
        type: 'SAVE_SETTINGS',
        category: 'localApp',
        settings: {
          enabled: localAppEnabled.checked,
          baseUrl,
          pushOnSave: localAppPushOnSave.checked,
          autoPush: localAppAutoPush.checked,
          intervalMinutes: intervalVal
        }
      });
      formSnapshot = serializeForm();

      const resp = await sendMessage({ type: 'LOCAL_APP_TEST' });
      if (resp && resp.success) {
        const platforms = (resp.supported_platforms || []).join(', ');
        showToast(`连通性测试成功！耗时 ${resp.latency}ms；版本 ${resp.version}；支持平台: ${platforms}；队列 ${resp.queue_size}`);
      } else {
        showToast(`连通性测试失败: ${resp?.error || '未知错误'}（请确认本地软件已启动）`, true);
      }
    } catch (e) {
      showToast(`测试异常: ${e.message}`, true);
    }
    testLocalAppBtn.disabled = false;
    testLocalAppBtn.textContent = originalText;
  }

  // 加载已推送统计
  async function loadLocalAppStats() {
    const countEl = document.getElementById('localAppPushedCount');
    if (!countEl) return;
    countEl.textContent = '加载中...';
    try {
      const resp = await sendMessage({ type: 'LOCAL_APP_STATUS' });
      if (!resp) {
        countEl.textContent = '获取失败';
        return;
      }
      const parts = [];
      parts.push(`已推送 ${resp.pushedCount || 0} 条`);
      if (resp.enabled) {
        const flags = [];
        if (resp.autoPush) flags.push(`定时 ${resp.intervalMinutes}min`);
        if (resp.pushOnSave) flags.push('保存即推');
        if (flags.length > 0) parts.push(`（${flags.join(' / ')}）`);
      } else {
        parts.push('（未启用）');
      }
      countEl.textContent = parts.join(' ');
    } catch (e) {
      countEl.textContent = `加载失败: ${e.message}`;
    }
  }

  // 清空已推送记录
  async function resetLocalAppPushed() {
    if (!confirm('确定清空已推送记录吗？\n\n清空后所有对话会被视为未推送，下次推送将重新发送。后端 24h 幂等去重仍会兜底，不会产生重复记录。')) return;
    resetLocalAppPushedBtn.disabled = true;
    try {
      const resp = await sendMessage({ type: 'LOCAL_APP_RESET_PUSHED' });
      if (resp && resp.success) {
        showToast('已清空已推送记录');
        loadLocalAppStats();
      } else {
        showToast(`清空失败: ${resp?.error || '未知错误'}`, true);
      }
    } catch (e) {
      showToast(`操作异常: ${e.message}`, true);
    }
    resetLocalAppPushedBtn.disabled = false;
  }
});
