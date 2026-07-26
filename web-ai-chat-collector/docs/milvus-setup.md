# Milvus 部署说明

Milvus 是一个开源的高性能向量数据库，Chrome 扩展通过 Milvus v2 REST API 访问。

## 部署步骤（Docker Compose 推荐）

### 1. 下载 docker-compose 配置

```bash
wget https://github.com/milvus-io/milvus/releases/download/v2.4.0/milvus-standalone-docker-compose.yml -O docker-compose.yml
```

### 2. 启动 Milvus

```bash
docker-compose up -d
```

默认 RESTful API 端口为 `19530`（v2 路径 `/v2/vectordb/...` 走此端口）；`9091` 是 metrics/management 端口，不提供 vectordb REST 接口。

### 3. 创建 Collection + Index

通过 REST API 创建 collection（需先创建 schema）：

```bash
curl -X POST http://localhost:19530/v2/vectordb/collections/create \
  -H "Content-Type: application/json" \
  -d '{
    "collectionName": "ai_chat_vectors",
    "schema": {
      "autoId": false,
      "fields": [
        {"fieldName": "id", "dataType": "VarChar", "isPrimary": true, "elementTypeParams": {"max_length": "256"}},
        {"fieldName": "vector", "dataType": "FloatVector", "elementTypeParams": {"dim": "1024"}},
        {"fieldName": "convId", "dataType": "VarChar", "elementTypeParams": {"max_length": "256"}},
        {"fieldName": "title", "dataType": "VarChar", "elementTypeParams": {"max_length": "512"}},
        {"fieldName": "platform", "dataType": "VarChar", "elementTypeParams": {"max_length": "64"}},
        {"fieldName": "role", "dataType": "VarChar", "elementTypeParams": {"max_length": "32"}},
        {"fieldName": "content", "dataType": "VarChar", "elementTypeParams": {"max_length": "4096"}},
        {"fieldName": "msgHash", "dataType": "VarChar", "elementTypeParams": {"max_length": "256"}},
        {"fieldName": "chunkIdx", "dataType": "Int64"},
        {"fieldName": "chunkTotal", "dataType": "Int64"}
      ]
    },
    "indexParams": [
      {"fieldName": "vector", "metricType": "COSINE", "indexType": "AUTOINDEX"}
    ]
  }'
```

> **字段说明**：扩展会把每条向量的元数据展平成行字段写入。`convId` 用于按对话删除；`title/platform/role/content` 让远程向量库成为自包含数据，可被外部智能体（如 openclaw）作为知识源直接检索消费。
>
> **`isPrimary: true`**：Milvus v2 RESTful API 要求显式声明主键字段，否则会返回 `{"code":65535,"message":"primary key is not specified"}`。
>
> **content 的 max_length**：应不小于扩展设置中的 `chunkSize`（默认 500）。上面取 4096 已留足余量；若你调大了 `chunkSize`，请同步调大此值，否则超长切片写入会失败。

### 4. Load Collection

创建后必须显式 load，否则后续 query/search 会报错：

```bash
curl -X POST http://localhost:19530/v2/vectordb/collections/load \
  -H "Content-Type: application/json" \
  -d '{"collectionName": "ai_chat_vectors"}'
```

可选：通过 describe 验证 collection 结构：

```bash
curl -X POST http://localhost:19530/v2/vectordb/collections/describe \
  -H "Content-Type: application/json" \
  -d '{"collectionName": "ai_chat_vectors"}'
```

### 5. 在本扩展配置中填写

| 字段 | 填写内容 |
|---|---|
| **服务地址** | Milvus RESTful API 地址，如 `http://localhost:19530` |
| **API Key** | Milvus 默认无认证，留空。Zilliz Cloud 或启用 RBAC 时填写 root:Milvus 或 token |
| **集合/表名** | collection 名称，如 `ai_chat_vectors` |

## 云端方案：Zilliz Cloud

Zilliz Cloud 是 Milvus 的官方托管服务：

1. 注册 [Zilliz Cloud](https://zilliz.com/)，创建 cluster
2. 在 cluster 详情页获取 Public Endpoint，如 `https://in03-xxx.aws.zillizcloud.com`
3. 创建 API Key（Token）
4. 在扩展中填写：
   - **服务地址**：Zilliz Cloud Public Endpoint
   - **API Key**：Zilliz Cloud Token
   - **集合/表名**：在 Zilliz Cloud 控制台创建的 collection 名

## 常见问题

**Q: 启动后连接失败？**
A: 确认 RESTful API 端口 19530 可访问。注意 Milvus 端口分工：`19530` 是 gRPC + RESTful v2 接口（扩展使用此端口访问 `/v2/vectordb/...`），`9091` 是 metrics/management 端口（不提供 vectordb REST 接口，访问会返回 404）。

**Q: 创建 collection 报错 `{"code":65535,"message":"primary key is not specified"}`？**
A: Milvus v2 RESTful API 要求显式声明主键字段，schema 中的主键字段需加 `"isPrimary": true`。

**Q: 创建 collection 报错 "dimension mismatch"？**
A: collection 的向量维度必须与 embedding 模型输出维度一致。text-embedding-v4 为 1024 维。

**Q: query/search 报错 collection 未加载？**
A: Milvus 在创建 collection 后必须显式调用 load 接口加载到内存，否则无法查询。参见上方第 4 步。

## 参考

- [Milvus 官方文档](https://milvus.io/docs)
- [Milvus REST API 参考](https://milvus.io/api-reference/rest/v2.x/About.md)
- [Zilliz Cloud](https://zilliz.com/)
