/**
 * Test double for `@deepseek-ai/cordis` 4.1.0, limited to the fiber state the
 * harness exposes through `ctx.root.fiber.state`. Cordis declares `FiberState`
 * as a `const enum` whose values are the member indexes, so the double repeats
 * those numbers: the production source compares against the inlined
 * `FIBER_STATE_ACTIVE` literal because the shipped package exports no
 * `FiberState` binding. The harness context (tests/harness/harness.mjs)
 * supplies everything else.
 */
export const FiberState = Object.freeze({
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
})
