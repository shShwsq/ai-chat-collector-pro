---
name: "search-knowledge"
description: "Searches the user's AI chat history knowledge base via semantic retrieval. Invoke when user asks about previously discussed topics, wants to recall past AI conversations, or queries knowledge base statistics."
---

# AI 对话知识库检索

## 作用

在用户的 AI 对话历史知识库中进行语义检索。知识库存储的是用户过去与各 AI 平台（DeepSeek、豆包、千问等）的对话记录，由 Chrome 扩展自动采集并向量化。

## 什么时候用

**适用场景：**
- "我之前和 AI 聊过关于 XXX 的内容，帮我找找"
- "上次讨论的那个方案是什么"
- "我以前问过类似的问题吗"
- "我的知识库里有多少条记录"
- 任何需要引用用户历史对话来回答的情况

**不适用：**
- 全新需求（不涉及历史对话）
- 与 AI 对话历史无关的信息

## 首次使用：配置

在 SKILL 目录下创建 `.env` 文件（与 SKILL.md 同级），填入实际值：

```bash
# .env 文件内容（复制后修改实际值）

# 向量库类型：chroma / qdrant / pgvector / supabase / milvus
KB_VSTORE_TYPE=chroma

# 向量库地址（不要加末尾斜杠）
# ChromaDB: http://服务器IP:8000
# Qdrant:   http://服务器IP:6333
# pgvector: http://服务器IP:3000  (PostgREST 端口)
# Supabase: https://xxx.supabase.co
# Milvus:   http://服务器IP:19530
KB_VSTORE_URL=http://服务器IP:8000

# 集合/表名
KB_VSTORE_COLLECTION=ai_chat_vectors

# 向量库 API Key（ChromaDB 本地部署不需要；Supabase 需要；Milvus Zilliz Cloud 需要）
KB_VSTORE_API_KEY=

# ============ Embedding 配置（须与 Chrome 扩展写入端一致） ============
# 厂商：dashscope / zhipu / baidu / volcengine / jina / custom
# 必须与 Chrome 扩展「设置 → Embedding」中选定的厂商一致，否则向量空间不匹配、检索无效
KB_EMBEDDING_PROVIDER=dashscope

# 厂商 API Key（与 Chrome 扩展用同一个）
KB_EMBEDDING_API_KEY=sk-你的-api-key

# 模型 ID（预设厂商可留空使用默认值，但建议显式写出以确保与扩展一致）
# KB_EMBEDDING_MODEL=text-embedding-v4

# 厂商 baseUrl（预设厂商可留空；custom 必填）
# KB_EMBEDDING_BASE_URL=

# 期望向量维度（默认 1024，须与向量库 collection schema 匹配）
# KB_EMBEDDING_DIM=1024

# 是否校验 TLS 证书（自签证书设 false）
KB_VSTORE_VERIFY_TLS=false
```

### Embedding 厂商预设值

下面列出各厂商的预设 `baseUrl`、默认模型和维度，方便对照配置（与插件 `models.json` 一致）：

| `KB_EMBEDDING_PROVIDER` | 厂商 | 默认模型 | baseUrl（留空时自动用） | 维度 |
|---|---|---|---|---|
| `dashscope` | 阿里云百炼 DashScope | `text-embedding-v4` | `https://dashscope.aliyuncs.com/api/v1` | 1024 |
| `zhipu` | 智谱 AI | `embedding-3` | `https://open.bigmodel.cn/api/paas/v4` | 1024（带 `dimensions` 参数） |
| `baidu` | 百度千帆 | `bge-large-zh` | `https://qianfan.baidubce.com/v2` | 1024 |
| `volcengine` | 火山引擎豆包 | `doubao-embedding-vision-251215` | `https://ark.cn-beijing.volces.com/api/v3` | 1024（多模态端点） |
| `jina` | Jina AI | `jina-embeddings-v5-text-small` | `https://api.jina.ai/v1` | 1024（带 `dimensions` 参数） |
| `custom` | 自定义 OpenAI 兼容 | 必填 | 必填 | 自定 |

> ⚠️ **关键约束**：检索端 embedding 厂商和模型**必须**与 Chrome 扩展写入端完全一致。不同模型的向量空间不互通，即使维度相同也会导致检索结果错乱。如果扩展里用的是智谱，这里也要填 `zhipu`；扩展里用豆包，这里也要填 `volcengine`。

## 用法

### 检索对话历史

执行以下命令，把 `<查询内容>` 替换成用户的查询：

```bash
python3 scripts/query_knowledge.py search "<查询内容>" --top-k 5
```

示例：
```bash
python3 scripts/query_knowledge.py search "Docker 安全配置" --top-k 5
```

### 查看知识库统计

```bash
python3 scripts/query_knowledge.py stats
```

> 脚本路径：`scripts/query_knowledge.py`（相对 SKILL.md 所在目录）。
> 如果智能体工作目录不同，需用绝对路径。

## 返回结果

### 检索结果

JSON 数组，按相似度从高到低排序：

```json
[
  {
    "id": "conv123::msg::abc::chunk::0",
    "convId": "conv123",
    "title": "Docker 容器安全加固",
    "platform": "deepseek",
    "role": "assistant",
    "content": "可以通过 security_opt 设置 no-new-privileges...",
    "score": 0.85
  }
]
```

| 字段 | 说明 |
|---|---|
| `title` | 对话标题/摘要 |
| `platform` | 来源 AI 平台（deepseek/doubao/qianwen 等） |
| `role` | 消息角色（user=用户提问, assistant=AI 回复） |
| `content` | 对话片段原文（长消息会被切成多个 chunk） |
| `score` | 语义相似度（0-1，越高越相关） |
| `convId` | 对话会话 ID |

### 统计结果

```json
{
  "backend": "chroma",
  "collection": "ai_chat_vectors",
  "embedding_provider": "dashscope",
  "embedding_provider_name": "阿里云百炼 DashScope",
  "embedding_model": "text-embedding-v4",
  "embedding_dim": 1024,
  "count": 1234
}
```

## 回答用户时的注意事项

1. **按 score 排序**：优先引用相似度最高的结果
2. **合并同会话片段**：同 `convId` 的多个 chunk 是同一条消息的不同片段，引用时合并
3. **低分处理**：如果所有结果 score < 0.3，告诉用户"知识库中没有找到相关内容"
4. **说明来源**：引用时标注平台和角色，如"你在 DeepSeek 上问过..."
5. **保留原意**：引用对话内容时不要改写，用引号标出原文

## 示例对话

**用户**：我之前和 AI 聊过 Docker 安全配置，帮我找找

**智能体行为**：
1. 识别这是历史对话检索需求
2. 执行：`python3 scripts/query_knowledge.py search "Docker 安全配置" --top-k 5`
3. 收到 JSON 结果，整理后回复

**智能体回复**：
> 在你的对话历史中找到以下相关内容：
>
> 1. **DeepSeek 对话** - "Docker 容器安全加固"
>    你问：如何配置 Docker 的安全选项？
>    AI 答："可以通过 security_opt 设置 no-new-privileges..."
>    （相似度: 85%）
>
> 2. **豆包对话** - "容器隔离原理"
>    ...
