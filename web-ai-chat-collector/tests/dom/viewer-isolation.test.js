// 端到端验证：插件 viewer 打开后，各平台适配器不会误扫 viewer 内的 KaTeX/消息
// 这是一个回归测试，确保 viewer 注入到 document.body 后不会被 extractMessages 扫到
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadDomAdapter, setBody } from '../helpers/load-source.js';

const ROOT = process.cwd();
const kimiHtml = fs.readFileSync(path.join(ROOT, 'references', 'improve', 'kimi_int.txt'), 'utf-8');

describe('插件 UI 预览区隔离验证', () => {
  it('Kimi 适配器不扫描 viewer 内的 KaTeX（kimi_int.txt 样本）', () => {
    const kimiAdapter = loadDomAdapter('kimi');

    // kimi_int.txt 是用户复制页面时连 viewer 一起复制的，包含 .viewer-box
    setBody(kimiHtml);

    // 确认样本中确实存在 viewer 元素
    const viewerBox = document.querySelector('.viewer-box');
    expect(viewerBox, '样本中应包含 .viewer-box').not.toBeNull();
    const viewerKatexCount = document.querySelectorAll('.viewer-box .katex-html').length;
    expect(viewerKatexCount, 'viewer 内应有 .katex-html').toBeGreaterThan(0);

    // 提取消息
    const messages = kimiAdapter.extractMessages(document);

    // 检查是否有 viewer 内容泄漏
    // viewer 内的积分公式因 mtight 样式结构丢失，会渲染为 \int 02\pi 这种损坏形式
    // 如果适配器正确隔离了 viewer，messages 中不应出现这种损坏内容
    const viewerLeak = messages.find(m =>
      m.content.includes('\\int 02') ||
      m.content.includes('∫ 02') ||
      m.content.includes('02π') ||
      m.content.includes('inftylim')
    );
    expect(viewerLeak, '不应有 viewer 内容泄漏到提取结果').toBeUndefined();
  });
});
