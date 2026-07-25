// bg/conversations.js - 对话 CRUD 委托（转发到 lib/db.js）

async function dbSaveConversation(data) {
  try {
    return await saveConversation(data);
  } catch (error) {
    console.error('保存对话失败:', error);
    return { success: false, error: error.message };
  }
}

async function dbGetConversations(filters) {
  return await getConversations(filters);
}

async function dbDeleteConversation(id) {
  return await deleteConversation(id);
}

async function dbGetStatus() {
  return await getStatus();
}

async function dbGetStorageInfo() {
  try {
    return await getStorageInfo();
  } catch (e) {
    console.error('[BG] 获取存储信息失败:', e);
    return { error: e.message };
  }
}

async function dbSearchConversations(query, filters) {
  return await searchConversations(query, filters);
}
