/**
 * Test double for `@deepseek-ai/dsh-util-values` 0.2.2-rc.3, limited to the
 * recursive `deepFreeze` the production source applies to review options and
 * snapshots.
 *
 * Trimmed from upstream (packages/util/values/src/index.ts): every reachable
 * object is frozen in place and `AbortSignal` instances are deliberately
 * skipped — `AbortController.abort()` writes the signal's internal reason, so
 * freezing a signal would break cancellation.
 */
export function deepFreeze(value) {
  const seen = new WeakSet()
  const pending = [{ kind: 'visit', node: value }]
  while (pending.length > 0) {
    const task = pending.pop()
    if (task.kind === 'property') {
      pending.push({ kind: 'visit', node: task.source[task.key] })
      continue
    }
    const node = task.node
    if (node === null || typeof node !== 'object') continue
    if (node instanceof AbortSignal) continue
    if (seen.has(node)) continue
    seen.add(node)
    Object.freeze(node)
    const keys = Object.keys(node)
    for (let index = keys.length - 1; index >= 0; index--) {
      pending.push({ kind: 'property', source: node, key: keys[index] })
    }
  }
  return value
}
