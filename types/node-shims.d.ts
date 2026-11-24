/**
 * Minimal ambient declarations for the Node.js built-ins the Phase 1
 * deterministic rule gate uses.
 *
 * This standalone fork typechecks against trimmed declarations and has no
 * `@types/node` dependency (see `types/dsh-0.2.2-rc.3.d.ts`); every member
 * below is limited to what `src/index.ts` actually calls. A real monorepo
 * `pnpm typecheck` remains the definitive check against the official types.
 */

declare module 'node:crypto' {
  export interface Hash {
    update(data: string): Hash
    digest(encoding: 'hex'): string
  }
  export function createHash(algorithm: string): Hash
}

declare module 'node:fs' {
  /**
   * `realpathSync` also exposes the native resolver as `.native()`, matching
   * Node's runtime shape.
   */
  export interface RealpathSync {
    (path: string): string
    native(path: string): string
  }
  export const realpathSync: RealpathSync
  export function mkdirSync(
    path: string,
    options?: { readonly recursive?: boolean; readonly mode?: number },
  ): string | undefined
  export function appendFileSync(
    path: string,
    data: string,
    options?: { readonly mode?: number },
  ): void
}

declare module 'node:os' {
  export function homedir(): string
}

declare module 'node:path' {
  export const sep: string
  export function resolve(...paths: string[]): string
  export function dirname(path: string): string
  export function relative(from: string, to: string): string
  export function isAbsolute(path: string): boolean
}
