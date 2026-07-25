# ChromaDB 部署说明

ChromaDB 是一个开源的本地向量数据库，Chrome 扩展通过 HTTP API 访问。

> **版本要求**：ChromaDB **1.0+**。1.0 起 v1 API 已废弃（返回 `410 Gone`），扩展使用 v2 API。`chromadb/chroma` latest 标签即满足要求。

## 部署步骤

### 1. 启动 ChromaDB 服务（Docker 推荐）

```bash
docker run -d -p 8000:8000 \
  --name chromadb \
  -v /opt/chroma-data:/chroma/chroma \
  --restart unless-stopped \
  chromadb/chroma
```

启动后服务地址默认为 `http://localhost:8000`。

### 2. 创建 Collection

ChromaDB 会在首次插入数据时自动创建 collection，无需手动创建。也可通过 API 提前创建：

```bash
# v2 API 路径须带 tenant/database（默认值即可）
curl -X POST \
  http://localhost:8000/api/v2/tenants/default_tenant/databases/default_database/collections \
  -H "Content-Type: application/json" \
  -d '{"name": "ai_chat_vectors"}'
```

> ⚠️ **不要用 `/api/v1/collections`**，ChromaDB 1.0+ 已废弃 v1 API，会返回 `410 Gone`。

### 3. 在本扩展配置中填写

| 字段 | 填写内容 |
|---|---|
| **服务地址** | ChromaDB 服务地址，如 `http://localhost:8000` |
| **API Key** | ChromaDB 默认无认证，留空即可。生产环境建议加反向代理 + API Key |
| **集合/表名** | collection 名称，如 `ai_chat_vectors` |

## 生产环境部署

### 启用认证（推荐）

ChromaDB 原生支持 token 认证（需 server-tenant 模式）：

```bash
docker run -d -p 8000:8000 \
  --name chromadb \
  -v /opt/chroma-data:/chroma/chroma \
  --restart unless-stopped \
  -e CHROMA_SERVER_AUTH_CREDENTIALS_PROVIDER="chromadb.auth.token.TokenConfigServerAuthCredentialsProvider" \
  -e CHROMA_SERVER_AUTH_PROVIDER="chromadb.auth.token.TokenAuthServerProvider" \
  -e CHROMA_SERVER_AUTH_CREDENTIALS="your-secret-token" \
  chromadb/chroma
```

然后在扩展的 "API Key" 字段填写该 token。

## 远程访问

如需从其他机器访问，将 ChromaDB 部署在服务器上，将 `localhost` 改为服务器 IP 或域名。生产环境务必启用 HTTPS 反向代理。

## 常见问题

**Q: 报错 "Connection refused"？**
A: 检查 ChromaDB 是否启动成功（`docker logs chromadb`），端口是否开放。

**Q: 返回 `410 Gone` 或 "The v1 API is deprecated"？**
A: ChromaDB 1.0+ 废弃了 v1 API。确认使用的是 `chromadb/chroma` latest 镜像（1.0+），扩展已适配 v2 API。若用的是旧版扩展代码，请拉取最新版。

**Q: 启用了认证但扩展连接失败？**
A: ChromaDB 的 token 认证使用 `Authorization: Bearer <token>` 头，与扩展代码兼容。请确认 API Key 字段填写正确。

## 参考

- [ChromaDB 官方文档](https://docs.trychroma.com/)
- [ChromaDB GitHub](https://github.com/chroma-core/chroma)
