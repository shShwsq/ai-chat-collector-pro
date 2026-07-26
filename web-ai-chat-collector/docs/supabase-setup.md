# Supabase 部署说明

Supabase 是基于 PostgreSQL 的开源后端即服务平台，自带 pgvector 支持。Chrome 扩展通过 PostgREST（Supabase 内置）访问。

## 配置步骤

### 1. 创建 Supabase 项目

1. 访问 [Supabase 官网](https://supabase.com/) 注册账号
2. 点击 "New Project"，选择 region（推荐 Singapore / Northeast Asia，离中国近）
3. 设置数据库密码，等待项目创建完成（约 2 分钟）

### 2. 启用 pgvector 扩展

在 Supabase 控制台 → SQL Editor，执行：

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### 3. 创建存储向量的表

在 SQL Editor 中执行：

```sql
CREATE TABLE ai_chat_vectors (
  id TEXT PRIMARY KEY,
  embedding vector(1024),
  conv_id TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 按 conv_id 删除加速
CREATE INDEX ON ai_chat_vectors (conv_id);
```

### 4. 创建相似度搜索函数

PostgREST 通过 RPC 调用此函数：

```sql
CREATE OR REPLACE FUNCTION match_ai_chat_vectors(
  query_embedding vector(1024),
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id TEXT,
  conv_id TEXT,
  metadata JSONB,
  similarity FLOAT
)
LANGUAGE sql STABLE AS $$
  SELECT id, conv_id, metadata,
         1 - (embedding <=> query_embedding) AS similarity
  FROM ai_chat_vectors
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
```

> **注意**：函数名格式为 `match_<表名>`，表名改了函数名也要改。

### 5. 启用 Row Level Security（可选但推荐）

默认 RLS 会阻止所有访问。如只想自己用，可加 policy 放行：

```sql
ALTER TABLE ai_chat_vectors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "允许 anon 读写" ON ai_chat_vectors
  FOR ALL TO anon USING (true) WITH CHECK (true);

GRANT EXECUTE ON FUNCTION match_ai_chat_vectors TO anon;
```

### 6. 获取连接信息

在 Supabase 控制台 → Project Settings → API：
- **Project URL**：`https://xxxxx.supabase.co`
- **API Key**：anon public key（公开可暴露，安全）或 service_role key（权限更高，不要泄漏）

### 7. 在本扩展配置中填写

| 字段 | 填写内容 |
|---|---|
| **服务地址** | Supabase Project URL，如 `https://xxxxx.supabase.co` |
| **API Key** | Supabase anon API Key |
| **集合/表名** | 表名，如 `ai_chat_vectors` |

## 自部署 Supabase

Supabase 是开源的，可以自部署（Docker）：

```bash
git clone https://github.com/supabase/supabase
cd supabase/docker
cp .env.example .env
# 编辑 .env 修改密码、JWT secret 等
docker-compose up -d
```

自部署后服务地址为 `http://localhost:8000`，API Key 在 `.env` 文件的 `ANON_KEY` 中。

## 免费额度

Supabase Free 计划：
- 500MB 数据库存储
- 5GB 带宽
- 2 个免费项目

对于个人 AI 对话采集（每条向量约 4KB），可存储约 10 万条向量。

## 常见问题

**Q: 报 401 Unauthorized？**
A: 检查 API Key 是否为 anon key（不是 service_role key）。检查 RLS policy 是否放行 anon 角色。

**Q: 报 404 Not Found？**
A: 检查表名和函数名是否匹配（`match_<表名>`），大小写敏感（Supabase 默认小写）。

**Q: 维度错误？**
A: vector(1024) 必须与 embedding 模型输出维度一致。text-embedding-v4 = 1024 维。

## 参考

- [Supabase 官方文档](https://supabase.com/docs)
- [Supabase Vector（pgvector 集成指南）](https://supabase.com/docs/guides/ai/vector-columns)
- [Supabase 自部署](https://supabase.com/docs/guides/self-hosting/docker)
