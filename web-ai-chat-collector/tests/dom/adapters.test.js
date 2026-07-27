// tests/dom/adapters.test.js
// 6 个平台 DOM 适配器测试：kimi / deepseek / qianwen / fudan / doubao / yuanbao
//
// 这是"平台 DOM 改了立刻发现"的核心防线：
// 每个平台用 1-2 个最小 DOM fixture 覆盖 getConversationId / getTitle / isStreaming / extractMessages。
// 当平台升级 DOM 结构（改 class 名、重组容器层级、移除/新增节点）时，对应测试会立即失败。
//
// fixtures 基于 project_memory 中记录的真实 DOM 结构构造，只保留适配器依赖的关键 class/属性。
// 真实平台 DOM 更复杂（含噪声元素、嵌套层级），但这些 fixture 足以验证适配器的核心提取逻辑。

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { loadDomAdapter } from '../helpers/load-source.js';

let kimi, deepseek, qianwen, fudan, doubao, yuanbao;

beforeAll(() => {
  // 分别加载 6 个平台适配器（每次都会重新加载 turndown + html-to-markdown + katex-html-to-latex）
  kimi = loadDomAdapter('kimi');
  deepseek = loadDomAdapter('deepseek');
  qianwen = loadDomAdapter('qianwen');
  fudan = loadDomAdapter('fudan');
  doubao = loadDomAdapter('doubao');
  yuanbao = loadDomAdapter('yuanbao');
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

// =================================================================
// 腾讯元宝适配器
// =================================================================
describe('腾讯元宝适配器', () => {
  beforeEach(() => resetEnv('/chat/naQivTmsDa/0P71bwF3Gl6', '', '上海今日天气与降雨情况'));

  it('getConversationId 从 /chat/{agentId}/{convId} 提取第二段', () => {
    // URL 格式: https://yuanbao.tencent.com/chat/{agentId}/{convId}
    // 适配器只提取第二段（convId），忽略第一段（agentId）
    expect(yuanbao.getConversationId()).toBe('0P71bwF3Gl6');
  });

  it('getConversationId 第二段缺失时返回 default', () => {
    resetEnv('/chat/naQivTmsDa/');
    expect(yuanbao.getConversationId()).toBe('default');
  });

  it('getConversationId 无 /chat/ 前缀时返回 default', () => {
    resetEnv('/');
    expect(yuanbao.getConversationId()).toBe('default');
  });

  it('getTitle 优先从侧边栏 active 项提取标题', () => {
    // 真实场景：侧边栏 .yb-recent-conv-list__item.active 内的 .yb-recent-conv-list__item-name 含当前对话标题
    // 优先级高于 document.title（新对话刚发起时 document.title 可能未更新）
    document.body.innerHTML = `
      <div class="yb-recent-conv-list">
        <div class="yb-recent-conv-list__item">
          <div class="yb-recent-conv-list__item-name" data-item-id="other">其他对话</div>
        </div>
        <div class="yb-recent-conv-list__item active">
          <div class="yb-recent-conv-list__item-name" data-item-id="0P71bwF3Gl6">贪吃蛇代码测试与运行结果</div>
        </div>
      </div>`;
    expect(yuanbao.getTitle()).toBe('贪吃蛇代码测试与运行结果');
  });

  it('getTitle 侧边栏无 active 项时降级到 document.title', () => {
    document.body.innerHTML = '<div class="yb-recent-conv-list"></div>';
    expect(yuanbao.getTitle()).toBe('上海今日天气与降雨情况');
  });

  it('getTitle 侧边栏 active 项含"元宝"默认标题时降级到 document.title', () => {
    // 新对话刚发起时，侧边栏 active 项可能显示"元宝"默认标题，应降级
    document.body.innerHTML = `
      <div class="yb-recent-conv-list__item active">
        <div class="yb-recent-conv-list__item-name">元宝</div>
      </div>`;
    expect(yuanbao.getTitle()).toBe('上海今日天气与降雨情况');
  });

  it('getTitle 首页标题"元宝 - 轻松工作 多点生活"返回"未命名对话"', () => {
    resetEnv('/', '', '元宝 - 轻松工作 多点生活');
    document.body.innerHTML = '';
    expect(yuanbao.getTitle()).toBe('未命名对话');
  });

  it('getTitle 空标题时返回"未命名对话"', () => {
    resetEnv('/chat/abc/def', '', '');
    document.body.innerHTML = '';
    expect(yuanbao.getTitle()).toBe('未命名对话');
  });

  it('isStreaming 无消息时返回 false', () => {
    expect(yuanbao.isStreaming()).toBe(false);
  });

  it('isStreaming 最后消息 data-conv-outputting="true" 时为 true', () => {
    document.body.innerHTML = `
      <div class="agent-chat__list__item" data-conv-outputting="false"></div>
      <div class="agent-chat__list__item" data-conv-outputting="true"></div>`;
    expect(yuanbao.isStreaming()).toBe(true);
  });

  it('isStreaming 最后消息 data-conv-status="running" 时为 true', () => {
    document.body.innerHTML = `
      <div class="agent-chat__list__item" data-conv-status="finished"></div>
      <div class="agent-chat__list__item" data-conv-status="running"></div>`;
    expect(yuanbao.isStreaming()).toBe(true);
  });

  it('isStreaming 最后消息含 .hyc-content-md（无 -done 后缀）时为 true', () => {
    // 兜底信号：流式生成中存在未完成的 markdown 段（class 含 hyc-content-md 但不含 hyc-content-md-done）
    document.body.innerHTML = `
      <div class="agent-chat__list__item">
        <div class="hyc-content-md"></div>
      </div>`;
    expect(yuanbao.isStreaming()).toBe(true);
  });

  it('isStreaming 已完成消息（outputting=false, status=finished, 全 -done）时为 false', () => {
    document.body.innerHTML = `
      <div class="agent-chat__list__item" data-conv-outputting="false" data-conv-status="finished">
        <div class="hyc-content-md hyc-content-md-done"></div>
      </div>`;
    expect(yuanbao.isStreaming()).toBe(false);
  });

  it('extractMessages 提取用户消息（.hyc-content-text）', () => {
    document.body.innerHTML = `
      <div class="agent-chat__list__content">
        <div class="agent-chat__list__item agent-chat__list__item--human" data-conv-speaker="human">
          <div class="agent-chat__bubble--human">
            <div class="agent-chat__bubble__content">
              <div class="hyc-component-text">
                <div class="hyc-content-text">今天上海下雨吗</div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    const msgs = yuanbao.extractMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('今天上海下雨吗');
  });

  it('extractMessages 形态A：深度搜索（思考+搜索结果+正式回答）', () => {
    // 真实场景（yuanbao.txt）：.hyc-component-deepsearch-cot 内含 __think（思考步骤+搜索结果），
    // 正式回答 .hyc-content-md-done 也在 .hyc-component-deepsearch-cot 内，但在 __think 外（兄弟关系）。
    // 适配器用 closest('.hyc-component-deepsearch-cot__think') 排除思考步骤，保留正式回答。
    document.body.innerHTML = `
      <div class="agent-chat__list__content">
        <div class="agent-chat__list__item agent-chat__list__item--human" data-conv-speaker="human">
          <div class="agent-chat__bubble--human">
            <div class="hyc-component-text"><div class="hyc-content-text">今天上海下雨吗</div></div>
          </div>
        </div>
        <div class="agent-chat__list__item agent-chat__list__item--ai" data-conv-speaker="ai">
          <div class="agent-chat__bubble--ai">
            <div class="agent-chat__conv--ai__speech_show">
              <div class="hyc-component-deepsearch-cot">
                <div class="hyc-component-deepsearch-cot__think">
                  <div class="hyc-component-deepsearch-cot__think__content">
                    <div class="hyc-component-deepsearch-cot__think__content__item hyc-component-deepsearch-cot__think__content__item-text">
                      <div class="hyc-content-md hyc-content-md-done">
                        <div class="hyc-common-markdown hyc-common-markdown-style-cot">
                          <div class="ybc-p">用户问的是今天上海是否下雨，需检索天气数据</div>
                        </div>
                      </div>
                    </div>
                    <div class="hyc-component-deepsearch-cot__think__content__item hyc-component-deepsearch-cot__think__content__item-search">
                      <div class="hyc-component-deepsearch-cot__think__content__item__doc-container">
                        <div class="hyc-component-deepsearch-cot__think__content__item__doc">
                          <div class="hyc-component-deepsearch-cot__think__content__item__doc__title">
                            <span class="hyc-component-deepsearch-cot__think__content__item__doc__title__text">上海天气预报</span>
                          </div>
                        </div>
                      </div>
                      <div class="hyc-component-deepsearch-cot__think__content__item__doc-container">
                        <div class="hyc-component-deepsearch-cot__think__content__item__doc">
                          <div class="hyc-component-deepsearch-cot__think__content__item__doc__title">
                            <span class="hyc-component-deepsearch-cot__think__content__item__doc__title__text">7月27日上海早新闻</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="hyc-content-md hyc-content-md-done">
                  <div class="hyc-common-markdown hyc-common-markdown-style">
                    <div class="ybc-p">今天上海<strong>目前没下雨</strong>，但午后局部地区可能有短时阵雨。</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    const msgs = yuanbao.extractMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('今天上海下雨吗');
    expect(msgs[1].role).toBe('assistant');
    // 思考被 think 块包裹
    expect(msgs[1].content).toContain(THINK_OPEN);
    expect(msgs[1].content).toContain(THINK_CLOSE);
    expect(msgs[1].content).toContain('用户问的是今天上海是否下雨');
    // 搜索结果被 search_result 块包裹，仅含标题（不含 URL）
    expect(msgs[1].content).toContain('<search_result>');
    expect(msgs[1].content).toContain('</search_result>');
    expect(msgs[1].content).toContain('上海天气预报');
    expect(msgs[1].content).toContain('7月27日上海早新闻');
    // 正式回答保留，strong 标签转 markdown
    expect(msgs[1].content).toContain('目前没下雨');
    expect(msgs[1].content).toContain('**');
  });

  it('extractMessages 形态C：简单回答（仅 .hyc-content-md-done，无思考块）', () => {
    document.body.innerHTML = `
      <div class="agent-chat__list__content">
        <div class="agent-chat__list__item agent-chat__list__item--ai" data-conv-speaker="ai">
          <div class="agent-chat__bubble--ai">
            <div class="agent-chat__conv--ai__speech_show">
              <div class="hyc-content-md hyc-content-md-done">
                <div class="hyc-common-markdown hyc-common-markdown-style">
                  <div class="ybc-p">直接回答，无思考过程</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    const msgs = yuanbao.extractMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('assistant');
    expect(msgs[0].content).toBe('直接回答，无思考过程');
    // 无思考块时不生成 think 标签
    expect(msgs[0].content).not.toContain(THINK_OPEN);
  });

  it('extractMessages 形态B：Agent 模式（.hyc-component-deep-search-agent 内的正式回答）', () => {
    // 真实场景（yuanbao_code.txt）：.hyc-component-deep-search-agent 内直接含 .hyc-content-md-done（正式回答），
    // 另有 .hyc-card-box-process-list.--hidden（Agent 操作过程卡片，折叠态，不提取）。
    // 适配器将 Agent 模式与简单回答模式统一处理，直接提取 .hyc-content-md-done。
    document.body.innerHTML = `
      <div class="agent-chat__list__content">
        <div class="agent-chat__list__item agent-chat__list__item--ai" data-conv-speaker="ai">
          <div class="agent-chat__bubble--ai">
            <div class="agent-chat__conv--ai__speech_show">
              <div class="hyc-card-box-process-list hyc-card-box-process-list--hidden">
                <div class="agent-process-timeline__step">创建文件 snake_game.py</div>
                <div class="agent-process-timeline__step">运行测试 13/13 通过</div>
              </div>
              <div class="">
                <div class="agent-chat__speech-text--box">
                  <div class="hyc-component-deep-search-agent">
                    <div class="hyc-content-md hyc-content-md-done">
                      <div class="hyc-common-markdown hyc-common-markdown-style">
                        <div class="ybc-p">完美运行！蛇在终端里成功吃到了 18 个食物。</div>
                        <div class="ybc-p">我给你写了两个版本，都已就绪：</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    const msgs = yuanbao.extractMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('assistant');
    // Agent 模式不包 think 块（无思考块）
    expect(msgs[0].content).not.toContain(THINK_OPEN);
    // 正式回答被提取
    expect(msgs[0].content).toContain('完美运行');
    expect(msgs[0].content).toContain('两个版本');
    // 操作过程卡片内容不混入正式回答
    expect(msgs[0].content).not.toContain('创建文件 snake_game.py');
    expect(msgs[0].content).not.toContain('运行测试 13/13 通过');
  });

  it('extractMessages 无 .agent-chat__list__content 时返回空数组', () => {
    document.body.innerHTML = '<div>其他内容</div>';
    expect(yuanbao.extractMessages()).toEqual([]);
  });

  it('extractMessages 跳过无 speaker 的非消息项（指示器行）', () => {
    document.body.innerHTML = `
      <div class="agent-chat__list__content">
        <div class="agent-chat__list__item">顶部指示器</div>
        <div class="agent-chat__list__item agent-chat__list__item--human" data-conv-speaker="human">
          <div class="agent-chat__bubble--human">
            <div class="hyc-component-text"><div class="hyc-content-text">真实消息</div></div>
          </div>
        </div>
      </div>`;
    const msgs = yuanbao.extractMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('真实消息');
    expect(msgs[0].content).not.toContain('顶部指示器');
  });

  it('extractMessages 形态A 引用标记噪声过滤（.hyc-common-markdown__ref-list）', () => {
    // 真实场景：思考块内含 .hyc-common-markdown__ref-list 引用标记图标容器（img 图标，无实际 URL）
    // html-to-markdown.js 的 NOISE_SELECTORS 已将其加入噪声过滤，不应混入提取内容
    document.body.innerHTML = `
      <div class="agent-chat__list__content">
        <div class="agent-chat__list__item agent-chat__list__item--ai" data-conv-speaker="ai">
          <div class="agent-chat__bubble--ai">
            <div class="agent-chat__conv--ai__speech_show">
              <div class="hyc-component-deepsearch-cot">
                <div class="hyc-component-deepsearch-cot__think">
                  <div class="hyc-component-deepsearch-cot__think__content">
                    <div class="hyc-component-deepsearch-cot__think__content__item hyc-component-deepsearch-cot__think__content__item-text">
                      <div class="hyc-content-md hyc-content-md-done">
                        <div class="hyc-common-markdown hyc-common-markdown-style-cot">
                          <div class="ybc-p">降水概率 0%
                            <div class="hyc-common-markdown__ref-list">
                              <div class="hyc-common-markdown__ref-list__trigger">
                                <div class="hyc-common-markdown__ref-list__item">
                                  <img src="https://example.com/icon.png">
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div class="hyc-content-md hyc-content-md-done">
                  <div class="hyc-common-markdown hyc-common-markdown-style">
                    <div class="ybc-p">正式回答</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    const msgs = yuanbao.extractMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('assistant');
    // 引用标记的 img URL 不应混入思考内容
    expect(msgs[0].content).not.toContain('https://example.com/icon.png');
    expect(msgs[0].content).not.toContain('ref-list');
    // 思考与正式回答均保留
    expect(msgs[0].content).toContain('降水概率 0%');
    expect(msgs[0].content).toContain('正式回答');
  });

  it('extractMessages 表格：.ybc-p 单元格内段落不破坏 GFM 表格识别', () => {
    // 真实场景（yuanbao_code.txt）：每个 th/td 内含 <div class="ybc-p"> 包裹内容
    // .ybc-p 默认输出 \n\n（段落分隔），但单元格内换行会破坏 GFM 表格规则
    // 适配器在单元格内改用空格连接，确保表格被正确识别为 | col1 | col2 | 格式
    document.body.innerHTML = `
      <div class="agent-chat__list__content">
        <div class="agent-chat__list__item agent-chat__list__item--ai" data-conv-speaker="ai">
          <div class="agent-chat__bubble--ai">
            <div class="agent-chat__conv--ai__speech_show">
              <div class="hyc-content-md hyc-content-md-done">
                <div class="hyc-common-markdown hyc-common-markdown-style">
                  <div class="hyc-common-markdown__table-wrapper isDark">
                    <div class="hyc-common-markdown__table-actions-sticky">
                      <button>复制</button>
                    </div>
                    <table><thead><tr><th><div class="ybc-p">文件</div></th><th><div class="ybc-p">说明</div></th></tr></thead><tbody><tr><td><div class="ybc-p"><code class="hyc-common-markdown__code__inline">snake_game.py</code></div></td><td><div class="ybc-p"><strong>图形界面版</strong>（Pygame），本地电脑直接玩</div></td></tr><tr><td><div class="ybc-p"><code class="hyc-common-markdown__code__inline">snake_terminal.py</code></div></td><td><div class="ybc-p"><strong>终端版</strong>，服务器环境可运行</div></td></tr></tbody></table>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    const msgs = yuanbao.extractMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('assistant');
    // 表格被识别为 GFM 管道符表格（含表头分隔行）
    expect(msgs[0].content).toMatch(/\| 文件\s*\| 说明\s*\|/);
    expect(msgs[0].content).toMatch(/\| [`]snake_game\.py[`]\s*\| \*\*图形界面版\*\*/);
    expect(msgs[0].content).toMatch(/\| [`]snake_terminal\.py[`]\s*\| \*\*终端版\*\*/);
    // 表格操作按钮文字"复制"不混入
    expect(msgs[0].content).not.toContain('复制');
  });

  it('extractMessages 代码块：3 层 pre 嵌套结构正确提取，无多余语言文字', () => {
    // 真实场景（yuanbao_code.txt）：代码块为 3 层 pre 嵌套
    //   pre.ybc-pre-component > div.hyc-common-markdown__code > pre.hyc-common-markdown__code-lan > ... > pre > code.language-bash
    // 标题栏的 .hyc-common-markdown__code__langComponent 含语言标签"bash"
    // 问题：turndown 默认 codeBlock 规则匹配最外层 pre 时会把标题栏"bash"当作代码内容输出
    // 适配器自定义 yuanbaoCodeBlock 规则，从 langComponent 提取语言，从最内层 code 提取代码
    document.body.innerHTML = `
      <div class="agent-chat__list__content">
        <div class="agent-chat__list__item agent-chat__list__item--ai" data-conv-speaker="ai">
          <div class="agent-chat__bubble--ai">
            <div class="agent-chat__conv--ai__speech_show">
              <div class="hyc-content-md hyc-content-md-done">
                <div class="hyc-common-markdown hyc-common-markdown-style">
                  <pre class="ybc-pre-component ybc-pre-component_not-math"><div class="hyc-common-markdown__code hyc-common-markdown__code--collapse-v2"><div class="hyc-common-markdown__code__hd"><div class="hyc-common-markdown__code__hd__inner"><div class="hyc-common-markdown__code__hd__l hyc-common-markdown__code__langComponent"><span>bash</span></div><div class="hyc-common-markdown__code__hd__r"><button>复制</button></div></div></div><pre class="hyc-common-markdown__code-lan isDark"><div class="hyc-code-scrollbar"><div class="hyc-code-scrollbar__view"><pre><code class="language-bash">pip install pygame
python snake_game.py</code></pre></div></div></pre></div></pre>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    const msgs = yuanbao.extractMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('assistant');
    // 代码块正确提取，含语言标签 bash
    expect(msgs[0].content).toContain('```bash\npip install pygame\npython snake_game.py\n```');
    // 修复前 bug：代码块前多出"bash"独立段落
    expect(msgs[0].content).not.toMatch(/\nbash\n[^`]/);
    // 复制按钮文字不混入
    expect(msgs[0].content).not.toContain('复制');
  });

  it('extractMessages 文件卡片过滤（.ybc-p--file-card 含图标/文件名/截断代码预览）', () => {
    // 真实场景（yuanbao_code.txt）：助手消息末尾附文件卡片，结构为
    //   .ybc-p.ybc-p--file-card > .hyc-common-markdown--fileLink > .file-card_fileCard__xxx
    //     ├─ .file-card_avatar（含 img 图标，src 为 cos.ap-guangzhou.myqcloud.com 的装饰图标）
    //     ├─ 文件名（snake_game.py）
    //     └─ 截断的代码预览（不完整，如"COLS ="后截断）
    // 文件名已在正文提及，代码预览不完整，图标为装饰性，整块过滤
    document.body.innerHTML = `
      <div class="agent-chat__list__content">
        <div class="agent-chat__list__item agent-chat__list__item--ai" data-conv-speaker="ai">
          <div class="agent-chat__bubble--ai">
            <div class="agent-chat__conv--ai__speech_show">
              <div class="hyc-content-md hyc-content-md-done">
                <div class="hyc-common-markdown hyc-common-markdown-style">
                  <div class="ybc-p">这是正式回答的正文内容。</div>
                  <div class="ybc-p ybc-p--file-card">
                    <div class="hyc-common-markdown--fileLink hyc-common-markdown__replace-fileLink">
                      <div class="file-card_fileCard__gfdDP file-card_cardWall__L1qNc">
                        <div class="file-card_header__UdDYl">
                          <div class="file-card_headerInner__LWFMZ">
                            <div class="file-card_avatar__KPMTb">
                              <img src="https://hunyuan-prod-1258344703.cos.ap-guangzhou.myqcloud.com/public2025/icon/html_icon_dark_test.png">
                            </div>
                            <div class="file-card_fileName">snake_game.py</div>
                          </div>
                        </div>
                        <div class="file-card_content">
                          <pre><code>""" 贪吃蛇游戏 - Python + Pygame """ import pygame # 计算网格 COLS =</code></pre>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    const msgs = yuanbao.extractMessages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('assistant');
    // 正式回答正文保留
    expect(msgs[0].content).toContain('这是正式回答的正文内容');
    // 文件卡片的图标 URL 不混入
    expect(msgs[0].content).not.toContain('cos.ap-guangzhou.myqcloud.com');
    // 文件卡片的截断代码预览不混入
    expect(msgs[0].content).not.toContain('计算网格');
    expect(msgs[0].content).not.toContain('COLS =');
    // 文件卡片的文件名作为独立段落不混入（正文中的文件名引用不受影响）
    expect(msgs[0].content).not.toMatch(/\nsnake_game\.py\n/);
  });
});
