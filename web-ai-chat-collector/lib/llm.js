// lib/llm.js - LLM 服务
// 支持两种后端：
//   1. OpenAI 兼容 API（DashScope / DeepSeek / 智谱 / Kimi / 豆包 / OpenAI / 其他兼容接口）
//   2. Ollama 本地
//
// 深度思考：通过 options.enableThinking 控制，请求体注入 enable_thinking（DashScope/Qwen/百度）
// 或 thinking（智谱/豆包）。响应中 reasoning_content 字段通过 onChunk 的 phase='reasoning' 回调传给前端。

const LLMService = {
  _backend: 'openai', // 'openai' | 'ollama'
  _config: {},
  _initialized: false,
  // models.json 厂商清单缓存（用于查找 thinkingParam 等元信息）
  _modelsCatalog: null,

  async init() {
    let settings = await getLLMSettings();
    let backend = settings.backend || 'openai';
    let config = settings.config || {};

    // 兼容旧数据：dashscope 后端已合并到 openai（DashScope 走 OpenAI 兼容端点）
    if (backend === 'dashscope') {
      backend = 'openai';
      config = {
        provider: 'dashscope',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: config.apiKey || '',
        model: config.model || 'qwen3.6-flash',
        enableThinking: config.enableThinking
      };
      // 持久化迁移后的配置，避免每次启动都迁移
      await saveLLMSettings({ backend, config });
      console.log('[LLM] 已将旧 dashscope 后端迁移为 openai 后端 + dashscope 预设');
    }

    this._backend = backend;
    this._config = config;
    this._initialized = true;
    // 异步加载 models.json，不阻塞 init
    this._loadModelsCatalog().catch(e => {
      console.warn('[LLM] 加载 models.json 失败，思考参数将使用默认 enable_thinking:', e);
    });
    console.log(`[LLM] 初始化完成，后端: ${this._backend}`);
  },

  async _loadModelsCatalog() {
    if (typeof chrome === 'undefined' || !chrome.runtime) return;
    try {
      const url = chrome.runtime.getURL('models.json');
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      this._modelsCatalog = await resp.json();
    } catch (e) {
      this._modelsCatalog = null;
    }
  },

  // 根据 provider id 查找厂商元信息
  _findProvider(providerId) {
    if (!this._modelsCatalog) return null;
    return (this._modelsCatalog.llmProviders || []).find(p => p.id === providerId) || null;
  },

  // 根据 baseUrl 反向匹配 OpenAI 兼容厂商
  _findProviderByBaseUrl(baseUrl) {
    if (!this._modelsCatalog || !baseUrl) return null;
    const normalized = baseUrl.replace(/\/+$/, '');
    return (this._modelsCatalog.llmProviders || []).find(p =>
      p.backend === 'openai' && p.baseUrl && p.baseUrl.replace(/\/+$/, '') === normalized
    ) || null;
  },

  // 构建请求体思考参数注入（不含 stream/max_tokens/temperature 等通用字段）
  // 关键：混合思考(hybrid)模型默认可能开启思考，关闭时必须显式传 false/disabled
  // 厂商差异：
  //   - enable_thinking 布尔值：DashScope/Qwen
  //   - thinking 对象 {type:"enabled"/"disabled"}：DeepSeek 官方/智谱/豆包
  //   - thinking 对象 {type:"adaptive"/"disabled"}：MiniMax（开启用 adaptive 而非 enabled）
  //   - reasoning_split: true：MiniMax 需额外传此参数，将思考内容从 content 拆到 reasoning_content
  _buildThinkingExtras(options) {
    // options.enableThinking 可覆盖配置（用于 AI Ball 临时切换）
    const enabled = options.enableThinking !== undefined
      ? options.enableThinking
      : this._config.enableThinking !== false;

    // 查找当前 provider 元信息
    let provider = this._findProvider(this._config.provider);
    if (!provider) provider = this._findProviderByBaseUrl(this._config.baseUrl);
    if (!provider || !provider.supportsThinking) return null;

    const paramName = provider.thinkingParam || 'enable_thinking';
    // MiniMax 开启时用 "adaptive"，其他厂商用 "enabled"
    const enabledType = provider.thinkingEnabledType || 'enabled';

    // 查找当前模型的思考模式：hybrid（可开关）/ only（仅思考）/ none（不支持）
    // 豆包等厂商用 Endpoint ID（ep-xxx）调用，modelMeta 可能匹配不上
    // 此时用 provider.fallbackThinking 作为默认思考模式
    const modelMeta = (provider.models || []).find(m => m.id === this._config.model);
    const thinkingMode = modelMeta?.thinking || provider.fallbackThinking || 'none';

    let extras = null;

    // 仅思考模式：强制开启，无法关闭
    if (thinkingMode === 'only') {
      extras = paramName === 'thinking'
        ? { thinking: { type: enabledType } }
        : { [paramName]: true };
    } else if (thinkingMode === 'hybrid') {
      // 混合思考模式：根据开关显式传 true/false（或 enabled/disabled）
      // 不传参数会使用模型默认值（可能为 true），所以关闭时必须显式传 false
      extras = paramName === 'thinking'
        ? { thinking: { type: enabled ? enabledType : 'disabled' } }
        : { [paramName]: enabled };
    }

    // MiniMax 需额外传 reasoning_split: true，让思考内容拆到 reasoning_content 字段
    // 不传时思考内容混在 content 的 <think> 标签内，无法通过 phase 区分
    if (extras && provider.reasoningSplit) {
      extras.reasoning_split = true;
    }

    return extras;
  },

  // OpenAI 兼容 baseUrl 智能拼接 chat/completions
  // 若 baseUrl 已含版本前缀（/v1、/v2、/v3、/v4），直接拼 /chat/completions；否则补 /v1
  _buildOpenAIChatUrl(baseUrl) {
    const base = (baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
    if (/\/v\d+$/.test(base)) {
      return `${base}/chat/completions`;
    }
    return `${base}/v1/chat/completions`;
  },

  getBackend() {
    return this._backend;
  },

  async setBackend(backend, config = {}) {
    this._backend = backend;
    this._config = config;
    await saveLLMSettings({ backend, config });
  },

  // 流式对话（统一入口，非流式已移除）
  // onChunk(delta, fullContent, phase) - phase: 'reasoning' | 'content' | undefined
  // onChunk 为 null 时仍走流式请求，但不回调（用于连通性测试等只需最终结果的场景）
  async chatStream(messages, onChunk, options = {}) {
    switch (this._backend) {
      case 'openai':
        return await this._chatOpenAIStream(messages, onChunk, options);
      case 'ollama':
        return await this._chatOllamaStream(messages, onChunk, options);
      default:
        throw new Error(`未知 LLM 后端: ${this._backend}`);
    }
  },

  // ---- OpenAI 兼容（DashScope / DeepSeek / 智谱 / Kimi / 豆包 / OpenAI 等） ----
  async _chatOpenAIStream(messages, onChunk, options) {
    const { apiKey, baseUrl, model } = this._config;
    if (!apiKey) throw new Error('未配置 API Key');

    const url = this._buildOpenAIChatUrl(baseUrl);
    const body = {
      model: model || 'gpt-3.5-turbo',
      messages,
      max_tokens: options.maxTokens || 4096,
      stream: true
    };
    // temperature：部分厂商思考/非思考模式要求不同温度值
    // Kimi k2.6/k2.5：思考模式固定 1.0，非思考模式固定 0.6，其他值报错
    // 优先级：options显式传入 > provider 思考模式动态值 > provider.defaultTemperature > 0.7
    let provider = this._findProvider(this._config.provider);
    if (!provider) provider = this._findProviderByBaseUrl(this._config.baseUrl);
    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    } else if (provider?.thinkingTemperature !== undefined || provider?.nonThinkingTemperature !== undefined) {
      // 思考状态由 _buildThinkingExtras 同一逻辑判定
      const enabled = options.enableThinking !== undefined
        ? options.enableThinking
        : this._config.enableThinking !== false;
      // 豆包等厂商用 Endpoint ID 时 modelMeta 匹配不上，用 fallbackThinking
      const modelMeta = (provider.models || []).find(m => m.id === this._config.model);
      const thinkingMode = modelMeta?.thinking || provider?.fallbackThinking || 'none';
      // only 模式强制思考；hybrid 模式按开关；none 模式不思考
      const isThinking = thinkingMode === 'only' || (thinkingMode === 'hybrid' && enabled);
      body.temperature = isThinking
        ? (provider.thinkingTemperature ?? 1.0)
        : (provider.nonThinkingTemperature ?? provider.defaultTemperature ?? 0.7);
    } else {
      body.temperature = provider?.defaultTemperature ?? 0.7;
    }

    const thinkingExtras = this._buildThinkingExtras(options);
    if (thinkingExtras) Object.assign(body, thinkingExtras);

    console.debug('[LLM] 请求:', url, '模型:', model, 'temperature:', body.temperature);

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    // HTTP 错误检查：非流式错误响应（如 400 参数错误、401 鉴权失败）返回 JSON 而非 SSE
    // 若不检查，_parseSSE 会把 JSON 当 SSE 解析，全部失败，最终返回空内容
    if (!resp.ok) {
      const errText = await resp.text();
      let errMsg = `LLM 请求失败 (HTTP ${resp.status})`;
      try {
        const errJson = JSON.parse(errText);
        // OpenAI 兼容错误格式：{ error: { message, type, code } }
        if (errJson.error?.message) errMsg += `: ${errJson.error.message}`;
        else if (errJson.message) errMsg += `: ${errJson.message}`;
      } catch (e) {
        if (errText) errMsg += `: ${errText.substring(0, 200)}`;
      }
      console.error('[LLM] 请求失败:', resp.status, errText.substring(0, 500));
      throw new Error(errMsg);
    }

    return await this._parseSSE(resp, onChunk, { provider, model });
  },

  // ---- Ollama 本地 ----
  async _chatOllamaStream(messages, onChunk, options) {
    const { baseUrl, model } = this._config;
    const url = `${baseUrl || 'http://localhost:11434'}/api/chat`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'qwen2.5:7b',
        messages,
        stream: true,
        options: {
          num_predict: options.maxTokens || 4096,
          temperature: options.temperature ?? 0.7
        }
      })
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      const lines = text.split('\n').filter(l => l.trim());

      for (const line of lines) {
        try {
          const json = JSON.parse(line);
          if (json.message?.content) {
            fullContent += json.message.content;
            // Ollama 暂无 reasoning_content 字段，统一按 content phase 回调
            if (onChunk) onChunk(json.message.content, fullContent, 'content');
          }
        } catch (e) {
          // 忽略解析错误
        }
      }
    }

    return fullContent;
  },

  // ---- SSE 解析（OpenAI/DashScope 通用） ----
  // 解析 reasoning_content 与 content 两个字段，通过 onChunk 的 phase 参数区分
  // ctx 参数：{ provider, model } 用于调试日志
  async _parseSSE(resp, onChunk, ctx = {}) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let fullReasoning = '';
    let fullContent = '';
    let buffer = '';
    let chunkCount = 0;
    const tag = ctx.provider ? `[LLM:${ctx.provider.id}]` : '[LLM]';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // SSE 注释行以 ':' 开头（如 keep-alive），跳过
        if (trimmed.startsWith(':')) continue;
        // 只处理 data: 开头的行；event: 等其他 SSE 字段忽略
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;

        // 前 3 条 data 输出调试日志，帮助排查响应格式问题
        if (chunkCount < 3) {
          console.debug(`${tag} SSE chunk[${chunkCount}]:`, data.substring(0, 300));
        }
        chunkCount++;

        try {
          const json = JSON.parse(data);
          // 部分 chunk 可能无 choices（如纯 usage 统计块），安全取值
          const choice = json.choices?.[0];
          const delta = choice?.delta || {};
          // 思考内容（先于 content 输出）
          const reasoningDelta = delta.reasoning_content || '';
          if (reasoningDelta) {
            fullReasoning += reasoningDelta;
            if (onChunk) onChunk(reasoningDelta, fullReasoning, 'reasoning');
          }
          // 正式回答内容
          const contentDelta = delta.content || '';
          if (contentDelta) {
            fullContent += contentDelta;
            if (onChunk) onChunk(contentDelta, fullContent, 'content');
          }
        } catch (e) {
          console.warn(`${tag} SSE 解析失败:`, e.message, '原始数据:', data.substring(0, 200));
        }
      }
    }

    // 解析完成后，若无内容输出警告（帮助排查"响应为空"问题）
    if (!fullContent && !fullReasoning) {
      console.warn(`${tag} 流式响应结束但无内容，共收到 ${chunkCount} 个 chunk。模型: ${ctx.model || '(未知)'}`);
    }

    // 兼容旧调用方：返回 content（不含 reasoning）。reasoning 已通过 onChunk 流式传递
    return fullContent;
  }
};

// ============================================================
// AI 问答功能
// ============================================================

const AIAssistant = {
  // 整理信息：检索相关片段 + LLM 归纳总结
  // options.enableThinking 可临时覆盖 LLM 配置中的思考开关
  async organizeInfo(query, onChunk, options = {}) {
    // 1. 生成查询 embedding
    const queryVector = await EmbeddingService.embed(query);
    if (!queryVector) throw new Error('无法生成查询向量，请检查 Embedding 设置');

    // 2. 向量搜索（按召回设置：Top-K / 阈值 / 组合）
    const searchResults = await VectorStore.retrievalSearch(queryVector);

    // 3. 获取相关对话内容
    const contexts = await this._buildContexts(searchResults);

    // 4. 构建 prompt
    const systemPrompt = `你是一个信息整理助手。根据用户提供的对话记录片段，整理和归纳相关信息。
要求：
- 提取关键信息和要点
- 按逻辑组织内容
- 标注信息来源（对话标题）
- 如果信息不足，明确指出
- 用中文回答`;

    const userPrompt = `用户问题：${query}\n\n相关对话片段：\n${contexts}`;

    // 5. 调用 LLM
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    return await LLMService.chatStream(messages, onChunk, options);
  },

  // 生成小测验
  async generateQuiz(query, onChunk, options = {}) {
    const queryVector = await EmbeddingService.embed(query);
    if (!queryVector) throw new Error('无法生成查询向量，请检查 Embedding 设置');

    // 按召回设置（Top-K / 阈值 / 组合）执行检索
    const searchResults = await VectorStore.retrievalSearch(queryVector);
    const contexts = await this._buildContexts(searchResults);

    const systemPrompt = `你是一个教育测验生成助手。根据用户提供的对话记录片段，生成小测验。
要求：
- 生成 5-10 道题目
- 题型包括：选择题、判断题、填空题
- 每题标注正确答案和解析
- 题目应覆盖关键知识点
- 难度适中
- 用中文出题

输出格式：
1. 先输出完整的 Markdown 格式测验内容，包含题目、选项、正确答案和解析
2. 在 Markdown 内容末尾，输出一个 HTML 注释块，内含 JSON 格式的结构化测验数据，用于做题模式解析

JSON 结构如下（type 为 choice/truefalse/fill，分别对应选择题/判断题/填空题）：
<!-- QUIZ_DATA
{"questions":[{"type":"choice","question":"题目内容","options":{"A":"选项A","B":"选项B","C":"选项C","D":"选项D"},"answer":"A","explanation":"解析"},{"type":"truefalse","question":"判断题内容","answer":"正确","explanation":"解析"},{"type":"fill","question":"填空题内容，空格用____表示","answer":"答案","explanation":"解析"}]}
-->

JSON 注意事项：
- JSON 必须完整合法，可被 JSON.parse 解析
- question 和 explanation 中如果需要引用文字，必须使用中文引号""，严禁使用 ASCII 双引号 "
- answer 字段规范：选择题为大写字母（A/B/C/D），判断题固定为"正确"或"错误"，填空题为纯文本答案
- 不要在 JSON 中使用未转义的换行，换行用 \\n 表示
- 填空题答案避免包含特殊字符，数字范围用波浪号（如 65~100）`;

    const userPrompt = `主题：${query}\n\n相关对话片段：\n${contexts}`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    return await LLMService.chatStream(messages, onChunk, options);
  },

  // 自由问答（RAG）
  async askQuestion(query, onChunk, options = {}) {
    const queryVector = await EmbeddingService.embed(query);
    if (!queryVector) throw new Error('无法生成查询向量，请检查 Embedding 设置');

    // 按召回设置（Top-K / 阈值 / 组合）执行检索
    const searchResults = await VectorStore.retrievalSearch(queryVector);
    const contexts = await this._buildContexts(searchResults);

    const systemPrompt = `你是一个基于对话记录的问答助手。根据检索到的对话片段回答用户问题。

上下文格式说明：
- 标注 ★ 的消息是与问题高度相关的命中片段，应作为主要回答依据
- 标注 · 的消息是命中消息的上下文（前后发言），仅供理解背景，不要当作答案来源
- 每段对话标题后的"相似度"反映检索置信度：≥0.7 为高相关，0.4-0.7 为中相关，<0.4 为低相关

回答要求：
- 仅基于 ★ 命中消息作答，不要编造信息
- 引用格式：在关键信息后标注 [来源：对话标题]
- 若所有命中相似度均低于 0.4，明确回答"知识库中无明确记录"，不要拼凑答案
- 不要复述"内容过长已截断"等元信息
- 用中文回答`;

    const userPrompt = `问题：${query}\n\n相关对话片段：\n${contexts}`;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    return await LLMService.chatStream(messages, onChunk, options);
  },

  // 从 embId 解析消息定位信息
  // embId 格式：${convId}::msg::${msgHash}::chunk::${chunkIdx}
  // 返回 { msgHash, chunkIdx } 或 null（格式不匹配时）
  _parseEmbId(id) {
    if (!id || typeof id !== 'string') return null;
    const parts = id.split('::');
    if (parts.length < 5) return null;
    // parts: [convId, 'msg', msgHash, 'chunk', chunkIdx]
    if (parts[1] !== 'msg' || parts[3] !== 'chunk') return null;
    const chunkIdx = parseInt(parts[4], 10);
    return { msgHash: parts[2], chunkIdx: isNaN(chunkIdx) ? -1 : chunkIdx };
  },

  // 构建上下文文本：父子文档检索
  // 父 = 命中 chunk 所属的整条消息（按 msgHash 在本地对话中定位）
  // 扩展 = 命中消息前后各 1 条邻居消息，提供发言连贯性
  // 本地对话缺失时跳过（远程库 content 仅供 skill 使用，插件端以本地存储为准）
  async _buildContexts(searchResults) {
    if (!searchResults || searchResults.length === 0) {
      return '（未找到相关对话片段）';
    }

    // 从召回设置读取单对话上下文上限（用户可在设置页调整）
    const rs = await getRetrievalSettings();
    const maxCharsPerConv = Math.max(500, rs.maxContextChars || 8000);

    // 按 convId 分组，同对话的多 chunk 命中合并处理
    const convMap = new Map(); // convId -> { bestScore, msgHashes: Set }
    for (const r of searchResults) {
      if (!r.convId) continue;
      const parsed = this._parseEmbId(r.id);
      const msgHash = parsed?.msgHash || '';
      if (!convMap.has(r.convId)) {
        convMap.set(r.convId, { bestScore: r.score || 0, msgHashes: new Set() });
      } else {
        const entry = convMap.get(r.convId);
        entry.bestScore = Math.max(entry.bestScore, r.score || 0);
        if (msgHash) entry.msgHashes.add(msgHash);
      }
    }

    const contexts = [];

    for (const [convId, info] of convMap) {
      try {
        const conv = await getConversation(convId);
        if (!conv) {
          // 本地对话缺失（远程库命中但本地未同步）：跳过，不喂 LLM 模糊内容
          console.warn('[AIAssistant] 本地对话缺失，跳过:', convId);
          continue;
        }

        const messages = conv.messages || [];
        if (messages.length === 0) continue;

        // 定位命中的消息索引
        const hitIndices = new Set();
        if (info.msgHashes.size > 0) {
          messages.forEach((msg, idx) => {
            if (msg.hash && info.msgHashes.has(String(msg.hash))) {
              hitIndices.add(idx);
            }
          });
        }

        let contextText = `--- 对话：${conv.title}（相似度: ${info.bestScore.toFixed(3)}）---\n`;
        let charCount = 0;
        let addedCount = 0;

        if (hitIndices.size > 0) {
          // 父子检索路径：命中消息 + 前后各 1 条邻居，按索引排序
          const contextIndices = new Set();
          for (const idx of hitIndices) {
            contextIndices.add(idx);
            if (idx - 1 >= 0) contextIndices.add(idx - 1);
            if (idx + 1 < messages.length) contextIndices.add(idx + 1);
          }
          const sortedIndices = [...contextIndices].sort((a, b) => a - b);
          for (const idx of sortedIndices) {
            if (charCount >= maxCharsPerConv) {
              contextText += '...（内容过长，已截断）\n';
              break;
            }
            const msg = messages[idx];
            const role = msg.role === 'user' ? '用户' : '助手';
            const filtered = EmbeddingService.filterContentForEmbedding(msg.content || '');
            if (!filtered) continue;
            // 命中消息取完整内容（父文档），邻居消息取前 500 字
            const isHit = hitIndices.has(idx);
            const content = isHit ? filtered : filtered.substring(0, 500);
            const mark = isHit ? '★' : '·';
            contextText += `[${role}${mark}]: ${content}\n`;
            charCount += content.length;
            addedCount++;
          }
        } else {
          // 回退路径：msgHash 未匹配上（老数据或 hash 缺失），遍历整对话
          for (const msg of messages) {
            if (charCount >= maxCharsPerConv) {
              contextText += '...（内容过长，已截断）\n';
              break;
            }
            const role = msg.role === 'user' ? '用户' : '助手';
            const filtered = EmbeddingService.filterContentForEmbedding(msg.content || '');
            if (!filtered) continue;
            const content = filtered.substring(0, 500);
            contextText += `[${role}]: ${content}\n`;
            charCount += content.length;
            addedCount++;
          }
        }

        if (addedCount > 0) {
          contexts.push(contextText);
        }
      } catch (e) {
        console.error('[AIAssistant] 获取对话失败:', convId, e);
      }
    }

    return contexts.join('\n\n') || '（未找到相关对话片段）';
  },

  // 导出整理结果为文本
  exportAsText(content, filename) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || '整理结果.txt';
    a.click();
    URL.revokeObjectURL(url);
  }
};

// ============================================================
// 设置持久化
// ============================================================

async function getLLMSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get('llmSettings', (result) => {
      resolve(result.llmSettings || {
        backend: 'openai',
        config: {
          provider: 'dashscope',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          apiKey: '',
          model: 'qwen3.6-flash'
        }
      });
    });
  });
}

async function saveLLMSettings(settings) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ llmSettings: settings }, resolve);
  });
}
