/**
 * Full-auto reviewer-denial setting tests (`autoDenyReviewerRejections`).
 *
 * The Auto permission preset pins the official approval mode to `ask` and the
 * GUI exposes no approval knob, so the integration owns this extra switch:
 *
 * - default / explicit `false`: every existing behavior is preserved — a
 *   reviewer denial under `ask` still asks exactly one human question, the
 *   `never` mode still rejects automatically, reviewer allow still executes.
 * - `true`: a reviewer `deny` maps directly to the same final automatic denial
 *   the `never` mode writes (concise reviewer concern included), the tool body
 *   never executes, and no `approval.request()`, human question, approval
 *   audit pair or timeout timer is created. Reviewer allow and technical
 *   failures are untouched.
 *
 * The setting is volatile and read once per reviewed call, so the last test
 * flips a live ref between calls.
 *
 * Run with: npm test            (source, Node native TypeScript stripping)
 *           npm run test:lib    (built lib/ artifact)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin, targetName } from './target.mjs'
import { createHarness, reasoningChunks, textChunks } from './harness/harness.mjs'

const plugin = await loadPlugin()

const CONCERN = 'the call would export a production credential store'
const REVIEWER_DENIAL = JSON.stringify({ risk: 'medium', decision: 'deny', reason: CONCERN })
const REVIEWER_DENIAL_NO_REASON = '{"risk":"medium","decision":"deny"}'
const HUMAN_REJECTED = 'the user rejected tool "probe"'
const HUMAN_REJECTED_WITH_CONCERN = `${HUMAN_REJECTED}; Auto review concern: ${CONCERN}`
const AUTOMATIC_DENIED = 'Auto review rejected tool "probe"; its body was not executed'
const AUTOMATIC_DENIED_WITH_CONCERN = `${AUTOMATIC_DENIED}: ${CONCERN}`
const AUTO_DENIED_INFO = { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED' }
/** Fractional minutes used to prove no timeout timer is derived. */
const TICK_MINUTES = 0.001
const TICK_MS = 60

/** Create one Auto-session harness with an optional Loader config and answerer. */
function harnessFor(options = {}) {
  const harness = createHarness({
    plugin,
    reviewScript: options.script ?? [textChunks(REVIEWER_DENIAL)],
    ...options.config === undefined ? {} : { config: options.config },
  })
  if (options.answer !== undefined) {
    harness.ctx.on('approval/request', () => Promise.resolve(options.answer))
  }
  return harness
}

/** Append one valid pending native call and execute it once. */
async function reviewOneCall(harness, input = {}) {
  const { session, agent } = harness.newSession(input.sessionId ?? 'session-auto-deny')
  harness.appendTurnStart(session)
  harness.appendNativeCall(session, { callId: input.callId ?? 'call-1' })
  const result = await harness.executeTool({ agent, callId: input.callId ?? 'call-1' })
  return { session, agent, result }
}

/** Collect the audited approval question/decision pair. */
function auditEvents(session) {
  return {
    asked: session.snapshotEvents().filter(event => event.type === 'approval/asked').map(event => event.data),
    decided: session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data),
  }
}

/**
 * Record every timer the plugin schedules through the global timing functions,
 * and restore them after the test. A configured timeout must not derive one on
 * the fully automatic denial path.
 */
function spyTimers(t) {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const scheduled = []
  globalThis.setTimeout = (fn, ms, ...args) => {
    scheduled.push(ms)
    return realSetTimeout(fn, ms, ...args)
  }
  globalThis.clearTimeout = handle => realClearTimeout(handle)
  t.after(() => {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  })
  return { delays: () => [...scheduled] }
}

// ---------------------------------------------------------------------------
// Config schema and defaults.
// ---------------------------------------------------------------------------

test(`auto-deny config: Loader schema declares a volatile default-off switch (${targetName})`, () => {
  assert.equal(plugin.Config.type, 'object')
  const field = plugin.Config.dict.autoDenyReviewerRejections
  assert.equal(field.type, 'boolean')
  assert.equal(field.meta.default, false, 'the documented default is false (existing behavior)')
  assert.equal(field.meta.volatile, true, 'the setting must be read live per reviewed call')
  // The minute timeout field is untouched by this setting.
  assert.equal(plugin.Config.dict.approvalTimeoutMinutes.meta.default, 0)
})

test(`auto-deny config: the default keeps asking the human (${targetName})`, async () => {
  const harness = harnessFor({ answer: 'rejected' })
  try {
    const { result, session } = await reviewOneCall(harness)
    assert.equal(result.isError, true)
    assert.equal(result.error.message, HUMAN_REJECTED_WITH_CONCERN)
    assert.deepEqual(result.error.info, {
      name: 'ApprovalError',
      code: 'APPROVAL_REJECTED',
      reason: CONCERN,
    })
    assert.equal(harness.approvalRequests.length, 1, 'the default must still ask exactly one human')
    assert.equal(harness.runs, 0)
    assert.deepEqual(auditEvents(session).decided.map(entry => entry.outcome), ['rejected'])
  } finally {
    await harness.dispose()
  }
})

test(`auto-deny config: an explicit false keeps asking the human (${targetName})`, async () => {
  const harness = harnessFor({
    config: { autoDenyReviewerRejections: false },
    answer: 'allowed-once',
  })
  try {
    const { result } = await reviewOneCall(harness)
    assert.equal(result.isError, false)
    assert.equal(harness.approvalRequests.length, 1)
    assert.equal(harness.runs, 1)
  } finally {
    await harness.dispose()
  }
})

// ---------------------------------------------------------------------------
// Enabled: reviewer denials are final and never ask.
// ---------------------------------------------------------------------------

test(`auto-deny enabled: ask mode denial is final with the reviewer concern and no question (${targetName})`, async t => {
  const timers = spyTimers(t)
  const harness = harnessFor({
    // Even a configured minute timeout must not derive a timer here.
    config: { autoDenyReviewerRejections: true, approvalTimeoutMinutes: TICK_MINUTES },
    answer: 'allowed-once',
  })
  try {
    const { result, session } = await reviewOneCall(harness)
    assert.equal(result.isError, true)
    assert.equal(result.error.message, AUTOMATIC_DENIED_WITH_CONCERN)
    assert.deepEqual(result.content, [{ type: 'text', text: `Error: ${AUTOMATIC_DENIED_WITH_CONCERN}` }])
    assert.deepEqual(result.error.info, { ...AUTO_DENIED_INFO, reason: CONCERN })
    assert.equal(harness.runs, 0, 'the denied body must never execute')
    assert.equal(harness.approvalRequests.length, 0, 'no approval.request may be made')
    assert.deepEqual(auditEvents(session), { asked: [], decided: [] }, 'no approval audit pair may be written')
    assert.deepEqual(timers.delays(), [], 'no timeout timer may be derived')
  } finally {
    await harness.dispose()
  }
})

test(`auto-deny enabled: a missing reviewer concern stays concise (${targetName})`, async t => {
  const timers = spyTimers(t)
  const harness = harnessFor({
    config: { autoDenyReviewerRejections: true },
    script: [textChunks(REVIEWER_DENIAL_NO_REASON)],
  })
  try {
    const { result } = await reviewOneCall(harness)
    assert.equal(result.error.message, AUTOMATIC_DENIED)
    assert.equal(result.error.message.includes('concern'), false)
    assert.deepEqual(result.error.info, AUTO_DENIED_INFO)
    assert.equal(harness.runs, 0)
    assert.equal(harness.approvalRequests.length, 0)
    assert.deepEqual(timers.delays(), [])
  } finally {
    await harness.dispose()
  }
})

test(`auto-deny enabled: a whitespace-only concern stays out of the text (${targetName})`, async () => {
  const harness = harnessFor({
    config: { autoDenyReviewerRejections: true },
    script: [textChunks(JSON.stringify({ risk: 'high', decision: 'deny', reason: '   ' }))],
  })
  try {
    const { result } = await reviewOneCall(harness)
    assert.equal(result.error.message, AUTOMATIC_DENIED)
    // The raw reviewer string stays durable structured detail, as on the never path.
    assert.equal(result.error.info.reason, '   ')
    assert.equal(harness.runs, 0)
  } finally {
    await harness.dispose()
  }
})

test(`auto-deny enabled: the reviewer chain-of-thought is never exposed (${targetName})`, async () => {
  const secret = 'PRIVATE-CHAIN-OF-THOUGHT 91ac'
  const harness = harnessFor({
    config: { autoDenyReviewerRejections: true },
    script: [reasoningChunks(secret, REVIEWER_DENIAL)],
  })
  try {
    const { result } = await reviewOneCall(harness)
    assert.equal(result.error.message, AUTOMATIC_DENIED_WITH_CONCERN)
    assert.equal(JSON.stringify(result).includes(secret), false)
    assert.equal(harness.runs, 0)
  } finally {
    await harness.dispose()
  }
})

test(`auto-deny enabled: the never mode keeps its identical automatic denial (${targetName})`, async () => {
  const harness = harnessFor({
    config: { autoDenyReviewerRejections: true },
    override: 'never',
  })
  try {
    const { result, session } = await reviewOneCall(harness)
    assert.equal(result.error.message, AUTOMATIC_DENIED_WITH_CONCERN)
    assert.deepEqual(result.error.info, { ...AUTO_DENIED_INFO, reason: CONCERN })
    assert.equal(harness.approvalRequests.length, 0)
    assert.equal(harness.runs, 0)
    assert.deepEqual(auditEvents(session), { asked: [], decided: [] })
  } finally {
    await harness.dispose()
  }
})

test(`auto-deny enabled: reviewer allow still executes the body (${targetName})`, async () => {
  const harness = harnessFor({
    config: { autoDenyReviewerRejections: true },
    script: [textChunks('{"risk":"low","decision":"allow"}')],
  })
  try {
    const { result } = await reviewOneCall(harness)
    assert.equal(result.isError, false)
    assert.equal(harness.runs, 1)
    assert.equal(harness.approvalRequests.length, 0)
  } finally {
    await harness.dispose()
  }
})

test(`auto-deny enabled: a technical reviewer failure keeps failed() unchanged (${targetName})`, async () => {
  const harness = harnessFor({
    config: { autoDenyReviewerRejections: true },
    script: [async function* providerFailure() { throw new Error('provider secret') }],
  })
  try {
    const { result } = await reviewOneCall(harness)
    assert.equal(result.isError, true)
    assert.equal(
      result.error.message,
      'Auto review of tool "probe" failed; its body was not executed: '
      + 'auto-review: reviewer ended with error UNKNOWN: provider secret',
    )
    assert.deepEqual(result.error.info, { name: 'AutoReviewFailedError', code: 'AUTO_REVIEW_FAILED' })
    assert.equal(harness.runs, 0)
    assert.equal(harness.approvalRequests.length, 0)
  } finally {
    await harness.dispose()
  }
})

// ---------------------------------------------------------------------------
// Volatile: the next reviewed call reads the changed value.
// ---------------------------------------------------------------------------

test(`auto-deny config: a live volatile ref is read on every reviewed call (${targetName})`, async () => {
  const live = { autoDeny: false }
  const harness = harnessFor({
    config: { autoDenyReviewerRejections: { get: () => live.autoDeny } },
    script: [textChunks(REVIEWER_DENIAL), textChunks(REVIEWER_DENIAL)],
  })
  harness.ctx.on('approval/request', () => Promise.resolve('rejected'))
  try {
    const first = await reviewOneCall(harness, { callId: 'call-1' })
    assert.equal(first.result.error.message, HUMAN_REJECTED_WITH_CONCERN)
    assert.equal(harness.approvalRequests.length, 1)

    live.autoDeny = true
    const second = await reviewOneCall(harness, { sessionId: 'session-auto-deny-2', callId: 'call-2' })
    assert.equal(second.result.error.message, AUTOMATIC_DENIED_WITH_CONCERN)
    assert.deepEqual(second.result.error.info, { ...AUTO_DENIED_INFO, reason: CONCERN })
    assert.equal(harness.approvalRequests.length, 1, 'the live true value must not ask a human')
    assert.equal(harness.runs, 0)
  } finally {
    await harness.dispose()
  }
})
