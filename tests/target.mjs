/**
 * Test target selector: exercise the production source directly (Node's native
 * TypeScript stripping) or the emitted `lib/` artifact built by `tsc`.
 */
const target = process.env.AUTO_REVIEW_TEST_TARGET ?? 'src'

export const targetName = target

/** Load the plugin module under test. */
export async function loadPlugin() {
  return target === 'lib'
    ? import('../lib/index.js')
    : import('../src/index.ts')
}
