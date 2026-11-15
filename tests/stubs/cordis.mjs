/**
 * Test double for `@deepseek-ai/cordis` 4.1.0, limited to the member the
 * production source reads at runtime (`FiberState.ACTIVE`). The harness
 * context (tests/harness/harness.mjs) supplies everything else.
 */
export const FiberState = Object.freeze({ ACTIVE: 'active' })
