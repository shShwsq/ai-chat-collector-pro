// 幂等批量创建测试节点与边，验证图谱可视化（Task 5/6）
// 按标题去重：已存在的节点跳过，避免重复创建
// 用法：node seed-graph.js
const BASE = 'http://127.0.0.1:8788/api'
const GRAPH_ID = '54053104631a497cb450cd6a4e44fe89'

async function getFull() {
  const r = await fetch(`${BASE}/graphs/${GRAPH_ID}/full`)
  if (!r.ok) throw new Error(`getFull failed: ${r.status}`)
  return r.json()
}

async function createNode(body) {
  const r = await fetch(`${BASE}/graphs/${GRAPH_ID}/nodes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`createNode failed: ${r.status} ${await r.text()}`)
  return r.json()
}

async function createEdge(src, dst, relation) {
  const r = await fetch(`${BASE}/graphs/${GRAPH_ID}/edges`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ src_id: src, dst_id: dst, relation }),
  })
  if (!r.ok) throw new Error(`createEdge failed: ${r.status} ${await r.text()}`)
  return r.json()
}

async function main() {
  const full = await getFull()
  const byTitle = new Map(full.nodes.map((n) => [n.title, n]))
  console.log(`Existing nodes: ${full.nodes.length}, edges: ${full.edges.length}`)

  const nodeDefs = [
    { type: 'math', title: '乘法', summary: '表示相同加数重复相加的运算，是算术与代数的基础', is_gray: false },
    { type: 'math', title: '除法', summary: '乘法的逆运算，求一个数被另一个数等分的结果', is_gray: false },
    { type: 'math', title: '分数', summary: '表示部分与整体关系的数，由分子和分母组成', is_gray: false },
    { type: 'math', title: '负权边问题', summary: '理解 Dijkstra 算法限制的关键，涉及带负权重边的最短路径', is_gray: true },
    { type: 'general', title: '孤立的知识点', summary: '这是一个没有连接边的孤立节点，用于验证画布独立显示', is_gray: false },
  ]

  for (const n of nodeDefs) {
    if (byTitle.has(n.title)) {
      console.log(`Skip existing: ${n.title} -> ${byTitle.get(n.title).id.slice(0, 8)}`)
      continue
    }
    const r = await createNode(n)
    byTitle.set(n.title, r)
    console.log(`Created node: ${n.title} -> ${r.id.slice(0, 8)} gray=${n.is_gray}`)
  }

  // 边去重（无向，两端同关系幂等；这里按已存在边集合跳过）
  const existingEdges = new Set(full.edges.map((e) => [e.src_id, e.dst_id, e.relation].join('|')))
  const edgeDefs = [
    ['乘法', '除法', 'related'],
    ['乘法', '分数', 'prerequisite'],
    ['分数', '除法', 'related'],
    ['乘法', '负权边问题', 'extends'],
  ]
  for (const [a, b, rel] of edgeDefs) {
    const na = byTitle.get(a)
    const nb = byTitle.get(b)
    if (!na || !nb) {
      console.log(`Missing node for edge: ${a} - ${b}`)
      continue
    }
    const key1 = [na.id, nb.id, rel].join('|')
    const key2 = [nb.id, na.id, rel].join('|')
    if (existingEdges.has(key1) || existingEdges.has(key2)) {
      console.log(`Skip existing edge: ${rel} ${a} -- ${b}`)
      continue
    }
    await createEdge(na.id, nb.id, rel)
    console.log(`Created edge: ${rel}  ${a} -- ${b}`)
  }

  const final = await getFull()
  console.log(`\n=== Final stats ===`)
  console.log(`nodes=${final.stats.node_count} edges=${final.stats.edge_count}`)
  final.nodes.forEach((n) => {
    console.log(`  [${n.type}] gray=${n.is_gray} ${n.title}`)
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
