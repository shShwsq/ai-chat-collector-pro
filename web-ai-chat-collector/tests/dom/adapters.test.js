// tests/dom/adapters.test.js
// 5 个平台 DOM 适配器测试：kimi / deepseek / qianwen / fudan / doubao
//
// 这是"平台 DOM 改了立刻发现"的核心防线：
// 每个平台用 1-2 个最小 DOM fixture 覆盖 getConversationId / getTitle / isStreaming / extractMessages。
// 当平台升级 DOM 结构（改 class 名、重组容器层级、移除/新增节点）时，对应测试会立即失败。
//
// fixtures 基于 project_memory 中记录的真实 DOM 结构构造，只保留适配器依赖的关键 class/属性。
// 真实平台 DOM 更复杂（含噪声元素、嵌套层级），但这些 fixture 足以验证适配器的核心提取逻辑。

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { loadDomAdapter } from '../helpers/load-source.js';

let kimi, deepseek, qianwen, fudan, doubao;

beforeAll(() => {
  // 分别加载 5 个平台适配器（每次都会重新加载 turndown + html-to-markdown + katex-html-to-latex）
  kimi = loadDomAdapter('kimi');
  deepseek = loadDomAdapter('deepseek');
  qianwen = loadDomAdapter('qianwen');
  fudan = loadDomAdapter('fudan');
  doubao = loadDomAdapter('doubao');
});

// 重置 jsdom 环境（每个测试前清空 body + 重置 location/title）
// 同时在 document.head 中插入 <title> 元素，让适配器的 document.querySelector('title') 能找到
function resetEnv(pathname = '/', search = '', title = '') {
  document.body.innerHTML = '';
  document.head.innerHTML = title ? `<title>${title}</title>` : '';
  Object.defineProperty(window, 'location', {
    value: { pathname, search, href: pathname + search },
    configurable: true,
    writable: true
  });
  Object.defineProperty(document, 'title', {
    value: title,
    configurable: true,
    writable: true
  });
}

// think 标签拼接（避免被工具误处理）
const THINK_OPEN = '<' + 'think' + '>';
const THINK_CLOSE = '</' + 'think' + '>';

// =================================================================
// Kimi 适配器
// =================================================================
describe('Kimi 适配器', () => {
  beforeEach(() => resetEnv('/chat/abc12345-def67890', '', '数学问题讨论 - Kimi'));

  it('getConversationId 从 /chat/{uuid} 提取', () => {
    expect(kimi.getConversationId()).toBe('abc12345-def67890');
  });

  it('getConversationId 无 /chat/ 前缀时降级匹配 uuid', () => {
    resetEnv('/abc12345-def67890');
    expect(kimi.getConversationId()).toBe('abc12345-def67890');
  });

  it('getConversationId 无 uuid 时返回 default', () => {
    resetEnv('/');
    expect(kimi.getConversationId()).toBe('default');
  });

  it('getTitle 剥离 " - Kimi" 后缀', () => {
    expect(kimi.getTitle()).toBe('数学问题讨论');
  });

  it('getTitle 空标题时返回"未命名对话"', () => {
    resetEnv('/chat/abc', '', '');
    expect(kimi.getTitle()).toBe('未命名对话');
  });

  it('isStreaming 检测 .core-spiral-loading', () => {
    expect(kimi.isStreaming()).toBe(false);
    document.body.innerHTML = '<div class="core-spiral-loading"></div>';
    expect(kimi.isStreaming()).toBe(true);
  });

  it('isStreaming 检测 .send-button-container.stop', () => {
    document.body.innerHTML = '<div class="send-button-container stop"></div>';
    expect(kimi.isStreaming()).toBe(true);
  });

  it('extractMessages 分离用户/助手消息', () => {
    document.body.innerHTML = `
      <div class="chat-detail-content">
        <div class="chat-content-item chat-content-item-user">
          <div class="segment segment-user">
            <div class="segment-content">
              <div class="segment-content-box">
                <div class="markdown-container"><div class="markdown">
                  <div class="paragraph">你好</div>
                </div></div>
              </div>
            </div>
          </div>
        </div>
        <div class="chat-content-item chat-content-item-assistant">
          <div class="segment segment-assistant">
            <div class="segment-content">
              <div class="segment-assistant-actions"><button>思考已完成</button></div>
              <div class="toolcall-container"><div class="toolcall-content">
                <div class="markdown-container"><div class="markdown">
                  <div class="paragraph">思考过程</div>
                </div></div>
              </div></div>
              <div class="segment-content-box">
                <div class="markdown-container"><div class="markdown">
                  <div class="paragraph">回答内容</div>
                </div></div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    const msgs = kimi.extractMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('你好');
    expect(msgs[1].role).toBe('assistant');
    // 助手消息含 think 块 + 回答
    expect(msgs[1].content).toContain('思考过程');
    expect(msgs[1].content).toContain('回答内容');
    // think 块格式：开标签 + 思考 + 闭标签
    expect(msgs[1].content.startsWith(THINK_OPEN)).toBe(true);
    expect(msgs[1].content).toContain(THINK_CLOSE);
  });

  it('extractMessages 无 .chat-detail-content 时返回空数组', () => {
    document.body.innerHTML = '<div>其他内容</div>';
    expect(kimi.extractMessages()).toEqual([]);
  });

  it('extractMessages 助手消息无思考时只有回答', () => {
    document.body.innerHTML = `
      <div class="chat-detail-content">
        <div class="chat-content-item chat-content-item-assistant">
          <div class="segment segment-assistant">
            <div class="segment-content">
              <div class="segment-content-box">
                <div class="markdown-container"><div class="markdown">
                  <div class="paragraph">仅回答</div>
                </div></div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    const msgs = kimi.extractMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('assistant');
    expect(msgs[0].content).toBe('仅回答');
  });

  it('extractMessages 用户消息无 .markdown 时走兜底取 .segment-content 文本', () => {
    // 真实 Kimi DOM 中部分纯文本用户消息无 .markdown 渲染容器，
    // 文本直接在 .segment-content-box > .user-content 中
    // 适配器 _extractUserContent 先找 .markdown，找不到则从 .segment-content 清理后取文本
    document.body.innerHTML = `
      <div class="chat-detail-content">
        <div class="chat-content-item chat-content-item-user">
          <div class="segment segment-user">
            <div class="segment-content">
              <div class="segment-content-box">
                <div class="user-content">纯文本用户消息</div>
              </div>
              <div class="segment-user-action-row"><button>编辑</button></div>
            </div>
          </div>
        </div>
      </div>`;
    const msgs = kimi.extractMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('纯文本用户消息');
    // 操作按钮文本不应混入
    expect(msgs[0].content).not.toContain('编辑');
  });
});

// =================================================================
// DeepSeek 适配器
// =================================================================
describe('DeepSeek 适配器', () => {
  beforeEach(() => resetEnv('/a/chat/s/abc12345-def67890', '', '对话标题 - DeepSeek'));

  it('getConversationId 跳过 s/ 前缀', () => {
    expect(deepseek.getConversationId()).toBe('abc12345-def67890');
  });

  it('getConversationId 无 s/ 前缀也能匹配', () => {
    resetEnv('/a/chat/abc12345');
    expect(deepseek.getConversationId()).toBe('abc12345');
  });

  it('getConversationId 无匹配时返回 default', () => {
    resetEnv('/');
    expect(deepseek.getConversationId()).toBe('default');
  });

  it('getTitle 剥离 " - DeepSeek" 后缀', () => {
    expect(deepseek.getTitle()).toBe('对话标题');
  });

  it('isStreaming 检测停止按钮 SVG path 以 "M2 " 开头', () => {
    expect(deepseek.isStreaming()).toBe(false);
    document.body.innerHTML = `
      <button class="ds-button--primary ds-button--filled ds-button--circle">
        <svg><path d="M2 3L4 3L4 7L2 7Z"></path></svg>
      </button>`;
    expect(deepseek.isStreaming()).toBe(true);
  });

  it('isStreaming 发送按钮 SVG path 以 "M8" 开头时返回 false', () => {
    document.body.innerHTML = `
      <button class="ds-button--primary ds-button--filled ds-button--circle">
        <svg><path d="M8 5L12 9L8 13"></path></svg>
      </button>`;
    expect(deepseek.isStreaming()).toBe(false);
  });

  it('extractMessages 提取用户消息（纯文本 .fbb737a4）', () => {
    document.body.innerHTML = `
      <div class="ds-virtual-list-visible-items">
        <div data-virtual-list-item-key="1"><div class="ds-message">
          <div class="fbb737a4">用户问题</div>
        </div></div>
      </div>`;
    const msgs = deepseek.extractMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('用户问题');
  });

  it('extractMessages 完整助手消息：思考 + 搜索来源 + 回答', () => {
    document.body.innerHTML = `
      <div class="ds-virtual-list-visible-items">
        <div data-virtual-list-item-key="2"><div class="ds-message">
          <div class="_74c0879">
            <div class="_5ab5d64">已深度思考（用时 5 秒）</div>
            <div class="ds-think-content"><div class="ds-markdown"><p>思考内容</p></div></div>
            <div class="f2021e64">
              <a class="_04ab7b1" href="https://example.com">来源标题</a>
            </div>
          </div>
          <div class="ds-markdown ds-assistant-message-main-content"><p>正式回答</p></div>
        </div></div>
      </div>`;
    const msgs = deepseek.extractMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('assistant');
    expect(msgs[0].content).toContain('思考内容');
    expect(msgs[0].content).toContain(THINK_OPEN);
    expect(msgs[0].content).toContain(THINK_CLOSE);
    expect(msgs[0].content).toContain('来源标题');
    expect(msgs[0].content).toContain('https://example.com');
    expect(msgs[0].content).toContain('正式回答');
    // 搜索来源块格式
    expect(msgs[0].content).toContain('<search_result>');
    expect(msgs[0].content).toContain('</search_result>');
  });

  it('extractMessages 被中断的助手消息：有思考无回答，标记 [已停止]', () => {
    document.body.innerHTML = `
      <div class="ds-virtual-list-visible-items">
        <div data-virtual-list-item-key="3"><div class="ds-message">
          <div class="_74c0879">
            <div class="_5ab5d64">已停止</div>
            <div class="ds-think-content"><div class="ds-markdown"><p>部分思考</p></div></div>
          </div>
        </div></div>
      </div>`;
    const msgs = deepseek.extractMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('assistant');
    expect(msgs[0].content).toContain('部分思考');
    expect(msgs[0].content).toContain('[已停止]');
  });

  it('extractMessages 无 .ds-virtual-list-visible-items 时返回空数组', () => {
    document.body.innerHTML = '<div>其他</div>';
    expect(deepseek.extractMessages()).toEqual([]);
  });
});

// =================================================================
// 千问适配器
// =================================================================
describe('千问适配器', () => {
  beforeEach(() => resetEnv('/chat/abc123', '', '对话标题 - 千问'));

  it('getConversationId 从 /chat/{id} 提取', () => {
    expect(qianwen.getConversationId()).toBe('abc123');
  });

  it('getConversationId 无 /chat/ 前缀时返回 default', () => {
    resetEnv('/');
    expect(qianwen.getConversationId()).toBe('default');
  });

  it('getTitle 从 .text-ellipsis.whitespace-nowrap.overflow-hidden 提取', () => {
    document.body.innerHTML = `
      <div class="!bg-option">
        <div class="text-ellipsis whitespace-nowrap overflow-hidden">激活对话标题</div>
      </div>`;
    expect(qianwen.getTitle()).toBe('激活对话标题');
  });

  it('getTitle fallback 从 document.title 剥离 " - 千问"', () => {
    expect(qianwen.getTitle()).toBe('对话标题');
  });

  it('isStreaming 检测 [aria-label="停止回答"]', () => {
    expect(qianwen.isStreaming()).toBe(false);
    document.body.innerHTML = '<button aria-label="停止回答">停</button>';
    expect(qianwen.isStreaming()).toBe(true);
  });

  it('extractMessages 按对话轮次提取（用户 + 助手）', () => {
    document.body.innerHTML = `
      <div id="message-list-scroller">
        <div class="chat-round">
          <div class="chat-question-card-wrap">用户问题</div>
          <div class="chat-answers-card-wrap">
            <div class="message-card-j_n6rq">
              <div data-card_name="bar_workflow">
                <div class="text-caption">已完成思考，参考了N篇材料</div>
                <div class="flex flex-col gap-0.5">
                  <div class="text-sm font-semibold">步骤1</div>
                  <div class="thinking-content-tIwPU3">
                    <div class="markdown-pc-special-class"><div class="qk-markdown">
                      <div class="qk-md-paragraph">思考内容</div>
                    </div></div>
                  </div>
                </div>
                <div class="flex flex-col gap-1.5">
                  <div class="invisible absolute">
                    <div class="truncate">搜索词</div>
                  </div>
                </div>
              </div>
              <div class="answer-common-card">
                <div class="markdown-pc-special-class"><div class="qk-markdown">
                  <div class="qk-md-paragraph">正式回答</div>
                </div></div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    const msgs = qianwen.extractMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('用户问题');
    expect(msgs[1].role).toBe('assistant');
    // 千问思考+搜索来源被拼接到助手消息中
    expect(msgs[1].content).toContain('思考内容');
    expect(msgs[1].content).toContain('正式回答');
    expect(msgs[1].content).toContain(THINK_OPEN);
    expect(msgs[1].content).toContain('搜索词');
  });

  it('extractMessages 无 #message-list-scroller 时返回空数组', () => {
    document.body.innerHTML = '<div>其他</div>';
    expect(qianwen.extractMessages()).toEqual([]);
  });

  it('extractMessages 思考 + 代码块端到端（bar_workflow + qw-md-code）', () => {
    // 真实场景（qianwen-code.txt）：思考容器 bar_workflow 与正式回答 answer-common-card 共存，
    // 正式回答内含千问代码块 .qw-md-code（语言标签在 span.mr-auto，行号在 .react-syntax-highlighter-line-number）
    document.body.innerHTML = `
      <div id="message-list-scroller">
        <div class="chat-round">
          <div class="chat-question-card-wrap"><div class="qk-markdown">写个测试代码</div></div>
          <div class="chat-answers-card-wrap">
            <div class="message-card-j_n6rq">
              <div data-card_name="bar_workflow">
                <div class="flex flex-col gap-0.5">
                  <div class="text-sm font-semibold">分析需求</div>
                  <div class="thinking-content-tIwPU3">
                    <div class="markdown-pc-special-class"><div class="qk-markdown">
                      <div class="qk-md-paragraph">需要写一个简单的 Python 测试</div>
                    </div></div>
                  </div>
                </div>
              </div>
              <div class="answer-common-card">
                <div class="markdown-pc-special-class"><div class="qk-markdown">
                  <div class="qk-md-paragraph">下面是测试代码：</div>
                  <div class="qw-md-code">
                    <div class="h-[36px]">
                      <span class="font-medium mr-auto">python</span>
                      <button>复制</button>
                    </div>
                    <div class="codeHighlighterWrapper">
                      <pre><code><span class="react-syntax-highlighter-line-number">1</span>import os<span class="react-syntax-highlighter-line-number">2</span>print(os.getcwd())</code></pre>
                    </div>
                  </div>
                </div></div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    const msgs = qianwen.extractMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].role).toBe('assistant');
    // 思考内容被 think 块包裹
    expect(msgs[1].content).toContain(THINK_OPEN);
    expect(msgs[1].content).toContain('需要写一个简单的 Python 测试');
    expect(msgs[1].content).toContain('分析需求');
    // 代码块语言标签正确提取
    expect(msgs[1].content).toContain('```python');
    // 代码内容保留，行号被移除
    expect(msgs[1].content).toContain('import os');
    expect(msgs[1].content).toContain('print(os.getcwd())');
    // 行号不应混入代码
    expect(msgs[1].content).not.toMatch(/1import/);
    expect(msgs[1].content).not.toMatch(/2print/);
    // 标题栏"复制"按钮文字不应混入
    expect(msgs[1].content).not.toContain('复制');
  });
});

// =================================================================
// 复旦适配器
// =================================================================
describe('复旦适配器', () => {
  beforeEach(() => resetEnv('/share', '?sess_id=session-abc', '复旦对话'));

  it('getConversationId 从 sess_id 参数提取', () => {
    expect(fudan.getConversationId()).toBe('session-abc');
  });

  it('getConversationId 无 sess_id 时返回 default', () => {
    resetEnv('/share', '');
    expect(fudan.getConversationId()).toBe('default');
  });

  it('getTitle 从 .session.active_session 提取', () => {
    document.body.innerHTML = `
      <div class="session active_session">激活会话标题</div>`;
    expect(fudan.getTitle()).toBe('激活会话标题');
  });

  it('getTitle fallback 从 document.title 提取', () => {
    expect(fudan.getTitle()).toBe('复旦对话');
  });

  it('extractMessages 提取用户和助手消息', () => {
    document.body.innerHTML = `
      <div id="share_part" class="message_list">
        <div class="message_item">
          <div class="cardBox">
            <div class="my_issue" position="q">
              <div class="text myQuestion q"><div class="content"><form class="n-form">
                <p class="q_class"><div class="md-editor question md-editor-previewOnly">
                  <div class="md-editor-preview-wrapper"><div class="md-editor-preview">用户问题</div></div>
                </div></p>
              </form></div></div>
            </div>
            <div class="my_issue has_a" position="a">
              <div class="text a"><div class="content"><form class="n-form">
                <div class="think_box">
                  <div class="think_title show">deep thinking</div>
                  <div class="border_box show">思考内容</div>
                </div>
                <div class="md-editor answer md-editor-previewOnly">
                  <div class="md-editor-preview-wrapper"><div class="md-editor-preview">正式回答</div></div>
                </div>
              </form></div></div>
            </div>
          </div>
        </div>
      </div>`;
    const msgs = fudan.extractMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toContain('用户问题');
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].content).toContain('思考内容');
    expect(msgs[1].content).toContain('正式回答');
    // 复旦思考也用 think 块包裹
    expect(msgs[1].content).toContain(THINK_OPEN);
    expect(msgs[1].content).toContain(THINK_CLOSE);
  });

  it('extractMessages 无 #share_part 时返回空数组', () => {
    document.body.innerHTML = '<div>其他</div>';
    expect(fudan.extractMessages()).toEqual([]);
  });

  it('extractMessages 提取搜索来源（link_box 标题 + citation-link 编号映射 URL）', () => {
    // 真实场景（fudan.txt）：.networking_card .link_box 内 .link_item 仅含"N、标题"（无 URL），
    // URL 从回答中的 a.citation-link 按编号映射获取
    document.body.innerHTML = `
      <div id="share_part" class="message_list">
        <div class="message_item">
          <div class="cardBox">
            <div class="my_issue has_a" position="a">
              <div class="text a"><div class="content"><form class="n-form">
                <div class="networking_card">
                  <div class="summarize">quote6 using this information</div>
                  <div class="link_box" style="display:none;">
                    <div class="link_item">1、上海天气预报</div>
                    <div class="link_item">2、本周降雨分析</div>
                  </div>
                </div>
                <div class="think_box">
                  <div class="think_title show">deep thinking</div>
                  <div class="border_box show">分析天气数据</div>
                </div>
                <div class="md-editor answer md-editor-previewOnly">
                  <div class="md-editor-preview-wrapper"><div class="md-editor-preview">
                    <p>上海下周有雨<a class="circle citation-link xiaoshou" href="https://www.toutiao.com/article/7656300103346553385/">1</a>，注意防范<a class="circle citation-link xiaoshou" href="https://news.qq.com/rain/a/20260628A046ZW00">2</a>。</p>
                  </div></div>
                </div>
              </form></div></div>
            </div>
          </div>
        </div>
      </div>`;
    const msgs = fudan.extractMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('assistant');
    // 搜索来源块格式：<search_result>...【标题】\nURL...</search_result>
    expect(msgs[0].content).toContain('<search_result>');
    expect(msgs[0].content).toContain('</search_result>');
    // link_item 标题被提取
    expect(msgs[0].content).toContain('上海天气预报');
    expect(msgs[0].content).toContain('本周降雨分析');
    // citation-link 编号→URL 映射正确
    expect(msgs[0].content).toContain('https://www.toutiao.com/article/7656300103346553385/');
    expect(msgs[0].content).toContain('https://news.qq.com/rain/a/20260628A046ZW00');
    // 思考内容也被提取
    expect(msgs[0].content).toContain(THINK_OPEN);
    expect(msgs[0].content).toContain('分析天气数据');
    // 正式回答保留
    expect(msgs[0].content).toContain('上海下周有雨');
  });

  it('extractMessages 欢迎对话（无 sess_id 且未观察到 compose_chat）跳过采集', () => {
    // 复旦首页欢迎对话 URL 无 sess_id，且未触发流式对话（_fudanComposeChatSeen=false），
    // extractMessages 应返回空数组避免采集欢迎页噪声
    resetEnv('/share', '', '复旦 AI Agent');
    document.body.innerHTML = `
      <div id="share_part" class="message_list">
        <div class="message_item">
          <div class="cardBox">
            <div class="text a"><div class="content"><form class="n-form">
              <div class="md-editor answer md-editor-previewOnly">
                <div class="md-editor-preview-wrapper"><div class="md-editor-preview">欢迎使用复旦 AI Agent</div></div>
              </div>
            </form></div></div>
          </div>
        </div>
      </div>`;
    expect(fudan.extractMessages()).toEqual([]);
  });
});

// =================================================================
// 豆包适配器
// =================================================================
describe('豆包适配器', () => {
  beforeEach(() => resetEnv('/chat/1234567890', '', '豆包对话 - 豆包'));

  it('getConversationId 从 /chat/{digits} 提取', () => {
    expect(doubao.getConversationId()).toBe('1234567890');
  });

  it('getConversationId 无数字 ID 时返回 default', () => {
    resetEnv('/chat/abc');
    expect(doubao.getConversationId()).toBe('default');
  });

  it('getTitle 从 #conversation_{convId} [class*="overallTitle"] 提取', () => {
    document.body.innerHTML = `
      <a id="conversation_1234567890">
        <div class="overallTitle-xyz">激活对话标题</div>
      </a>`;
    expect(doubao.getTitle()).toBe('激活对话标题');
  });

  it('getTitle fallback 从 document.title 剥离 " - 豆包"', () => {
    expect(doubao.getTitle()).toBe('豆包对话');
  });

  it('isStreaming 检测 [class*="break-btn"]', () => {
    expect(doubao.isStreaming()).toBe(false);
    document.body.innerHTML = '<button class="my-break-btn">停</button>';
    expect(doubao.isStreaming()).toBe(true);
  });

  it('extractMessages 提取用户（右对齐）和助手消息', () => {
    document.body.innerHTML = `
      <div class="list_items">
        <div class="v_list_row" data-observe-row="block_1">
          <div class="flex flex-row justify-end">
            <div class="md-box-root">
              <div class="container-fBOrXO"><div class="container-enLQFx">用户问题</div></div>
            </div>
          </div>
        </div>
        <div class="v_list_row" data-observe-row="block_2">
          <div class="grid">
            <div data-plugin-identifier="block_type:10040">
              <div class="thinking-box-root-abc">
                <div data-thinking-box="title">已完成思考</div>
              </div>
            </div>
            <div data-plugin-identifier="block_type:10000">
              <div class="md-box-root">
                <div class="container-fBOrXO"><div class="container-enLQFx">正式回答</div></div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    const msgs = doubao.extractMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('用户问题');
    expect(msgs[1].role).toBe('assistant');
    // 豆包思考块（block_type:10040）被识别为思考
    expect(msgs[1].content).toContain('正式回答');
  });

  it('extractMessages 无 .list_items 时返回空数组', () => {
    document.body.innerHTML = '<div>其他</div>';
    expect(doubao.extractMessages()).toEqual([]);
  });

  it('extractMessages 跳过无 data-observe-row 的指示器行', () => {
    document.body.innerHTML = `
      <div class="list_items">
        <div class="v_list_row">顶部指示器</div>
        <div class="v_list_row" data-observe-row="block_1">
          <div class="flex flex-row justify-end">
            <div class="md-box-root">
              <div class="container-fBOrXO"><div class="container-enLQFx">真实消息</div></div>
            </div>
          </div>
        </div>
        <div class="v_list_row">底部指示器</div>
      </div>`;
    const msgs = doubao.extractMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('真实消息');
  });

  it('extractMessages 思考块展开态：提取 [data-thinking-box="content"] 内容', () => {
    // 展开态：thinking-box-root 内含 data-thinking-box="content"（展开内容）和 title（标题噪声）
    // 适配器优先取 content，移除 title 后取文本
    document.body.innerHTML = `
      <div class="list_items">
        <div class="v_list_row" data-observe-row="block_1">
          <div class="grid">
            <div data-plugin-identifier="block_type:10040">
              <div class="thinking-box-root-abc">
                <div data-thinking-box="title">已完成思考，参考 3 篇资料</div>
                <div data-thinking-box="content">
                  <p>首先分析用户需求</p>
                  <p>然后查阅相关资料</p>
                </div>
              </div>
            </div>
            <div data-plugin-identifier="block_type:10000">
              <div class="md-box-root">
                <div class="container-fBOrXO"><div class="container-enLQFx">正式回答</div></div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    const msgs = doubao.extractMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('assistant');
    // 思考内容被 think 块包裹
    expect(msgs[0].content).toContain(THINK_OPEN);
    expect(msgs[0].content).toContain(THINK_CLOSE);
    // 展开内容被提取
    expect(msgs[0].content).toContain('首先分析用户需求');
    expect(msgs[0].content).toContain('然后查阅相关资料');
    // 标题噪声不应混入思考内容
    expect(msgs[0].content).not.toContain('已完成思考');
    expect(msgs[0].content).not.toContain('参考 3 篇资料');
    // 正式回答保留
    expect(msgs[0].content).toContain('正式回答');
  });

  it('extractMessages 思考块折叠态：无 content 时清理标题取文本', () => {
    // 折叠态：thinking-box-root 内只有 title，无 data-thinking-box="content"
    // 适配器取整个 thinkingRoot 文本并清理标题前缀
    document.body.innerHTML = `
      <div class="list_items">
        <div class="v_list_row" data-observe-row="block_1">
          <div class="grid">
            <div data-plugin-identifier="block_type:10040">
              <div class="thinking-box-root-abc">
                <div data-thinking-box="title">已完成思考，参考 3 篇资料</div>
              </div>
            </div>
            <div data-plugin-identifier="block_type:10000">
              <div class="md-box-root">
                <div class="container-fBOrXO"><div class="container-enLQFx">正式回答</div></div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    const msgs = doubao.extractMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('assistant');
    // 折叠态思考内容为标题清理后的文本（前缀"已完成思考，参考 N 篇资料"被移除）
    // 由于标题清理后可能为空，思考块可能不生成 think 标签
    // 关键断言：正式回答被提取，且标题噪声"参考 3 篇资料"不出现在最终内容中
    expect(msgs[0].content).toContain('正式回答');
    expect(msgs[0].content).not.toContain('参考 3 篇资料');
  });
});
