/**
 * Regenerate `patches/0003-fix-approval-grant-unload-race.patch`, the delta this
 * fork adds on top of the committed Issue #3 (patch 0001) and Issue #5
 * (patch 0002) patches.
 *
 * Patches 0001 and 0002 are historical and frozen: they must keep reproducing
 * the committed `56a0252` / `5972f49` sources byte-for-byte. This script
 * rebuilds the equivalent of those commits from the pristine upstream snapshot
 * (patches 0001+0002 applied) and diffs it against the current `src/index.ts`,
 * so the stored patches always reconstruct the fork source in order:
 *
 *   pristine + 0001 + 0002 + 0003 == src/index.ts
 *
 * All patches are expressed against the upstream package layout
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
const issue5Patch = join(root, 'patches/0002-add-human-approval-timeout.patch')
const frozenPatches = [issue3Patch, issue5Patch]
const current = join(root, 'src/index.ts')
const patchFile = join(root, 'patches/0003-fix-approval-grant-unload-race.patch')

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
  for (const patch of frozenPatches) {
    execFileSync('git', ['apply', '-p1', '--whitespace=error-all', patch], { cwd: pristine })
  }

  const committedSource = join(pristine, 'src/index.ts')
  const diff = unifiedDiff(committedSource, current)
  if (diff.trim() === '') {
    throw new Error('src/index.ts is identical to the committed Issue #3 + #5 source; nothing to patch')
  }

  const header = `# Fork patch 0003 for @deepseek-ai/dsh-experimental-auto-review 0.2.2-rc.3
# Fixes the approval grant versus unload / caller-cancellation race.
# Applies AFTER patches/0001-return-concise-reviewer-denial-reasons.patch and
# patches/0002-add-human-approval-timeout.patch; together the three patches
# reproduce this fork's src/index.ts byte-for-byte.
# Upstream: deepseek-ai/deepseek-harness tag dsh-v0.2.2-rc.3
#           commit 38a6a5c965aa99ab525161efb7cc5cf1fe62fced
# Path:     packages/experimental/auto-review/src/index.ts
# Apply:    git apply -p1 patches/0001-return-concise-reviewer-denial-reasons.patch
#           git apply -p1 patches/0002-add-human-approval-timeout.patch
#           git apply -p1 patches/0003-fix-approval-grant-unload-race.patch
#           (or: npm run verify:upstream checks all three reproduce this fork's src/index.ts)
`
  writeFileSync(patchFile, header + diff)
  console.log(`wrote ${patchFile.slice(root.length)} (${readFileSync(patchFile, 'utf8').split('\n').length} lines)`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
