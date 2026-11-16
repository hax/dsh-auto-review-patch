/**
 * Regenerate the fork's own patches on top of the frozen Issue #3 (patch 0001)
 * and Issue #5 (patch 0002) patches:
 *
 * - `patches/0003-fix-approval-grant-unload-race.patch`, the delta committed as
 *   `a25f516` ("fix: cancel approval grants on unload"), rebuilt from that
 *   commit;
 * - `patches/0004-inline-fiber-state-active.patch`, the frozen load-time
 *   `FiberState` fix owned by a separate workstream. This script never rewrites
 *   it: it pins both the stored patch and the source it must produce, and only
 *   applies it to build the base for the next patch;
 * - `patches/0005-add-auto-deny-reviewer-rejections.patch`, the current delta
 *   that adds the `autoDenyReviewerRejections` Loader setting.
 *
 * Patches 0001 and 0002 are historical and frozen: they must keep reproducing
 * the committed `56a0252` / `5972f49` sources byte-for-byte. Rebuilding the
 * stored patches must always reconstruct the fork source in order:
 *
 *   pristine + 0001 + 0002 + 0003 + 0004 + 0005 == src/index.ts
 *
 * All patches are expressed against the upstream package layout
 * (`a/src/index.ts` -> `b/src/index.ts`), so they apply with `git apply -p1`
 * from a checkout of `packages/experimental/auto-review` at the recorded tag.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const snapshot = join(root, 'upstream/dsh-v0.2.2-rc.3')
const issue3Patch = join(root, 'patches/0001-return-concise-reviewer-denial-reasons.patch')
const issue5Patch = join(root, 'patches/0002-add-human-approval-timeout.patch')
const frozenPatches = [issue3Patch, issue5Patch]
const current = join(root, 'src/index.ts')
const racePatchFile = join(root, 'patches/0003-fix-approval-grant-unload-race.patch')
const fiberPatchFile = join(root, 'patches/0004-inline-fiber-state-active.patch')
const autoDenyPatchFile = join(root, 'patches/0005-add-auto-deny-reviewer-rejections.patch')
/** Commit whose `src/index.ts` is the post-0003 fork source. */
const RACE_COMMIT = 'a25f516'
/**
 * Frozen patch 0004 and the exact `src/index.ts` it must produce. Owned by a
 * separate workstream; this script may apply the stored patch but never
 * rewrite it.
 */
const FROZEN_FIBER_PATCH_SHA256 = '5ff7b1b6d9701709e4fb002ed81024e6189577df5df7dc09f874420c19d66691'
const FROZEN_FIBER_SOURCE_SHA256 = '762d8e415fe37a5f04f38014cf7ea41b0699220bf6cafc04afc89fdfc53202f5'

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

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

/** Read one committed source file; a missing commit is a hard failure. */
function committedSource(commit, destination) {
  try {
    const content = execFileSync('git', ['show', `${commit}:src/index.ts`], { cwd: root })
    writeFileSync(destination, content)
  } catch (error) {
    throw new Error(
      `cannot read ${commit}:src/index.ts from git; the recorded commit must stay reachable `
      + `(${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

/** Apply one stored patch to a temporary tree whose `src/index.ts` is `source`. */
function applyPatchToSource(source, patch, directory) {
  mkdirSync(join(directory, 'src'), { recursive: true })
  copyFileSync(source, join(directory, 'src/index.ts'))
  execFileSync('git', ['apply', '-p1', '--whitespace=error-all', patch], { cwd: directory })
  return join(directory, 'src/index.ts')
}

const RACE_HEADER = `# Fork patch 0003 for @deepseek-ai/dsh-experimental-auto-review 0.2.2-rc.3
# Fixes the approval grant versus unload / caller-cancellation race.
# Applies AFTER patches/0001-return-concise-reviewer-denial-reasons.patch and
# patches/0002-add-human-approval-timeout.patch.
# Upstream: deepseek-ai/deepseek-harness tag dsh-v0.2.2-rc.3
#           commit 38a6a5c965aa99ab525161efb7cc5cf1fe62fced
# Path:     packages/experimental/auto-review/src/index.ts
# Apply:    git apply -p1 patches/0001-return-concise-reviewer-denial-reasons.patch
#           git apply -p1 patches/0002-add-human-approval-timeout.patch
#           git apply -p1 patches/0003-fix-approval-grant-unload-race.patch
#           (or: npm run verify:upstream checks all five patches reproduce this fork's src/index.ts)
`

const AUTO_DENY_HEADER = `# Fork patch 0005 for @deepseek-ai/dsh-experimental-auto-review 0.2.2-rc.3
# Adds the \`autoDenyReviewerRejections\` Loader setting: when enabled, a
# reviewer denial becomes the final automatic denial without asking a human.
# The Auto permission preset pins the official approval mode to \`ask\` and the
# GUI exposes no approval knob, so this integration owns the full-auto switch.
# Applies AFTER patches/0003-fix-approval-grant-unload-race.patch and the
# frozen patches/0004-inline-fiber-state-active.patch; together the five
# patches reproduce this fork's src/index.ts byte-for-byte.
# Upstream: deepseek-ai/deepseek-harness tag dsh-v0.2.2-rc.3
#           commit 38a6a5c965aa99ab525161efb7cc5cf1fe62fced
# Path:     packages/experimental/auto-review/src/index.ts
# Apply:    git apply -p1 patches/0001-return-concise-reviewer-denial-reasons.patch
#           git apply -p1 patches/0002-add-human-approval-timeout.patch
#           git apply -p1 patches/0003-fix-approval-grant-unload-race.patch
#           git apply -p1 patches/0004-inline-fiber-state-active.patch
#           git apply -p1 patches/0005-add-auto-deny-reviewer-rejections.patch
#           (or: npm run verify:upstream checks all five reproduce this fork's src/index.ts)
`

const temporary = mkdtempSync(join(tmpdir(), 'auto-review-patch-'))
try {
  const pristine = join(temporary, 'pristine')
  cpSync(snapshot, pristine, { recursive: true })
  for (const patch of frozenPatches) {
    execFileSync('git', ['apply', '-p1', '--whitespace=error-all', patch], { cwd: pristine })
  }
  const issue5Source = join(pristine, 'src/index.ts')
  const raceSource = join(temporary, 'race-index.ts')
  committedSource(RACE_COMMIT, raceSource)

  const raceDiff = unifiedDiff(issue5Source, raceSource)
  if (raceDiff.trim() === '') {
    throw new Error(`src/index.ts at ${RACE_COMMIT} is identical to the Issue #3 + #5 source; nothing to patch`)
  }
  writeFileSync(racePatchFile, RACE_HEADER + raceDiff)
  console.log(`wrote ${racePatchFile.slice(root.length)} (${readFileSync(racePatchFile, 'utf8').split('\n').length} lines)`)

  // Patch 0004 is frozen: verify the stored bytes, then apply it to build the
  // base for patch 0005. Never write it here.
  const fiberPatch = readFileSync(fiberPatchFile)
  const fiberPatchHash = sha256(fiberPatch)
  if (fiberPatchHash !== FROZEN_FIBER_PATCH_SHA256) {
    throw new Error(
      `patches/0004-inline-fiber-state-active.patch is frozen (sha256 ${FROZEN_FIBER_PATCH_SHA256}), `
      + `got ${fiberPatchHash}; do not rewrite it`,
    )
  }
  const fiberSource = applyPatchToSource(raceSource, fiberPatchFile, join(temporary, 'fiber-work'))
  const fiberSourceHash = sha256(readFileSync(fiberSource))
  if (fiberSourceHash !== FROZEN_FIBER_SOURCE_SHA256) {
    throw new Error(
      `patch 0004 must produce the frozen source (sha256 ${FROZEN_FIBER_SOURCE_SHA256}), got ${fiberSourceHash}`,
    )
  }

  const autoDenyDiff = unifiedDiff(fiberSource, current)
  if (autoDenyDiff.trim() === '') {
    throw new Error('src/index.ts is identical to the frozen 0004 source; patch 0005 would be empty')
  }
  writeFileSync(autoDenyPatchFile, AUTO_DENY_HEADER + autoDenyDiff)
  console.log(`wrote ${autoDenyPatchFile.slice(root.length)} (${readFileSync(autoDenyPatchFile, 'utf8').split('\n').length} lines)`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
