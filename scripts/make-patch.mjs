/**
 * Regenerate `patches/0002-add-human-approval-timeout.patch`, the delta this
 * fork adds on top of the committed Issue #3 patch (patch 0001).
 *
 * Patch 0001 is historical and frozen: it must keep reproducing the Issue #3
 * commit byte-for-byte. This script rebuilds the equivalent of that commit from
 * the pristine upstream snapshot (`upstream/dsh-v0.2.2-rc.3`, patch 0001
 * applied) and diffs it against the current `src/index.ts`, so the two stored
 * patches always reconstruct the fork source in order:
 *
 *   pristine + 0001 + 0002 == src/index.ts
 *
 * Both patches are expressed against the upstream package layout
 * (`a/src/index.ts` -> `b/src/index.ts`), so they apply with `git apply -p1`
 * from a checkout of `packages/experimental/auto-review` at the recorded tag.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const snapshot = join(root, 'upstream/dsh-v0.2.2-rc.3')
const issue3Patch = join(root, 'patches/0001-return-concise-reviewer-denial-reasons.patch')
const current = join(root, 'src/index.ts')
const patchFile = join(root, 'patches/0002-add-human-approval-timeout.patch')

function unifiedDiff(from, to) {
  try {
    return execFileSync('diff', [
      '-u',
      '--label', 'a/src/index.ts',
      '--label', 'b/src/index.ts',
      from,
      to,
    ], { encoding: 'utf8' })
  } catch (error) {
    // `diff` exits 1 for differences; that is the expected success path.
    if (typeof error.stdout === 'string') return error.stdout
    throw error
  }
}

const temporary = mkdtempSync(join(tmpdir(), 'auto-review-patch-'))
try {
  const pristine = join(temporary, 'pristine')
  cpSync(snapshot, pristine, { recursive: true })
  execFileSync('git', ['apply', '-p1', '--whitespace=error-all', issue3Patch], { cwd: pristine })

  const issue3Source = join(pristine, 'src/index.ts')
  const diff = unifiedDiff(issue3Source, current)
  if (diff.trim() === '') {
    throw new Error('src/index.ts is identical to the Issue #3 source; nothing to patch')
  }

  const header = `# Fork patch 0002 for @deepseek-ai/dsh-experimental-auto-review 0.2.2-rc.3
# Adds the configurable minute-level human-response timeout (Issue #5).
# Applies AFTER patches/0001-return-concise-reviewer-denial-reasons.patch;
# together they reproduce this fork's src/index.ts byte-for-byte.
# Upstream: deepseek-ai/deepseek-harness tag dsh-v0.2.2-rc.3
#           commit 38a6a5c965aa99ab525161efb7cc5cf1fe62fced
# Path:     packages/experimental/auto-review/src/index.ts
# Apply:    git apply -p1 patches/0001-return-concise-reviewer-denial-reasons.patch
#           git apply -p1 patches/0002-add-human-approval-timeout.patch
#           (or: npm run verify:upstream checks both reproduce this fork's src/index.ts)
`
  writeFileSync(patchFile, header + diff)
  console.log(`wrote ${patchFile.slice(root.length)} (${readFileSync(patchFile, 'utf8').split('\n').length} lines)`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
