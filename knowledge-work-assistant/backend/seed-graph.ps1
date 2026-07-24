# 批量创建测试节点与边，验证图谱可视化（Task 5/6）
$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:8788/api'
$graphId = '54053104631a497cb450cd6a4e44fe89'

function New-Node {
    param($body)
    $json = $body | ConvertTo-Json -Compress
    $resp = Invoke-RestMethod -Uri "$base/graphs/$graphId/nodes" -Method Post -Body $json -ContentType 'application/json' -TimeoutSec 10
    return $resp
}

function New-Edge {
    param($src, $dst, $relation)
    $json = @{ src_id = $src; dst_id = $dst; relation = $relation } | ConvertTo-Json -Compress
    $resp = Invoke-RestMethod -Uri "$base/graphs/$graphId/edges" -Method Post -Body $json -ContentType 'application/json' -TimeoutSec 10
    return $resp
}

$created = @{}

$nodes = @(
    @{ type='math'; title='乘法'; summary='表示相同加数重复相加的运算，是算术与代数的基础'; is_gray=$false },
    @{ type='math'; title='除法'; summary='乘法的逆运算，求一个数被另一个数等分的结果'; is_gray=$false },
    @{ type='math'; title='分数'; summary='表示部分与整体关系的数，由分子和分母组成'; is_gray=$false },
    @{ type='math'; title='负权边问题'; summary='理解 Dijkstra 算法限制的关键，涉及带负权重边的最短路径'; is_gray=$true },
    @{ type='concept'; title='孤立的知识点'; summary='这是一个没有连接边的孤立节点，用于验证画布独立显示'; is_gray=$false }
)

foreach ($n in $nodes) {
    $resp = New-Node -body $n
    $created[$n.title] = $resp.id
    Write-Host "Created node: $($n.title) -> $($resp.id.Substring(0,8))"
}

$edges = @(
    @($created['乘法'], $created['除法'], 'related'),
    @($created['乘法'], $created['分数'], 'prerequisite'),
    @($created['分数'], $created['除法'], 'related'),
    @($created['乘法'], $created['负权边问题'], 'extends')
)

foreach ($e in $edges) {
    $resp = New-Edge -src $e[0] -dst $e[1] -relation $e[2]
    Write-Host "Created edge: $($e[2]) $($e[0].Substring(0,8)) -- $($e[1].Substring(0,8))"
}

$full = Invoke-RestMethod -Uri "$base/graphs/$graphId/full" -TimeoutSec 10
Write-Host "`n=== Final stats ==="
Write-Host "nodes=$($full.stats.node_count) edges=$($full.stats.edge_count)"
