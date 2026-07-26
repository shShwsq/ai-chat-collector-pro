# Qdrant 部署说明

Qdrant 是一个开源的高性能向量搜索引擎，Chrome 扩展通过 Qdrant REST API 访问。

## 部署步骤

### 1. 启动 Qdrant 服务（Docker 推荐）

```bash
docker run -d -p 6333:6333 \
  -v $(pwd)/qdrant-data:/qdrant/storage \
  --name qdrant \
  --restart unless-stopped \
  qdrant/qdrant
```

启动后服务地址默认为 `http://localhost:6333`。

### 2. 创建 Collection

Qdrant 需要先创建 collection 并指定向量维度：

```bash
curl -X PUT http://localhost:6333/collections/ai_chat_vectors \
  -H "Content-Type: application/json" \
  -d '{
    "vectors": {
      "size": 1024,
      "distance": "Cosine"
    }
  }'
```

> **注意**：`size` 必须与 embedding 模型输出维度一致。text-embedding-v4 = 1024 维。

### 3. 在本扩展配置中填写

| 字段 | 填写内容 |
|---|---|
| **服务地址** | Qdrant REST API 地址，如 `http://localhost:6333` |
| **API Key** | Qdrant 默认无认证，留空。生产环境启用 API Key 后填写 |
| **集合/表名** | collection 名称，如 `ai_chat_vectors` |

## 启用 API Key 认证

```bash
docker run -d -p 6333:6333 \
  -e QDRANT__SERVICE__API_KEY="your-secret-key" \
  -v $(pwd)/qdrant-data:/qdrant/storage \
  qdrant/qdrant
```

然后在扩展的 "API Key" 字段填写该 key。

## 云端方案：Qdrant Cloud

Qdrant 提供官方云托管服务：

1. 访问 [Qdrant Cloud](https://cloud.qdrant.io/) 注册
2. 创建 Cluster，选择 region（推荐 AWS Singapore 或 GCP Asia）
3. 获取 Cluster URL 和 API Key
4. 在扩展中填写：
   - **服务地址**：如 `https://xxxxx.aws.cloud.qdrant.io:6333`
   - **API Key**：Qdrant Cloud API Key
   - **集合/表名**：`ai_chat_vectors`（需在 Qdrant Cloud 控制台或通过 API 创建）

免费计划包含 1GB 集群，适合个人使用。

## 生产环境部署

### 集群模式（高可用）

生产环境推荐 docker-compose 部署多节点集群，详见 [Qdrant 集群文档](https://qdrant.tech/documentation/cluster/)。

### 配置 TLS

```bash
docker run -d -p 6333:6333 \
  -v $(pwd)/certs:/tls \
  -e QDRANT__SERVICE__TLS__CERT="/tls/cert.pem" \
  -e QDRANT__SERVICE__TLS__KEY="/tls/key.pem" \
  qdrant/qdrant
```

启用 TLS 后服务地址需改为 `https://`。

## 常见问题

**Q: 报错 "Collection not found"？**
A: Qdrant 不会自动创建 collection。需先通过 API 创建（见上方步骤 2）。

**Q: 报错 "Wrong vector size"？**
A: collection 创建时的 `size` 必须与 embedding 模型维度一致（1024）。如需修改，只能删了 collection 重建。

**Q: 启用了 API Key 但扩展报 401？**
A: 确认 API Key 字段填写正确。Qdrant 使用 `api-key` header，与扩展代码兼容。

**Q: 启用了 TLS 但扩展连接失败？**
A: Chrome 扩展的 fetch 支持 HTTPS，但需要证书有效。自签证书需在浏览器中先访问一次接受证书。

## 参考

- [Qdrant 官方文档](https://qdrant.tech/documentation/)
- [Qdrant REST API 参考](https://qdrant.github.io/qdrant/redoc/index.html)
- [Qdrant Cloud](https://cloud.qdrant.io/)
- [Qdrant GitHub](https://github.com/qdrant/qdrant)
