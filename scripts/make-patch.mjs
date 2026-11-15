/**
 * Regenerate `patches/0001-*.patch`, the production-source delta between the
 * pristine upstream snapshot and this fork's `src/index.ts`.
 *
 * The patch is expressed against the upstream package layout
 * (`a/src/index.ts` -> `b/src/index.ts`), so it applies with `git apply -p1`
 * from a checkout of `packages/experimental/auto-review` at the recorded tag.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const upstream = join(root, 'upstream/dsh-v0.2.2-rc.3/src/index.ts')
const current = join(root, 'src/index.ts')
const patchFile = join(root, 'patches/0001-return-concise-reviewer-denial-reasons.patch')

function unifiedDiff() {
  try {
    return execFileSync('diff', [
      '-u',
      '--label', 'a/src/index.ts',
      '--label', 'b/src/index.ts',
      upstream,
      current,
    ], { encoding: 'utf8' })
  } catch (error) {
    // `diff` exits 1 for differences; that is the expected success path.
    if (typeof error.stdout === 'string') return error.stdout
    throw error
  }
}

const diff = unifiedDiff()
if (diff.trim() === '') throw new Error('src/index.ts is identical to the upstream snapshot; nothing to patch')

const header = `# Fork patch for @deepseek-ai/dsh-experimental-auto-review 0.2.2-rc.3
# Upstream: deepseek-ai/deepseek-harness tag dsh-v0.2.2-rc.3
#           commit 38a6a5c965aa99ab525161efb7cc5cf1fe62fced
# Path:     packages/experimental/auto-review/src/index.ts
# Apply:    git apply -p1 patches/0001-return-concise-reviewer-denial-reasons.patch
#           (or: npm run verify:upstream checks it reproduces this fork's src/index.ts)
`

writeFileSync(patchFile, header + diff)
console.log(`wrote ${patchFile.slice(root.length)} (${readFileSync(patchFile, 'utf8').split('\n').length} lines)`)
