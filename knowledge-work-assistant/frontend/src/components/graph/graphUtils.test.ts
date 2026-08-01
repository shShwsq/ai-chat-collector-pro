import { describe, expect, it } from 'vitest'
import { isSameGraphStructure } from './graphUtils'
import type { Edge, FullGraph, Node } from '../../lib/types'

function makeNode(id: string, title = ''): Node {
  return {
    id,
    graph_id: 'g1',
    type: 'concept',
    title,
    summary: '',
    detail_payload: {},
    is_gray: false,
    user_fill: {},
    source: 'agent',
    confidence: 1,
    created_at: '',
    updated_at: '',
  } as Node
}

function makeEdge(id: string, src: string, dst: string): Edge {
  return {
    id,
    graph_id: 'g1',
    src_id: src,
    dst_id: dst,
    relation: 'related',
    created_at: '',
  } as Edge
}

function makeGraph(nodes: Node[], edges: Edge[]): FullGraph {
  return {
    nodes,
    edges,
    graph: { id: 'g1', mode: 'study', title: '', created_at: '', updated_at: '' },
  } as unknown as FullGraph
}

describe('isSameGraphStructure', () => {
  it('returns true when only node fields change', () => {
    const a = makeGraph(
      [makeNode('n1', 'old title'), makeNode('n2')],
      [makeEdge('e1', 'n1', 'n2')],
    )
    const b = makeGraph(
      [makeNode('n1', 'new title'), makeNode('n2')],
      [makeEdge('e1', 'n1', 'n2')],
    )
    expect(isSameGraphStructure(a, b)).toBe(true)
  })

  it('returns false when a node is added', () => {
    const a = makeGraph([makeNode('n1')], [])
    const b = makeGraph([makeNode('n1'), makeNode('n2')], [])
    expect(isSameGraphStructure(a, b)).toBe(false)
  })

  it('returns false when a node is removed', () => {
    const a = makeGraph([makeNode('n1'), makeNode('n2')], [])
    const b = makeGraph([makeNode('n1')], [])
    expect(isSameGraphStructure(a, b)).toBe(false)
  })

  it('returns false when an edge endpoint changes', () => {
    const a = makeGraph(
      [makeNode('n1'), makeNode('n2')],
      [makeEdge('e1', 'n1', 'n2')],
    )
    const b = makeGraph(
      [makeNode('n1'), makeNode('n2')],
      [makeEdge('e1', 'n2', 'n1')],
    )
    expect(isSameGraphStructure(a, b)).toBe(false)
  })

  it('returns true when only edge relation field changes', () => {
    const a = makeGraph(
      [makeNode('n1'), makeNode('n2')],
      [makeEdge('e1', 'n1', 'n2')],
    )
    const b = {
      ...a,
      edges: [
        {
          ...a.edges[0],
          relation: 'prerequisite',
        },
      ],
    }
    expect(isSameGraphStructure(a, b)).toBe(true)
  })
})
