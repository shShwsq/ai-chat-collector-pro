#!/usr/bin/env python3
"""
AI 对话知识库检索脚本（SKILL 配套工具）

用法：
  python3 query_knowledge.py search "查询内容" [--top-k 5]
  python3 query_knowledge.py stats

配置：
  通过环境变量或同目录下的 .env 文件提供以下配置：
    KB_VSTORE_TYPE     向量库类型（chroma/qdrant/pgvector/supabase/milvus）
    KB_VSTORE_URL      向量库地址
    KB_VSTORE_COLLECTION  集合/表名（默认 ai_chat_vectors）
    KB_VSTORE_API_KEY  向量库 API Key（Supabase/Milvus Zilliz 需要，ChromaDB 本地部署不需要）

    KB_EMBEDDING_PROVIDER  Embedding 厂商（dashscope/zhipu/baidu/volcengine/jina/custom）
                           必须与 Chrome 扩展写入端配置一致，否则向量空间不匹配
    KB_EMBEDDING_API_KEY   Embedding 厂商 API Key（与 Chrome 扩展用同一个）
    KB_EMBEDDING_MODEL     模型 ID（须与扩展配置一致；预设厂商有默认值）
    KB_EMBEDDING_BASE_URL  厂商 baseUrl（预设厂商可留空，custom 必填）

  可选：
    KB_VSTORE_VERIFY_TLS  true/false（默认 false，自签证书时跳过校验）
    KB_EMBEDDING_DIM      期望维度（默认 1024，与向量库 schema 匹配）

  兼容字段：
    KB_DASHSCOPE_KEY      旧字段，等价于 KB_EMBEDDING_API_KEY（provider=dashscope 时）
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error
import urllib.parse


# ============================================================
# 配置加载
# ============================================================

# Embedding 厂商预设（与插件 models.json 保持一致）
# backend 取值：
#   dashscope          - 阿里云原生 API（独立端点，input.texts + parameters.text_type）
#   openai             - OpenAI 兼容 /embeddings（智谱/百度/Jina）
#   openai-multimodal  - 多模态端点 /embeddings/multimodal（豆包 vision）
# dimensionsParam=true 时请求体带 dimensions 参数，强制模型输出指定维度
EMBEDDING_PROVIDERS = {
    "dashscope": {
        "name": "阿里云百炼 DashScope",
        "backend": "dashscope",
        "base_url": "https://dashscope.aliyuncs.com/api/v1",
        "default_model": "text-embedding-v4",
        "dimensions_param": False,
    },
    "zhipu": {
        "name": "智谱 AI (BigModel)",
        "backend": "openai",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "default_model": "embedding-3",
        "dimensions_param": True,
    },
    "baidu": {
        "name": "百度千帆",
        "backend": "openai",
        "base_url": "https://qianfan.baidubce.com/v2",
        "default_model": "bge-large-zh",
        "dimensions_param": False,
    },
    "volcengine": {
        "name": "火山引擎豆包",
        "backend": "openai-multimodal",
        "base_url": "https://ark.cn-beijing.volces.com/api/v3",
        "default_model": "doubao-embedding-vision-251215",
        "dimensions_param": True,
    },
    "jina": {
        "name": "Jina AI",
        "backend": "openai",
        "base_url": "https://api.jina.ai/v1",
        "default_model": "jina-embeddings-v5-text-small",
        "dimensions_param": True,
    },
}


def load_config():
    """从环境变量或 .env 文件加载配置（.env 在脚本同目录或父目录）"""
    # 查找 .env：先脚本同目录，再父目录（兼容 scripts/ 子目录结构）
    script_dir = os.path.dirname(os.path.abspath(__file__))
    for env_path in [os.path.join(script_dir, ".env"),
                     os.path.join(os.path.dirname(script_dir), ".env")]:
        if os.path.exists(env_path):
            with open(env_path) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    if "=" in line:
                        key, _, val = line.partition("=")
                        os.environ.setdefault(key.strip(), val.strip())
            break

    required = ["KB_VSTORE_TYPE", "KB_VSTORE_URL"]
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        print(f"错误：缺少环境变量 {missing}", file=sys.stderr)
        print(f"请在 SKILL 目录下创建 .env 文件，配置见 SKILL.md", file=sys.stderr)
        sys.exit(1)

    # Embedding 厂商：默认 dashscope（向后兼容旧配置）
    provider_id = os.environ.get("KB_EMBEDDING_PROVIDER", "dashscope").lower()
    provider = EMBEDDING_PROVIDERS.get(provider_id)

    if not provider:
        # 未知预设视为自定义厂商，走 OpenAI 兼容后端
        provider = {
            "name": f"自定义 ({provider_id})",
            "backend": "openai",
            "base_url": "",
            "default_model": "",
            "dimensions_param": False,
        }

    # API Key：KB_EMBEDDING_API_KEY 优先，回退 KB_DASHSCOPE_KEY（向后兼容）
    api_key = os.environ.get("KB_EMBEDDING_API_KEY") or os.environ.get("KB_DASHSCOPE_KEY", "")
    if not api_key:
        print("错误：缺少 KB_EMBEDDING_API_KEY（或旧字段 KB_DASHSCOPE_KEY）", file=sys.stderr)
        print("请在 .env 中配置 Embedding 厂商的 API Key", file=sys.stderr)
        sys.exit(1)

    # baseUrl：用户自定义优先，否则用预设
    base_url = os.environ.get("KB_EMBEDDING_BASE_URL", "").strip() or provider["base_url"]
    if not base_url:
        print(f"错误：厂商 {provider_id} 无预设 baseUrl，请在 .env 中设置 KB_EMBEDDING_BASE_URL", file=sys.stderr)
        sys.exit(1)

    # 模型：用户配置优先，否则用预设默认
    model = os.environ.get("KB_EMBEDDING_MODEL", "").strip() or provider["default_model"]
    if not model:
        print(f"错误：厂商 {provider_id} 无默认模型，请在 .env 中设置 KB_EMBEDDING_MODEL", file=sys.stderr)
        sys.exit(1)

    return {
        "vstore_type": os.environ["KB_VSTORE_TYPE"],
        "vstore_url": os.environ["KB_VSTORE_URL"].rstrip("/"),
        "vstore_collection": os.environ.get("KB_VSTORE_COLLECTION", "ai_chat_vectors"),
        "vstore_api_key": os.environ.get("KB_VSTORE_API_KEY", ""),
        "verify_tls": os.environ.get("KB_VSTORE_VERIFY_TLS", "false").lower() == "true",
        # Embedding 配置
        "embedding_provider": provider_id,
        "embedding_provider_name": provider["name"],
        "embedding_backend": provider["backend"],
        "embedding_base_url": base_url.rstrip("/"),
        "embedding_api_key": api_key,
        "embedding_model": model,
        "embedding_dim": int(os.environ.get("KB_EMBEDDING_DIM", "1024")),
        "embedding_dimensions_param": provider["dimensions_param"],
    }


# ============================================================
# Embedding 生成
# ============================================================

def _make_ssl_ctx(cfg: dict):
    """构造 SSL 上下文（verify_tls=false 时跳过证书校验）"""
    import ssl
    ctx = ssl.create_default_context()
    if not cfg["verify_tls"]:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _http_post_json(url: str, body: dict, headers: dict, cfg: dict):
    """通用 POST JSON 请求（带 SSL 配置）"""
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={
        "Content-Type": "application/json",
        **headers,
    })
    ctx = _make_ssl_ctx(cfg)
    try:
        resp = urllib.request.urlopen(req, context=ctx)
        return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        err_body = e.read().decode() if e.fp else ""
        print(f"错误：Embedding API 调用失败 HTTP {e.code}: {err_body}", file=sys.stderr)
        sys.exit(1)


def _embed_dashscope(query: str, cfg: dict) -> list:
    """DashScope 原生 API：input.texts + parameters.text_type=query（与写入端 document 配对）"""
    url = f"{cfg['embedding_base_url']}/services/embeddings/text-embedding/text-embedding"
    body = {
        "model": cfg["embedding_model"],
        "input": {"texts": [query]},
        "parameters": {"text_type": "query"},
    }
    result = _http_post_json(url, body, {
        "Authorization": f"Bearer {cfg['embedding_api_key']}",
    }, cfg)
    try:
        return result["output"]["embeddings"][0]["embedding"]
    except (KeyError, IndexError, TypeError):
        print(f"错误：DashScope 返回异常: {json.dumps(result, ensure_ascii=False)}", file=sys.stderr)
        sys.exit(1)


def _embed_openai(query: str, cfg: dict) -> list:
    """OpenAI 兼容 /embeddings 端点（智谱/百度/Jina 等）。
    baseUrl 已含版本前缀（/v1、/v4、/v2 等），直接拼 /embeddings。
    dimensionsParam=true 时带 dimensions 参数强制输出指定维度。
    """
    base = cfg["embedding_base_url"]
    url = f"{base}/embeddings" if base.endswith(("/v1", "/v2", "/v3", "/v4")) else f"{base}/v1/embeddings"
    body = {
        "model": cfg["embedding_model"],
        "input": query,
    }
    if cfg["embedding_dimensions_param"]:
        body["dimensions"] = cfg["embedding_dim"]
    result = _http_post_json(url, body, {
        "Authorization": f"Bearer {cfg['embedding_api_key']}",
    }, cfg)
    if result.get("error"):
        print(f"错误：Embedding API 返回错误: {json.dumps(result['error'], ensure_ascii=False)}", file=sys.stderr)
        sys.exit(1)
    # 兼容两种返回结构：data[0].embedding（标准）或 data.embedding（部分厂商）
    data = result.get("data", [])
    if isinstance(data, list) and data and "embedding" in data[0]:
        vec = data[0]["embedding"]
    elif isinstance(data, dict) and "embedding" in data:
        vec = data["embedding"]
    else:
        print(f"错误：Embedding 返回异常: {json.dumps(result, ensure_ascii=False)}", file=sys.stderr)
        sys.exit(1)
    _check_dimension(vec, cfg)
    return vec


def _embed_openai_multimodal(query: str, cfg: dict) -> list:
    """多模态 Embedding 端点 /embeddings/multimodal（豆包 vision）。
    请求格式：input 为对象数组 [{type:"text", text:"..."}]，必带 encoding_format:"float"。
    """
    base = cfg["embedding_base_url"]
    url = f"{base}/embeddings/multimodal" if base.endswith(("/v1", "/v2", "/v3", "/v4")) else f"{base}/v1/embeddings/multimodal"
    body = {
        "model": cfg["embedding_model"],
        "input": [{"type": "text", "text": query}],
        "encoding_format": "float",
    }
    if cfg["embedding_dimensions_param"]:
        body["dimensions"] = cfg["embedding_dim"]
    result = _http_post_json(url, body, {
        "Authorization": f"Bearer {cfg['embedding_api_key']}",
    }, cfg)
    if result.get("error"):
        print(f"错误：Embedding API 返回错误: {json.dumps(result['error'], ensure_ascii=False)}", file=sys.stderr)
        sys.exit(1)
    # 豆包 multimodal 返回 data.embedding（对象），标准 OpenAI 返回 data[0].embedding（数组）
    data = result.get("data", [])
    if isinstance(data, list) and data and "embedding" in data[0]:
        vec = data[0]["embedding"]
    elif isinstance(data, dict) and "embedding" in data:
        vec = data["embedding"]
    else:
        print(f"错误：Embedding 返回异常: {json.dumps(result, ensure_ascii=False)}", file=sys.stderr)
        sys.exit(1)
    _check_dimension(vec, cfg)
    return vec


def _check_dimension(vec: list, cfg: dict):
    """维度校验：与向量库固定 schema 匹配，不一致直接报错（避免检索结果全错）"""
    if len(vec) != cfg["embedding_dim"]:
        print(f"错误：向量维度不匹配: 期望 {cfg['embedding_dim']}, 实际 {len(vec)}"
              f"（模型: {cfg['embedding_model']}）", file=sys.stderr)
        print("请检查 KB_EMBEDDING_DIM 或更换与向量库 schema 匹配的模型", file=sys.stderr)
        sys.exit(1)


def embed_query(query: str, cfg: dict) -> list:
    """按 embedding_backend 分发到对应厂商的实现"""
    backend = cfg["embedding_backend"]
    if backend == "dashscope":
        return _embed_dashscope(query, cfg)
    if backend == "openai-multimodal":
        return _embed_openai_multimodal(query, cfg)
    # 默认 OpenAI 兼容
    return _embed_openai(query, cfg)


# ============================================================
# 向量库检索（各后端）
# ============================================================

def _http_get(url, headers=None, cfg=None):
    import ssl
    ctx = ssl.create_default_context()
    if cfg and not cfg["verify_tls"]:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers=headers or {})
    return json.loads(urllib.request.urlopen(req, context=ctx).read())


def _http_post(url, body, headers=None, cfg=None):
    import ssl
    ctx = ssl.create_default_context()
    if cfg and not cfg["verify_tls"]:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers={
        "Content-Type": "application/json",
        **(headers or {})
    })
    resp = urllib.request.urlopen(req, context=ctx)
    # 204 或空响应
    body = resp.read()
    return json.loads(body) if body else {}


def _chroma_get_space(info):
    """从 collection 详情中提取 hnsw:space（distance function）。
    ChromaDB 默认为 l2（平方欧氏距离）。不同版本/部署返回结构略有差异，
    依次尝试 metadata、configuration 字段，均缺失时回退到 'l2'。
    """
    # 常见结构 1：info.metadata["hnsw:space"]（创建时通过 metadata 指定）
    meta = info.get("metadata") or {}
    if isinstance(meta, dict) and meta.get("hnsw:space"):
        return meta["hnsw:space"]
    # 常见结构 2：info.configuration.fields["hnsw:space"]
    cfg = info.get("configuration") or {}
    fields = cfg.get("fields") if isinstance(cfg, dict) else None
    if isinstance(fields, dict) and fields.get("hnsw:space"):
        return fields["hnsw:space"]
    # 常见结构 3：info.configuration.hnsw.space（嵌套对象形式）
    hnsw = cfg.get("hnsw") if isinstance(cfg, dict) else None
    if isinstance(hnsw, dict) and hnsw.get("space"):
        return hnsw["space"]
    return "l2"  # ChromaDB 默认


def _chroma_distance_to_score(space, d):
    """按 distance function 将 ChromaDB distance 转成 score（越大越相似）。
    - l2（平方欧氏）：d ∈ [0, +∞)，score = 1/(1+d)，单调递减到 0
    - cosine：d ∈ [0, 2]，score = 1-d，还原成 cosine similarity ∈ [-1, 1]
    - ip（负内积）：d = -⟨a,b⟩，score = -d，还原成内积
    """
    if space == "cosine":
        return 1 - d
    if space == "ip":
        return -d
    # l2 或未知：用 1/(1+d) 归一化，避免高维 L2 距离 >1 时被线性压成 0
    return 1 / (1 + d) if d >= 0 else 1.0


def search_chroma(query_vec, top_k, cfg):
    """ChromaDB v2 检索：先按名字查 UUID 和 distance function，再用 UUID 查询。
    score 转换公式根据 collection 创建时指定的 hnsw:space 动态选择，
    避免对 L2 距离套用 cosine 公式导致区分度丢失。
    """
    base = f"{cfg['vstore_url']}/api/v2/tenants/default_tenant/databases/default_database/collections"

    # 1. 查 UUID 和 distance function（同一次 GET 拿到）
    info = _http_get(f"{base}/{cfg['vstore_collection']}", cfg=cfg)
    uuid = info["id"]
    space = _chroma_get_space(info)

    # 2. 查询（必须显式 include distances，否则默认不返回）
    result = _http_post(f"{base}/{uuid}/query", {
        "query_embeddings": [query_vec],
        "n_results": top_k,
        "include": ["metadatas", "distances"]
    }, cfg=cfg)

    # 3. 整理结果
    out = []
    ids = result.get("ids", [[]])
    metas = result.get("metadatas", [[]])
    dists = result.get("distances", [[]])
    for i in range(len(ids[0]) if ids and ids[0] else 0):
        m = metas[0][i] if metas and metas[0] else {}
        d = dists[0][i] if dists and dists[0] else 0
        score = round(_chroma_distance_to_score(space, d), 4)
        out.append({
            "id": ids[0][i],
            "convId": m.get("convId", ""),
            "title": m.get("title", ""),
            "platform": m.get("platform", ""),
            "role": m.get("role", ""),
            "content": m.get("content", ""),
            "score": score
        })
    return out


def search_qdrant(query_vec, top_k, cfg):
    """Qdrant 检索"""
    url = f"{cfg['vstore_url']}/collections/{cfg['vstore_collection']}/points/search"
    headers = {}
    if cfg["vstore_api_key"]:
        headers["api-key"] = cfg["vstore_api_key"]

    result = _http_post(url, {
        "vector": query_vec,
        "limit": top_k,
        "with_payload": True
    }, headers=headers, cfg=cfg)

    out = []
    for hit in result.get("result", []):
        p = hit.get("payload", {})
        out.append({
            "id": hit.get("id", ""),
            "convId": p.get("convId", ""),
            "title": p.get("title", ""),
            "platform": p.get("platform", ""),
            "role": p.get("role", ""),
            "content": p.get("content", ""),
            "score": round(hit.get("score", 0), 4)
        })
    return out


def search_pgvector(query_vec, top_k, cfg):
    """PostgreSQL + pgvector + PostgREST 检索
    match_<table> 函数返回字段：id, conv_id, metadata(JSONB), similarity
    其中 title/platform/role/content 等业务字段封装在 metadata JSONB 内，
    不是顶层字段，必须从 metadata 中解析。
    """
    url = f"{cfg['vstore_url']}/rpc/match_{cfg['vstore_collection']}"
    headers = {}
    if cfg["vstore_api_key"]:
        headers["apikey"] = cfg["vstore_api_key"]
        headers["Authorization"] = f"Bearer {cfg['vstore_api_key']}"

    result = _http_post(url, {
        "query_embedding": query_vec,
        "match_count": top_k
    }, headers=headers, cfg=cfg)

    out = []
    for row in result if isinstance(result, list) else []:
        meta = row.get("metadata") or {}
        out.append({
            "id": row.get("id", ""),
            "convId": row.get("conv_id", "") or meta.get("convId", ""),
            "title": meta.get("title", ""),
            "platform": meta.get("platform", ""),
            "role": meta.get("role", ""),
            "content": meta.get("content", ""),
            "score": round(row.get("similarity", 0), 4)
        })
    return out


def _normalize_supabase_url(url):
    """归一化 Supabase URL：剥掉末尾斜杠和 /rest/v1 后缀。
    用户可能按 Supabase 官方文档填入带 /rest/v1 的地址，
    统一剥掉后再由各方法重新拼接，避免 /rest/v1/rest/v1/ 双前缀 404。
    与插件 vector-store.js 的 _normalizeSupabaseUrl 行为保持一致。
    """
    return url.rstrip("/").replace("/rest/v1", "", 1) if url.rstrip("/").endswith("/rest/v1") else url.rstrip("/")


def search_supabase(query_vec, top_k, cfg):
    """Supabase（PostgREST + /rest/v1 前缀）检索
    match_<table> 函数返回字段：id, conv_id, metadata(JSONB), similarity
    与 pgvector 共用相同的 match 函数签名，字段解析逻辑一致。
    """
    base = _normalize_supabase_url(cfg["vstore_url"])
    url = f"{base}/rest/v1/rpc/match_{cfg['vstore_collection']}"
    headers = {}
    if cfg["vstore_api_key"]:
        headers["apikey"] = cfg["vstore_api_key"]
        headers["Authorization"] = f"Bearer {cfg['vstore_api_key']}"

    result = _http_post(url, {
        "query_embedding": query_vec,
        "match_count": top_k
    }, headers=headers, cfg=cfg)

    out = []
    for row in result if isinstance(result, list) else []:
        meta = row.get("metadata") or {}
        out.append({
            "id": row.get("id", ""),
            "convId": row.get("conv_id", "") or meta.get("convId", ""),
            "title": meta.get("title", ""),
            "platform": meta.get("platform", ""),
            "role": meta.get("role", ""),
            "content": meta.get("content", ""),
            "score": round(row.get("similarity", 0), 4)
        })
    return out


def search_milvus(query_vec, top_k, cfg):
    """Milvus v2 REST API 检索
    与 pgvector/supabase 不同，Milvus 的字段是平铺存储的（非 metadata JSONB），
    查询时需通过 outputFields 显式指定要返回的字段，否则只返回 id + distance。
    metricType=COSINE 时 score 越大越相似，无需像 ChromaDB 那样做 1-d 转换。
    """
    url = f"{cfg['vstore_url']}/v2/vectordb/entities/search"
    headers = {"Content-Type": "application/json"}
    if cfg["vstore_api_key"]:
        headers["Authorization"] = f"Bearer {cfg['vstore_api_key']}"

    result = _http_post(url, {
        "collectionName": cfg["vstore_collection"],
        "data": [query_vec],
        "limit": top_k,
        "outputFields": ["id", "convId", "title", "platform", "role", "content", "msgHash", "chunkIdx", "chunkTotal"]
    }, headers=headers, cfg=cfg)

    out = []
    for item in result.get("data", []):
        out.append({
            "id": str(item.get("id", "")),
            "convId": item.get("convId", ""),
            "title": item.get("title", ""),
            "platform": item.get("platform", ""),
            "role": item.get("role", ""),
            "content": item.get("content", ""),
            # Milvus COSINE metric: score 越大越相似；兼容 distance 字段
            "score": round(item.get("score", item.get("distance", 0)), 4)
        })
    return out


def search_vector_store(query_vec, top_k, cfg):
    """统一检索入口"""
    t = cfg["vstore_type"].lower()
    if t == "chroma":
        return search_chroma(query_vec, top_k, cfg)
    elif t == "qdrant":
        return search_qdrant(query_vec, top_k, cfg)
    elif t == "pgvector":
        return search_pgvector(query_vec, top_k, cfg)
    elif t == "supabase":
        return search_supabase(query_vec, top_k, cfg)
    elif t == "milvus":
        return search_milvus(query_vec, top_k, cfg)
    else:
        print(f"错误：暂不支持后端类型 {t}，支持 chroma/qdrant/pgvector/supabase/milvus", file=sys.stderr)
        sys.exit(1)


# ============================================================
# 统计信息
# ============================================================

def get_stats(cfg):
    """获取向量库统计信息"""
    t = cfg["vstore_type"].lower()
    count = 0

    if t == "chroma":
        base = f"{cfg['vstore_url']}/api/v2/tenants/default_tenant/databases/default_database/collections"
        info = _http_get(f"{base}/{cfg['vstore_collection']}", cfg=cfg)
        uuid = info["id"]
        count = _http_get(f"{base}/{uuid}/count", cfg=cfg)

    elif t == "qdrant":
        url = f"{cfg['vstore_url']}/collections/{cfg['vstore_collection']}"
        headers = {}
        if cfg["vstore_api_key"]:
            headers["api-key"] = cfg["vstore_api_key"]
        info = _http_get(url, headers=headers, cfg=cfg)
        count = info.get("result", {}).get("points_count", 0)

    elif t == "milvus":
        # Milvus 必须用 get_stats 接口取 rowCount，query 接口不支持 count
        url = f"{cfg['vstore_url']}/v2/vectordb/collections/get_stats"
        headers = {"Content-Type": "application/json"}
        if cfg["vstore_api_key"]:
            headers["Authorization"] = f"Bearer {cfg['vstore_api_key']}"
        info = _http_post(url, {"collectionName": cfg["vstore_collection"]}, headers=headers, cfg=cfg)
        count = info.get("data", {}).get("rowCount", 0)

    elif t in ("pgvector", "supabase"):
        # supabase 需归一化 URL（剥掉可能存在的 /rest/v1 后缀再重新拼接）
        base = _normalize_supabase_url(cfg["vstore_url"]) if t == "supabase" else cfg["vstore_url"].rstrip("/")
        prefix = "/rest/v1" if t == "supabase" else ""
        url = f"{base}{prefix}/{cfg['vstore_collection']}?select=id&limit=0"
        headers = {}
        if cfg["vstore_api_key"]:
            headers["apikey"] = cfg["vstore_api_key"]
            headers["Authorization"] = f"Bearer {cfg['vstore_api_key']}"
        headers["Prefer"] = "count=exact"
        headers["Range"] = "0-0"
        import ssl
        ctx = ssl.create_default_context()
        if not cfg["verify_tls"]:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        req = urllib.request.Request(url, headers=headers)
        resp = urllib.request.urlopen(req, context=ctx)
        range_header = resp.headers.get("Content-Range", "*/0")
        count = int(range_header.split("/")[-1]) if "/" in range_header else 0

    return {
        "backend": cfg["vstore_type"],
        "collection": cfg["vstore_collection"],
        "embedding_provider": cfg["embedding_provider"],
        "embedding_provider_name": cfg["embedding_provider_name"],
        "embedding_model": cfg["embedding_model"],
        "embedding_dim": cfg["embedding_dim"],
        "count": count
    }


# ============================================================
# 主入口
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="AI 对话知识库检索工具")
    sub = parser.add_subparsers(dest="command")

    search_p = sub.add_parser("search", help="语义检索对话历史")
    search_p.add_argument("query", help="查询内容")
    search_p.add_argument("--top-k", type=int, default=5, help="返回条数（默认 5）")

    sub.add_parser("stats", help="查看知识库统计信息")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    cfg = load_config()

    if args.command == "search":
        vec = embed_query(args.query, cfg)
        results = search_vector_store(vec, args.top_k, cfg)
        print(json.dumps(results, ensure_ascii=False, indent=2))

    elif args.command == "stats":
        info = get_stats(cfg)
        print(json.dumps(info, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
