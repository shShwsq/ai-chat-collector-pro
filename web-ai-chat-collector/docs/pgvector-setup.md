# PostgreSQL + pgvector 部署说明

## 为什么需要 PostgREST？

Chrome 扩展无法直接通过 TCP 连接 PostgreSQL，必须通过 HTTP 网关访问。**PostgREST** 是一个开源的 PostgreSQL → REST API 服务，可将 PG 表自动暴露为 REST 接口。

> ⚠️ **不要使用 PostgREST 9.0.0**——该版本有 `SET LOCAL ROLE` bug，会导致所有请求返回 401。
> 请使用 **v12 或更高版本**（如 `postgrest/postgrest:v12.2.3`）。

## 部署步骤

### 1. 在 PostgreSQL 中启用 pgvector 扩展

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### 2. 创建存储向量的表

表名即配置中的「集合/表名」。

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

### 3. 创建相似度搜索函数

PostgREST 通过 RPC 调用此函数。

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

### 4. 创建 anon 角色并授权

PostgREST 用 `PGRST_DB_ANON_ROLE` 指定的角色执行所有匿名请求。必须在 PG 中创建该角色并授予权限，否则每个请求都会返回 401。

```sql
CREATE ROLE anon NOLOGIN;
GRANT USAGE ON SCHEMA public TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_chat_vectors TO anon;
GRANT EXECUTE ON FUNCTION match_ai_chat_vectors TO anon;
```

### 5. 部署 PostgREST

Docker 一行命令（**必须用 v12+**）：

```bash
docker run -d --name postgrest -p 3000:3000 \
  -e PGRST_DB_URI="postgres://user:pass@host:5432/dbname" \
  -e PGRST_DB_SCHEMAS="public" \
  -e PGRST_DB_ANON_ROLE="anon" \
  postgrest/postgrest:v12.2.3
```

启动后查看日志确认无报错：

```bash
docker logs postgrest --tail 30
```

正常应看到类似：
```
Starting PostgREST 12.2.3...
Successfully connected to PostgreSQL X.Y
Schema cache loaded 1 Relations, ..., 1 Functions
```

**关键**：PostgREST 在启动时加载 schema 和权限信息到内存，**之后不会自动刷新**。每次在 PG 中改了 anon 权限、加了新表/函数、改了 schema 后，都必须重启容器才能生效：

```bash
docker restart postgrest
```

### 6. 在本扩展配置中填写

| 字段 | 填写内容 |
|---|---|
| **服务地址** | PostgREST 根地址，如 `http://localhost:3000`（**不要**带 `/ai_chat` 后缀） |
| **API Key** | PostgREST 的 JWT token（若启用了认证），未启用认证可留空 |
| **集合/表名** | PG 表名，如 `ai_chat_vectors`（**不是数据库名**） |

> **首次测试连通性或保存时**，扩展会弹窗申请对该地址的访问权限（Chrome MV3 安全要求）。
> 点击「允许」即可。权限只针对你填写的具体域，授予后下次不再询问。
> 如果误点「拒绝」，可在 `chrome://extensions` → 本扩展详情 → 权限中重新授权，
> 或者再次点击「测试连通性」按钮重新触发申请。

## 关于 CORS

如果已在扩展端授予了 host 权限，**无需在 PostgREST 端配置 CORS**——Chrome 扩展享有跨域豁免。

## 服务器端验证

部署完成后，在服务器上用 curl 验证（注意 bash 中 URL 要加引号，否则 `&` 会被当成后台运行符）：

```bash
curl -i 'http://localhost:3000/ai_chat_vectors?select=id&limit=1'
```

- 返回 `200 OK` + `[]` 或 JSON 数组 → 部署成功
- 返回 `401` → anon 角色未创建或无权限，回看第 4 步
- 返回 `404` → PostgREST 启动时未扫描到表，检查 `docker logs` 里 "Schema cache loaded" 行是否包含该表
- 返回 `502` → PostgREST 连不上 PG，检查 `PGRST_DB_URI` 和 PG 白名单
- 连接被拒/超时 → 防火墙或安全组未放行 3000 端口

## 排查清单（出现 `Failed to fetch` 时）

按顺序检查：

1. **浏览器能否访问** `http://<你的服务器>:3000/`（直接在地址栏输入，应返回 PostgREST 欢迎信息）
2. **服务器防火墙**是否放行 3000 端口（云服务器需在安全组里加规则）
3. **PostgREST 容器**是否绑定了 `0.0.0.0`（默认是，可检查 `docker ps` 和 `docker logs`）
4. **RDS 白名单**是否包含 PostgREST 服务器的 IP（阿里云 RDS 默认拒绝所有外部 IP）
5. **扩展是否已授予该域权限**：`chrome://extensions` → 本扩展详情 → 权限

## 阿里云 RDS PostgreSQL 用户

阿里云 RDS PG 支持 pgvector。建议在阿里云 ECS 上部署 PostgREST，通过内网访问 RDS（延迟低、免流量费）。

**务必**将部署 PostgREST 的 ECS 服务器 IP 加入 RDS 白名单（控制台 → RDS 实例 → 数据安全性 → 白名单设置），否则 PostgREST 连不上 RDS，返回 502。

## 关于向量条数

本扩展的 pgvector 适配器使用 `Prefer: count=exact` 调用 PostgREST 走真实的 `SELECT count(*)`，所以显示的条数永远准确（相对于 `count=planned` 读 `pg_class.reltuples` 估算值，后者在 DELETE/TRUNCATE 后会陈旧）。

## 参考

- [PostgREST 官方文档](https://postgrest.org/en/stable/)
- [pgvector 项目](https://github.com/pgvector/pgvector)
