// bg/export.js - 对话导出（Markdown / JSON）
// 依赖：lib/db.js (getConversation, getConversations), chrome.downloads

async function handleExportConversation(id, format = 'markdown') {
  const conv = await getConversation(id);
  if (!conv) return { success: false, error: '对话不存在' };

  const content = formatConversation(conv, format);
  const filename = `${sanitizeFilename(conv.title)}_${conv.platform}.${format === 'markdown' ? 'md' : format}`;
  const mimeType = format === 'json' ? 'application/json' : 'text/plain';

  await downloadFile(content, filename, mimeType);
  return { success: true };
}

async function handleExportAll(format = 'markdown') {
  const list = await getConversations();
  if (list.length === 0) return { success: false, error: '没有可导出的对话' };

  if (format === 'json') {
    const content = JSON.stringify(list, null, 2);
    await downloadFile(content, 'all_conversations.json', 'application/json');
  } else {
    const parts = list.map(conv => formatConversation(conv, format));
    const content = parts.join('\n\n---\n\n');
    await downloadFile(content, 'all_conversations.md', 'text/plain');
  }
  return { success: true };
}

// 格式化对话
function formatConversation(conv, format) {
  if (format === 'json') {
    const messages = conv.messages.map(msg => ({
      role: msg.role,
      content: msg.content
    }));
    return JSON.stringify(messages, null, 2);
  }

  let md = `# ${conv.title}\n\n`;
  md += `> 平台: ${conv.platform} | 创建: ${conv.createdAt} | 更新: ${conv.updatedAt}\n\n`;
  if (conv.url) md += `> 链接: ${conv.url}\n\n`;

  for (const msg of conv.messages) {
    const label = msg.role === 'user' ? '**🧑 用户**' : '**🤖 助手**';
    md += `### ${label}\n\n${jsonContentToMarkdown(msg.content)}\n\n`;
  }
  return md;
}

function jsonContentToMarkdown(content) {
  if (!content) return '';
  let result = content;
  result = result.replace(/<think>\n?([\s\S]*?)\n?<\/think>/g, (_, thinkContent) => {
    const lines = thinkContent.trim().split('\n');
    const quoted = lines.map(line => `> ${line}`).join('\n');
    return `> 💭 **思考过程**\n>\n${quoted}`;
  });
  result = result.replace(/<search_result>\n?([\s\S]*?)\n?<\/search_result>/g, (_, searchContent) => {
    return `🔍 **联网搜索结果**\n\n${searchContent.trim()}`;
  });
  return result;
}

async function downloadFile(content, filename, mimeType) {
  const dataUrl = `data:${mimeType};charset=utf-8,` + encodeURIComponent(content);
  await chrome.downloads.download({
    url: dataUrl,
    filename: `ai-chat-collector/${filename}`,
    saveAs: false
  });
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 50);
}
