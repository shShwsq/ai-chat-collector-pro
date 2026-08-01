export type PostHandoffExtensionResult = unknown | null
export type ExtendAllNodes = (
  nodeId: string,
  mode: 'all',
) => Promise<PostHandoffExtensionResult>

/**
 * 每次接力先 reset，落地时可从动画完成与超时兜底两个入口安全触发。
 * trigger 会同步抢占本轮执行权，确保 extendNode(nodeId, 'all') 最多调用一次。
 */
export function createPostHandoffExtensionRunner(extendNode: ExtendAllNodes) {
  let triggered = false

  return {
    reset() {
      triggered = false
    },

    trigger(nodeId: string): boolean {
      if (triggered) return false
      triggered = true
      void extendNode(nodeId, 'all').catch(() => {})
      return true
    },
  }
}
