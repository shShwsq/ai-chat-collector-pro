export interface GraphHandoffTarget {
  left: number
  top: number
  width: number
  height: number
}

export interface GraphHandoffView {
  waitForNodeReady: (nodeId: string) => Promise<boolean>
  focusNodeAtCenter: (nodeId: string) => Promise<boolean>
  getNodeScreenRect: (nodeId: string) => DOMRect | null
}

/** 等待条件渲染的图谱视图提交 ref，避免切换导航后在同一轮 effect 中读取空引用。 */
export async function waitForGraphHandoffView(
  readView: () => GraphHandoffView | null | undefined,
  timeoutMs = 1500,
): Promise<GraphHandoffView | null> {
  const immediate = readView()
  if (immediate) return immediate

  const startedAt = Date.now()
  return new Promise((resolve) => {
    const check = () => {
      const view = readView()
      if (view) {
        resolve(view)
        return
      }
      if (Date.now() - startedAt >= timeoutMs) {
        resolve(null)
        return
      }
      setTimeout(check, 16)
    }
    setTimeout(check, 0)
  })
}

/** 严格串行完成图谱就绪、整图平移与落点测量。 */
export async function prepareGraphHandoffTarget(
  graphView: GraphHandoffView | null | undefined,
  nodeId: string,
): Promise<GraphHandoffTarget | null> {
  if (!graphView || !(await graphView.waitForNodeReady(nodeId))) return null
  if (!(await graphView.focusNodeAtCenter(nodeId))) return null

  const rect = graphView.getNodeScreenRect(nodeId)
  if (!rect) return null
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  }
}
