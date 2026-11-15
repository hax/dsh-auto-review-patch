/**
 * ESM resolve hooks that replace the five runtime `@deepseek-ai/*` imports of
 * the patched plugin with deterministic local test doubles.
 *
 * The standalone fork cannot install the upstream pnpm workspace, so tests run
 * the real production source against these doubles instead of the real DSH
 * services. Each double mirrors the upstream contract the plugin consumes; the
 * full monorepo test suite remains the authoritative integration check.
 */
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mapping = new Map([
  ['@deepseek-ai/cordis', join(here, 'cordis.mjs')],
  ['@deepseek-ai/dsh-llm', join(here, 'dsh-llm.mjs')],
  ['@deepseek-ai/dsh-util-values', join(here, 'dsh-util-values.mjs')],
  ['@deepseek-ai/dsh-permission-presets', join(here, 'dsh-permission-presets.mjs')],
  ['@deepseek-ai/dsh-tools', join(here, 'dsh-tools.mjs')],
])

registerHooks({
  resolve(specifier, context, nextResolve) {
    const local = mapping.get(specifier)
    if (local !== undefined) return { url: pathToFileURL(local).href, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
