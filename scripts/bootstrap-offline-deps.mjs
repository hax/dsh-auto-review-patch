/**
 * Reproduce the repository's only devDependency (TypeScript 5.7.3) offline.
 *
 * The package tarball is vendored in `vendor/` together with its SHA-256, so a
 * fresh checkout can build and typecheck with no network access and no global
 * installation:
 *
 *   npm run bootstrap:offline
 *
 * The install is repository-local only: `npm install --offline --no-save
 * --no-package-lock --ignore-scripts --legacy-peer-deps <tarball>` creates
 * `node_modules/typescript` and `node_modules/.bin/tsc`, which npm exposes to
 * `npm run` scripts automatically. Nothing is written to a global prefix and
 * no registry is contacted. `pretypecheck` / `prebuild` / `preverify` call this
 * script, so `npm run typecheck`, `npm run build` and `npm run verify` also
 * work from an empty `node_modules`.
 *
 * On a networked machine the standard `npm install` remains available; this
 * script is only the deterministic offline path required by the current
 * no-install verification environment.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

function fail(message) {
  console.error(`bootstrap-offline-deps: ${message}`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const expectedVersion = manifest.devDependencies?.typescript
if (typeof expectedVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(expectedVersion)) {
  fail(`package.json devDependencies.typescript must be an exact version, got ${String(expectedVersion)}`)
}

const tarball = join(root, 'vendor', `typescript-${expectedVersion}.tgz`)
const sumsFile = join(root, 'vendor', 'SHA256SUMS')
const tscBin = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

function installedVersion() {
  if (!existsSync(tscBin)) return undefined
  try {
    const output = execFileSync(process.execPath, [tscBin, '--version'], { encoding: 'utf8' }).trim()
    return output
  } catch (error) {
    fail(`existing node_modules/typescript is unusable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const installed = installedVersion()
if (installed !== undefined) {
  if (installed !== `Version ${expectedVersion}`) fail(`expected TypeScript ${expectedVersion}, found ${installed}`)
  console.log(`bootstrap-offline-deps: TypeScript ${expectedVersion} already installed at node_modules/typescript (tsc resolves via npm script PATH)`)
  process.exit(0)
}

if (!existsSync(tarball)) fail(`missing vendored tarball ${tarball}`)
if (!existsSync(sumsFile)) fail(`missing checksum file ${sumsFile}`)

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
const expectedHash = sums.get(`typescript-${expectedVersion}.tgz`)
if (expectedHash === undefined) fail(`vendor/SHA256SUMS has no entry for typescript-${expectedVersion}.tgz`)

const actualHash = createHash('sha256').update(readFileSync(tarball)).digest('hex')
if (actualHash !== expectedHash) fail(`vendored tarball sha256 mismatch: ${actualHash} != ${expectedHash}`)

const installArguments = [
  'install',
  '--offline',
  '--no-save',
  '--no-package-lock',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--legacy-peer-deps',
  tarball,
]
const npmCli = process.env.npm_execpath
const [command, ...prefixArguments] = npmCli === undefined
  ? ['npm', ...installArguments]
  : [process.execPath, npmCli, ...installArguments]

console.log(`bootstrap-offline-deps: installing vendored TypeScript ${expectedVersion} offline into node_modules`)
try {
  execFileSync(command, prefixArguments, { cwd: root, stdio: 'inherit' })
} catch (error) {
  fail(`offline install failed: ${error instanceof Error ? error.message : String(error)}`)
}
if (installedVersion() !== `Version ${expectedVersion}`) fail('installed TypeScript does not report the expected version')
console.log(`bootstrap-offline-deps: ready; node_modules/.bin/tsc resolves TypeScript ${expectedVersion}`)
