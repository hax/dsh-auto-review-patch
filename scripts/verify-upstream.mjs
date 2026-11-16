/**
 * Offline reproducibility checks for the standalone fork:
 *
 * 1. every file in `upstream/dsh-v0.2.2-rc.3` matches its recorded SHA-256;
 * 2. the pristine snapshot still describes the same production source the fork
 *    started from (its own hashes are part of SHA256SUMS and are checked
 *    against the published DSH 0.2.2-rc.3 package by the recorded procedure in
 *    UPSTREAM.md);
 * 3. the stored patches apply in order to the pristine snapshot and reproduce
 *    `src/index.ts` byte-for-byte (pristine + 0001 + 0002 + 0003);
 * 4. patch 0001 still reproduces the committed Issue #3 source (`56a0252`) and
 *    patch 0002 the committed Issue #5 source (`5972f49`), so earlier behavior
 *    cannot drift;
 * 5. the patches only apply in their committed order and touch only the
 *    production source, while packaging files intended to mirror upstream stay
 *    byte-identical (`cordis.patch.yml`, locale JSON, icon, LICENSE).
 *
 * No network access or package installation is required.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const snapshot = join(root, 'upstream/dsh-v0.2.2-rc.3')
/** Frozen Issue #3 patch, committed as `56a0252` before the timeout patch. */
const issue3Patch = join(root, 'patches/0001-return-concise-reviewer-denial-reasons.patch')
/** Frozen Issue #5 patch, committed as `5972f49` before the grant/unload fix. */
const issue5Patch = join(root, 'patches/0002-add-human-approval-timeout.patch')
/** Current fix patch, applied after the two frozen patches. */
const racePatch = join(root, 'patches/0003-fix-approval-grant-unload-race.patch')
const patches = [issue3Patch, issue5Patch, racePatch]
/** Commits the frozen patches must keep reproducing. */
const ISSUE3_COMMIT = '56a0252'
const ISSUE5_COMMIT = '5972f49'

const failures = []
let checks = 0

function check(name, fn) {
  checks += 1
  try {
    fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function walk(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else files.push(full)
  }
  return files
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** Assert that one callback throws, for order-dependency checks. */
function assertThrows(fn, message) {
  try {
    fn()
  } catch {
    return
  }
  throw new Error(message)
}

/** Read one committed source file; a missing commit is a hard failure. */
function committedSource(commit) {
  try {
    return execFileSync('git', ['show', `${commit}:src/index.ts`], { cwd: root })
  } catch (error) {
    throw new Error(
      `cannot read ${commit}:src/index.ts from git; the preserved commit must stay reachable `
      + `(${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

/** Run one callback against a throwaway pristine copy of the snapshot. */
function withPristine(fn) {
  const temporary = mkdtempSync(join(tmpdir(), 'auto-review-verify-'))
  try {
    const pristine = join(temporary, 'pristine')
    cpSync(snapshot, pristine, { recursive: true })
    return fn(pristine)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

/** Apply each patch in order to the pristine copy. */
function applyPatches(pristine) {
  for (const patch of patches) {
    execFileSync('git', ['apply', '-p1', '--whitespace=error-all', patch], { cwd: pristine })
  }
}

// 1. Snapshot hashes.
const sumsFile = join(snapshot, 'SHA256SUMS')
const sums = new Map(
  readFileSync(sumsFile, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .map(line => {
      const [hash, ...rest] = line.split(/\s+/)
      return [rest.join(' '), hash]
    }),
)
check('upstream snapshot files match SHA256SUMS', () => {
  for (const [file, expected] of sums) {
    assert(sha256(join(snapshot, file)) === expected, `${file} sha256 mismatch`)
  }
})

check('upstream snapshot is complete', () => {
  const files = walk(snapshot).map(file => relative(snapshot, file)).sort()
  const expected = [...sums.keys()].sort()
  assert(
    JSON.stringify(files.filter(file => file !== 'SHA256SUMS')) === JSON.stringify(expected),
    `snapshot file set differs from SHA256SUMS: ${files.join(', ')}`,
  )
})

// 2. Patches apply in order to a pristine copy and reproduce src/index.ts.
check('pristine + 0001 + 0002 + 0003 reproduce src/index.ts byte-for-byte', () => {
  withPristine((pristine) => {
    applyPatches(pristine)
    const applied = readFileSync(join(pristine, 'src/index.ts'))
    const current = readFileSync(join(root, 'src/index.ts'))
    assert(applied.equals(current), 'patched upstream source differs from src/index.ts')
  })
})

check('stored patches have no whitespace errors and apply in sequence', () => {
  withPristine((pristine) => {
    for (const patch of patches) {
      execFileSync('git', ['apply', '--check', '-p1', '--whitespace=error-all', patch], { cwd: pristine })
      // Apply so the next patch is checked against the source it expects.
      execFileSync('git', ['apply', '-p1', patch], { cwd: pristine })
    }
  })
})

check('patches apply only in their committed order', () => {
  withPristine((pristine) => {
    assertThrows(
      () => execFileSync('git', ['apply', '--check', '-p1', issue5Patch], { cwd: pristine, stdio: 'pipe' }),
      'patch 0002 must not apply to the pristine snapshot',
    )
    assertThrows(
      () => execFileSync('git', ['apply', '--check', '-p1', racePatch], { cwd: pristine, stdio: 'pipe' }),
      'patch 0003 must not apply to the pristine snapshot',
    )
  })
})

check('patch 0001 reproduces the committed Issue #3 source', () => {
  const committed = committedSource(ISSUE3_COMMIT)
  withPristine((pristine) => {
    execFileSync('git', ['apply', '-p1', '--whitespace=error-all', issue3Patch], { cwd: pristine })
    assert(
      readFileSync(join(pristine, 'src/index.ts')).equals(committed),
      `pristine + 0001 differs from the committed ${ISSUE3_COMMIT} src/index.ts`,
    )
  })
})

check('patch 0002 reproduces the committed Issue #5 source', () => {
  const committed = committedSource(ISSUE5_COMMIT)
  withPristine((pristine) => {
    for (const patch of [issue3Patch, issue5Patch]) {
      execFileSync('git', ['apply', '-p1', '--whitespace=error-all', patch], { cwd: pristine })
    }
    assert(
      readFileSync(join(pristine, 'src/index.ts')).equals(committed),
      `pristine + 0001 + 0002 differs from the committed ${ISSUE5_COMMIT} src/index.ts`,
    )
  })
})

check('patches modify only src/index.ts', () => {
  withPristine((pristine) => {
    for (const patch of patches) {
      const reported = execFileSync('git', ['apply', '--numstat', patch], { cwd: pristine, encoding: 'utf8' })
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '')
        .map(line => line.split('\t').at(-1))
      assert(
        JSON.stringify(reported) === JSON.stringify(['src/index.ts']),
        `patch must touch only src/index.ts, got ${JSON.stringify(reported)}`,
      )
    }
  })
})

// 3. Unmodified packaging/source files stay byte-identical to upstream.
check('src/locales.ts is byte-identical to upstream', () => {
  assert(
    readFileSync(join(root, 'src/locales.ts')).equals(readFileSync(join(snapshot, 'src/locales.ts'))),
    'src/locales.ts differs from upstream',
  )
})

check('cordis.patch.yml is byte-identical to upstream', () => {
  assert(
    readFileSync(join(root, 'cordis.patch.yml')).equals(readFileSync(join(snapshot, 'cordis.patch.yml'))),
    'cordis.patch.yml differs from upstream',
  )
})

check('locale resources are byte-identical to upstream', () => {
  for (const locale of readdirSync(join(snapshot, 'locale'))) {
    assert(
      readFileSync(join(root, 'locale', locale)).equals(readFileSync(join(snapshot, 'locale', locale))),
      `locale/${locale} differs from upstream`,
    )
  }
})

check('icon and license are byte-identical to upstream', () => {
  assert(
    readFileSync(join(root, 'icon.svg')).equals(readFileSync(join(snapshot, 'icon.svg'))),
    'icon.svg differs from upstream',
  )
  assert(
    readFileSync(join(root, 'LICENSE')).equals(readFileSync(join(snapshot, 'LICENSE'))),
    'LICENSE differs from upstream',
  )
})

console.log(`\n${checks - failures.length}/${checks} reproducibility checks passed`)
if (failures.length > 0) {
  console.error('failed checks:')
  for (const failure of failures) console.error(`- ${failure.name}: ${failure.error instanceof Error ? failure.error.stack : String(failure.error)}`)
  process.exitCode = 1
}
