/**
 * Human-response timeout acceptance tests for the Issue #5 patch.
 *
 * These run the real production source (or the built `lib/` artifact) against
 * the standalone harness. They cover the confirmed design: a minute-based
 * `approvalTimeoutMinutes` setting that is off by default and validated before
 * conversion, a deadline derived only for a question a human is really asked,
 * a deny that names human non-response (never a human rejection) while keeping
 * the reviewer's concise concern, discarded late answers, caller cancellation
 * and teardown precedence over the deadline, timer/signal cleanup for every
 * settlement, and the unchanged fail-closed mappings for unavailable/failed
 * approvals.
 *
 * No test waits for minutes: positive fractional minutes convert to bounded
 * millisecond deadlines (0.001 min = 60 ms), and every waiting test passes
 * `timeout` so a regression fails instead of hanging.
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
const AUDITED_QUESTION = `Auto review denied tool "probe": ${CONCERN}`
const TIMEOUT_ERROR = 'AutoReviewApprovalTimeoutError'
const TIMEOUT_CODE = 'AUTO_REVIEW_APPROVAL_TIMEOUT'

/** 0.001 minute = 60 ms, the bounded deadline the timing tests use. */
const TICK_MINUTES = 0.001
const TICK_MS = 60
/** 0.002 minute = 120 ms, used when the test must finish before the deadline. */
const SLOW_TICK_MINUTES = 0.002
const SLOW_TICK_MS = 120
/** A long deadline that must never fire because cancellation or teardown wins. */
const LONG_MINUTES = 0.05
const LONG_MS = 3_000

/** Create one Auto-session harness with an optional Loader config and answerer. */
function harnessFor(options = {}) {
  const harness = createHarness({
    plugin,
    reviewScript: options.script ?? [textChunks(REVIEWER_DENIAL)],
    defaultApprovalPolicy: options.defaultPolicy ?? 'ask',
    approvalPolicyOverride: options.override === undefined
      ? undefined
      : typeof options.override === 'function' ? options.override : () => options.override,
    ...options.config === undefined ? {} : { config: options.config },
  })
  if (options.answer !== undefined) {
    harness.ctx.on('approval/request', () => Promise.resolve(options.answer))
  }
  return harness
}

/** Append a valid native-call history and execute the pending call once. */
async function reviewOneCall(harness, input = {}) {
  const { session, agent } = harness.newSession(input.sessionId ?? 'session-timeout')
  harness.appendTurnStart(session)
  harness.appendNativeCall(session, { callId: input.callId ?? 'call-1' })
  const result = await harness.executeTool({
    agent,
    callId: input.callId ?? 'call-1',
    ...input.signal === undefined ? {} : { signal: input.signal },
  })
  return { session, agent, result }
}

/** Bounded sleep; tests never wait for real minutes. */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Poll until a condition holds, bounded by 1000 macrotasks. */
async function until(predicate, label = 'condition') {
  for (let attempt = 0; attempt < 1_000 && !predicate(); attempt += 1) {
    await sleep(0)
  }
  if (!predicate()) throw new Error(`${label} did not become true`)
}

/** Collect the audited approval question/decision pair. */
function auditEvents(session) {
  return {
    asked: session.snapshotEvents().filter(event => event.type === 'approval/asked').map(event => event.data),
    decided: session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data),
  }
}

/**
 * Record every deadline timer the plugin schedules through the global timing
 * functions, and restore them after the test. Delays are matched exactly, so
 * test-owned short sleeps cannot satisfy a deadline assertion.
 */
function spyTimers(t) {
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const scheduled = []
  const pending = new Map()
  globalThis.setTimeout = (fn, ms, ...args) => {
    const handle = realSetTimeout(fn, ms, ...args)
    scheduled.push(ms)
    pending.set(handle, ms)
    return handle
  }
  globalThis.clearTimeout = (handle) => {
    pending.delete(handle)
    return realClearTimeout(handle)
  }
  t.after(() => {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  })
  return {
    /** Times the plugin scheduled so far. */
    delays: () => [...scheduled],
    /** Deadline-timer handles still armed for one exact delay. */
    pending: (ms) => [...pending.values()].filter(delay => delay === ms).length,
  }
}

// ---------------------------------------------------------------------------
// Configuration: default off, conversion, bounds, volatility.
// ---------------------------------------------------------------------------

test(`timeout config: conversion to bounded integer milliseconds (${targetName})`, () => {
  assert.equal(plugin.MAX_APPROVAL_TIMEOUT_MINUTES, 1_440)
  assert.equal(plugin.resolveApprovalTimeoutMs(0.001), 60)
  assert.equal(plugin.resolveApprovalTimeoutMs(0.002), 120)
  assert.equal(plugin.resolveApprovalTimeoutMs(0.5), 30_000)
  assert.equal(plugin.resolveApprovalTimeoutMs(1), 60_000)
  assert.equal(plugin.resolveApprovalTimeoutMs(2.5), 150_000)
  assert.equal(plugin.resolveApprovalTimeoutMs(1_440), 86_400_000)
  // Sub-millisecond values round up; the result stays a positive integer.
  assert.equal(plugin.resolveApprovalTimeoutMs(0.00001), 1)
  assert.ok(Number.isInteger(plugin.resolveApprovalTimeoutMs(0.001)))
  // The documented cap keeps the deadline far inside the 32-bit timer range.
  assert.ok(plugin.resolveApprovalTimeoutMs(plugin.MAX_APPROVAL_TIMEOUT_MINUTES) <= 2_147_483_647)
})

test(`timeout config: only missing or zero disables; invalid values are rejected (${targetName})`, () => {
  assert.equal(plugin.resolveApprovalTimeoutMs(undefined), 0)
  assert.equal(plugin.resolveApprovalTimeoutMs(-0), 0)

  for (const value of [null, '5', '  1  ', true, false, {}, [], () => 1]) {
    assert.throws(
      () => plugin.resolveApprovalTimeoutMs(value),
      error => error instanceof TypeError && error.message.includes('approvalTimeoutMinutes'),
      `expected a TypeError for ${String(value)}`,
    )
  }
  for (const value of [
    -1,
    -0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    plugin.MAX_APPROVAL_TIMEOUT_MINUTES + 1,
    10_080,
  ]) {
    assert.throws(
      () => plugin.resolveApprovalTimeoutMs(value),
      error => error instanceof RangeError && error.message.includes('approvalTimeoutMinutes'),
      `expected a RangeError for ${String(value)}`,
    )
  }
})

test(`timeout config: Loader schema declares a volatile default-off field (${targetName})`, () => {
  assert.equal(plugin.Config.type, 'object')
  const field = plugin.Config.dict.approvalTimeoutMinutes
  assert.equal(field.type, 'number')
  assert.equal(field.meta.default, 0, 'the documented default is 0 (disabled)')
  assert.equal(field.meta.min, 0, 'negative minutes are rejected')
  assert.equal(field.meta.max, 1_440, 'the human deadline is capped at 24 hours')
  assert.equal(field.meta.volatile, true, 'the setting must be read live per request')
})

test(`timeout config: absent config defaults to no timer (${targetName})`, async t => {
  const timers = spyTimers(t)
  const harness = harnessFor({ answer: 'rejected' })
  try {
    const { result, session } = await reviewOneCall(harness)
    assert.equal(result.isError, true)
    assert.equal(result.error.message, HUMAN_REJECTED_WITH_CONCERN)
    assert.deepEqual(auditEvents(session).decided.map(entry => entry.outcome), ['rejected'])
    assert.deepEqual(timers.delays(), [])
  } finally {
    await harness.dispose()
  }
})

test(`timeout config: an explicit 0 keeps the timeout disabled (${targetName})`, async t => {
  const timers = spyTimers(t)
  const harness = harnessFor({ config: { approvalTimeoutMinutes: 0 }, answer: 'rejected' })
  try {
    const { result } = await reviewOneCall(harness)
    assert.equal(result.error.message, HUMAN_REJECTED_WITH_CONCERN)
    assert.deepEqual(timers.delays(), [])
  } finally {
    await harness.dispose()
  }
})

test(`timeout config: an invalid value fails closed without a timer or approval request (${targetName})`, async t => {
  const timers = spyTimers(t)
  const harness = harnessFor({
    config: { approvalTimeoutMinutes: plugin.MAX_APPROVAL_TIMEOUT_MINUTES + 1 },
    answer: 'rejected',
  })
  try {
    const { result } = await reviewOneCall(harness)
    assert.equal(result.isError, true)
    assert.match(result.error.message, /approvalTimeoutMinutes/)
    assert.match(result.error.message, /1,440|1440/)
    assert.equal(harness.approvalRequests.length, 0, 'invalid config must not ask a human')
    assert.equal(harness.runs, 0, 'invalid config must not execute the tool body')
    assert.deepEqual(timers.delays(), [], 'invalid config must not create a deadline')
  } finally {
    await harness.dispose()
  }
})

test(`timeout config: a live volatile ref is read on every human question (${targetName})`, async t => {
  const timers = spyTimers(t)
  const live = { minutes: 0 }
  const harness = harnessFor({
    config: { approvalTimeoutMinutes: { get: () => live.minutes } },
    script: [textChunks(REVIEWER_DENIAL), textChunks(REVIEWER_DENIAL)],
  })
  let answer = 'rejected'
  harness.ctx.on('approval/request', () => (answer === 'rejected' ? Promise.resolve('rejected') : new Promise(() => {})))
  try {
    const first = await reviewOneCall(harness, { callId: 'call-1' })
    assert.equal(first.result.error.message, HUMAN_REJECTED_WITH_CONCERN)
    // Disabled at 0: no deadline timer was derived for the first question.
    assert.deepEqual(timers.delays(), [])

    live.minutes = SLOW_TICK_MINUTES
    answer = 'hang'
    const second = await reviewOneCall(harness, { sessionId: 'session-timeout-2', callId: 'call-2' })
    assert.equal(second.result.error.info.code, TIMEOUT_CODE)
    assert.equal(timers.delays().filter(ms => ms === SLOW_TICK_MS).length, 1)
  } finally {
    await harness.dispose()
  }
})

// ---------------------------------------------------------------------------
// Only a real human question gets a deadline; approval=never never asks.
// ---------------------------------------------------------------------------

test(`timeout config: approval=never auto-denies without a timer or question (${targetName})`, async t => {
  const timers = spyTimers(t)
  const harness = harnessFor({
    config: { approvalTimeoutMinutes: TICK_MINUTES },
    override: 'never',
  })
  try {
    const { result, session } = await reviewOneCall(harness)
    assert.equal(result.isError, true)
    assert.equal(
      result.error.message,
      `Auto review rejected tool "probe"; its body was not executed: ${CONCERN}`,
    )
    assert.deepEqual(result.error.info, {
      name: 'AutoReviewDeniedError',
      code: 'AUTO_REVIEW_DENIED',
      reason: CONCERN,
    })
    assert.equal(harness.approvalRequests.length, 0)
    assert.equal(harness.runs, 0)
    assert.deepEqual(timers.delays(), [])
    assert.deepEqual(auditEvents(session), { asked: [], decided: [] })
  } finally {
    await harness.dispose()
  }
})

test(`timeout config: a reviewer allow never starts a human timer (${targetName})`, async t => {
  const timers = spyTimers(t)
  const harness = harnessFor({
    config: { approvalTimeoutMinutes: TICK_MINUTES },
    script: [textChunks('{"risk":"low","decision":"allow"}')],
  })
  try {
    const { result } = await reviewOneCall(harness)
    assert.equal(result.isError, false)
    assert.equal(harness.runs, 1)
    assert.equal(harness.approvalRequests.length, 0)
    assert.deepEqual(timers.delays(), [])
  } finally {
    await harness.dispose()
  }
})

test(`timeout config: policy ask answers before the deadline keep their mapping (${targetName})`, async t => {
  const timers = spyTimers(t)
  const harness = harnessFor({ config: { approvalTimeoutMinutes: TICK_MINUTES }, answer: 'rejected' })
  try {
    const { result, session } = await reviewOneCall(harness)
    assert.equal(result.isError, true)
    assert.equal(result.error.message, HUMAN_REJECTED_WITH_CONCERN)
    assert.deepEqual(result.error.info, {
      name: 'ApprovalError',
      code: 'APPROVAL_REJECTED',
      reason: CONCERN,
    })
    assert.equal(harness.runs, 0)
    assert.equal(timers.delays().filter(ms => ms === TICK_MS).length, 1)
    assert.equal(timers.pending(TICK_MS), 0, 'the deadline timer must be cleared')
    assert.deepEqual(auditEvents(session).decided.map(entry => entry.outcome), ['rejected'])
  } finally {
    await harness.dispose()
  }
})

// ---------------------------------------------------------------------------
// Timeout itself: deny as human non-response, keep the concern, discard late
// answers, never execute the body.
// ---------------------------------------------------------------------------

test(`timeout: deny names human non-response and keeps the concern (${targetName})`, async t => {
  const timers = spyTimers(t)
  const harness = harnessFor({ config: { approvalTimeoutMinutes: TICK_MINUTES } })
  // A human question that never answers: only the deadline can settle it.
  harness.ctx.on('approval/request', () => new Promise(() => {}))
  const started = Date.now()
  try {
    const { result, session } = await reviewOneCall(harness)
    const elapsed = Date.now() - started
    const expected = `Auto review denied tool "probe": the human approval request timed out after 0.001 minutes with no response; its body was not executed; Auto review concern: ${CONCERN}`
    assert.equal(result.isError, true)
    assert.equal(result.error.message, expected)
    assert.deepEqual(result.content, [{ type: 'text', text: `Error: ${expected}` }])
    assert.deepEqual(result.error.info, {
      name: TIMEOUT_ERROR,
      code: TIMEOUT_CODE,
      reason: CONCERN,
    })
    // It is emphatically NOT a human rejection.
    assert.equal(result.error.message.includes('user rejected'), false)
    assert.equal(result.error.message.includes('the user'), false)
    assert.equal(result.error.message.includes('timed out'), true)
    assert.equal(result.error.message.includes('no response'), true)
    assert.equal(harness.runs, 0, 'the tool body must never execute after a timeout')
    // Bounded real deadline: 60 ms with generous scheduling headroom.
    assert.ok(elapsed >= 40, `timeout fired too early: ${elapsed}ms`)
    assert.ok(elapsed < 3_000, `timeout took too long: ${elapsed}ms`)
    // The deadlined question is withdrawn, so the audit records a cancellation.
    await until(() => auditEvents(session).decided.length === 1, 'approval/decided')
    assert.equal(harness.approvalRequests[0].reason, AUDITED_QUESTION)
    assert.deepEqual(auditEvents(session).asked.map(entry => entry.reason), [AUDITED_QUESTION])
    assert.deepEqual(auditEvents(session).decided.map(entry => entry.outcome), ['cancelled'])
    assert.equal(harness.approvalRequests[0].signal.aborted, true)
    assert.equal(timers.delays().filter(ms => ms === TICK_MS).length, 1)
    assert.equal(timers.pending(TICK_MS), 0, 'the deadline timer must be cleared')
  } finally {
    await harness.dispose()
  }
})

test(`timeout: a missing reviewer concern stays concise and is not invented (${targetName})`, async t => {
  const timers = spyTimers(t)
  const harness = harnessFor({
    config: { approvalTimeoutMinutes: TICK_MINUTES },
    script: [textChunks(REVIEWER_DENIAL_NO_REASON)],
  })
  harness.ctx.on('approval/request', () => new Promise(() => {}))
  try {
    const { result } = await reviewOneCall(harness)
    const expected = 'Auto review denied tool "probe": the human approval request timed out after 0.001 minutes with no response; its body was not executed'
    assert.equal(result.error.message, expected)
    assert.equal(result.error.message.includes('concern'), false)
    assert.deepEqual(result.error.info, { name: TIMEOUT_ERROR, code: TIMEOUT_CODE })
    assert.equal(harness.runs, 0)
    assert.equal(timers.pending(TICK_MS), 0)
  } finally {
    await harness.dispose()
  }
})

test(`timeout: a whitespace-only reviewer concern stays out of the text (${targetName})`, async t => {
  const timers = spyTimers(t)
  const harness = harnessFor({
    config: { approvalTimeoutMinutes: TICK_MINUTES },
    script: [textChunks(JSON.stringify({ risk: 'medium', decision: 'deny', reason: '   ' }))],
  })
  harness.ctx.on('approval/request', () => new Promise(() => {}))
  try {
    const { result } = await reviewOneCall(harness)
    assert.equal(result.error.message.includes('; Auto review concern:'), false)
    // The raw reviewer string is still durable structured detail.
    assert.equal(result.error.info.reason, '   ')
    assert.equal(harness.runs, 0)
    assert.equal(timers.pending(TICK_MS), 0)
  } finally {
    await harness.dispose()
  }
})

test(`timeout: reviewer chain-of-thought is never exposed (${targetName})`, async t => {
  const timers = spyTimers(t)
  const secret = 'PRIVATE-CHAIN-OF-THOUGHT 77ab'
  const harness = harnessFor({
    config: { approvalTimeoutMinutes: TICK_MINUTES },
    script: [reasoningChunks(secret, REVIEWER_DENIAL)],
  })
  harness.ctx.on('approval/request', () => new Promise(() => {}))
  try {
    const { result } = await reviewOneCall(harness)
    assert.equal(result.error.message.includes(CONCERN), true)
    assert.equal(JSON.stringify(result).includes(secret), false)
    assert.equal(JSON.stringify(result).includes('PRIVATE-CHAIN-OF-THOUGHT'), false)
    assert.equal(harness.runs, 0)
    assert.equal(timers.pending(TICK_MS), 0)
  } finally {
    await harness.dispose()
  }
})

test(`timeout: a late human allow is discarded and never executes the body (${targetName})`, async t => {
  const timers = spyTimers(t)
  const harness = harnessFor({ config: { approvalTimeoutMinutes: TICK_MINUTES } })
  let release
  harness.ctx.on('approval/request', () => new Promise((resolve) => { release = resolve }))
  try {
    const { result, session } = await reviewOneCall(harness)
    assert.equal(result.error.info.code, TIMEOUT_CODE)
    await until(() => auditEvents(session).decided.length === 1, 'approval/decided')

    // The human finally answers "allow" after the deadline: it is ignored.
    await sleep(5)
    release('allowed-once')
    await sleep(20)
    assert.equal(harness.runs, 0, 'a late allow must never dispatch the body')
    assert.equal(harness.approvalRequests.length, 1, 'no second question may be asked')
    assert.deepEqual(auditEvents(session).asked.length, 1)
    assert.deepEqual(auditEvents(session).decided.map(entry => entry.outcome), ['cancelled'])
    assert.equal(result.error.info.code, TIMEOUT_CODE)
    assert.equal(timers.pending(TICK_MS), 0)
  } finally {
    await harness.dispose()
  }
})

test(`timeout: a late human rejection is discarded (${targetName})`, async t => {
  const timers = spyTimers(t)
  const harness = harnessFor({ config: { approvalTimeoutMinutes: TICK_MINUTES } })
  let release
  harness.ctx.on('approval/request', () => new Promise((resolve) => { release = resolve }))
  try {
    const { result, session } = await reviewOneCall(harness)
    await until(() => auditEvents(session).decided.length === 1, 'approval/decided')
    release('rejected')
    await sleep(20)
    assert.equal(harness.runs, 0)
    assert.equal(result.error.info.code, TIMEOUT_CODE)
    assert.equal(result.error.message.includes('user rejected'), false)
    assert.deepEqual(auditEvents(session).decided.map(entry => entry.outcome), ['cancelled'])
    assert.equal(timers.pending(TICK_MS), 0)
  } finally {
    await harness.dispose()
  }
})

// ---------------------------------------------------------------------------
// Cancellation and teardown take precedence over the human deadline.
// ---------------------------------------------------------------------------

test(`timeout: caller cancellation wins over the pending deadline (${targetName})`, async t => {
  const timers = spyTimers(t)
  const harness = harnessFor({ config: { approvalTimeoutMinutes: LONG_MINUTES } })
  harness.ctx.on('approval/request', () => new Promise(() => {}))
  try {
    const { session, agent } = harness.newSession('session-timeout-cancel')
    harness.appendTurnStart(session)
    harness.appendNativeCall(session, { callId: 'call-1' })
    const controller = new AbortController()
    const pending = harness.executeTool({ agent, callId: 'call-1', signal: controller.signal })
    await until(() => harness.approvalRequests.length === 1, 'approval question')
    controller.abort()
    const result = await pending
    assert.equal(result.isError, true)
    assert.equal(result.error.message, 'tool call aborted before dispatch')
    assert.deepEqual(result.error.info, { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' })
    assert.equal(harness.runs, 0)
    assert.equal(timers.pending(LONG_MS), 0, 'the deadline timer must be cleared')
    await until(() => auditEvents(session).decided.length === 1, 'approval/decided')
    assert.deepEqual(auditEvents(session).decided.map(entry => entry.outcome), ['cancelled'])
  } finally {
    await harness.dispose()
  }
})

test(`timeout: integration teardown withdraws the question, not times out (${targetName})`, async t => {
  const timers = spyTimers(t)
  const harness = harnessFor({ config: { approvalTimeoutMinutes: LONG_MINUTES } })
  harness.ctx.on('approval/request', () => new Promise(() => {}))
  const { session, agent } = harness.newSession('session-timeout-teardown')
  harness.appendTurnStart(session)
  harness.appendNativeCall(session, { callId: 'call-1' })
  const pending = harness.executeTool({ agent, callId: 'call-1' })
  await until(() => harness.approvalRequests.length === 1, 'approval question')

  let timer
  let disposed = false
  try {
    await Promise.race([
      (async () => {
        await harness.dispose()
        disposed = true
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('dispose() did not withdraw the pending approval question')),
          1_000,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
  const result = await pending
  assert.equal(disposed, true)
  assert.equal(result.isError, true)
  assert.deepEqual(result.error.info, { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' })
  assert.equal(harness.runs, 0)
  assert.equal(timers.pending(LONG_MS), 0, 'the deadline timer must be cleared')
  assert.deepEqual(auditEvents(session).decided.map(entry => entry.outcome), ['cancelled'])
})

// ---------------------------------------------------------------------------
// Unchanged containment: unavailable and throwing approval requests.
// ---------------------------------------------------------------------------

test(`timeout: no answerer still fails closed and clears the timer (${targetName})`, async t => {
  const timers = spyTimers(t)
  const harness = harnessFor({ config: { approvalTimeoutMinutes: TICK_MINUTES } })
  const started = Date.now()
  try {
    const { result, session } = await reviewOneCall(harness)
    assert.equal(result.isError, true)
    assert.equal(
      result.error.message,
      'tool "probe" requires approval, but no approval channel is available',
    )
    assert.deepEqual(result.error.info, { name: 'ApprovalError', code: 'APPROVAL_UNAVAILABLE' })
    assert.equal(harness.runs, 0)
    assert.ok(Date.now() - started < 1_000, 'an unavailable answerer must not wait for the deadline')
    assert.equal(timers.delays().filter(ms => ms === TICK_MS).length, 1)
    assert.equal(timers.pending(TICK_MS), 0)
    assert.deepEqual(auditEvents(session).decided.map(entry => entry.outcome), ['unavailable'])
  } finally {
    await harness.dispose()
  }
})

test(`timeout: a throwing approval request keeps its containment (${targetName})`, async t => {
  const timers = spyTimers(t)
  const harness = harnessFor({ config: { approvalTimeoutMinutes: TICK_MINUTES } })
  harness.ctx.approval.request = async () => {
    throw new Error('approval audit append failed')
  }
  try {
    const { result } = await reviewOneCall(harness)
    assert.equal(result.isError, true)
    assert.equal(result.error.message, 'approval audit append failed')
    assert.equal(harness.runs, 0)
    assert.equal(timers.pending(TICK_MS), 0, 'the deadline timer must be cleared on a thrown request')
  } finally {
    await harness.dispose()
  }
})

// ---------------------------------------------------------------------------
// Timer cleanup when a human answers in time.
// ---------------------------------------------------------------------------

test(`timeout: an in-time allow clears the deadline so the grant stays valid (${targetName})`, async t => {
  const timers = spyTimers(t)
  const harness = harnessFor({
    config: { approvalTimeoutMinutes: SLOW_TICK_MINUTES },
    answer: 'allowed-once',
  })
  try {
    const { result, session } = await reviewOneCall(harness)
    assert.equal(result.isError, false, 'an in-time human allow must execute normally')
    assert.equal(harness.runs, 1)
    const askedSignal = harness.approvalRequests[0].signal
    assert.equal(askedSignal.aborted, false)
    assert.equal(timers.delays().filter(ms => ms === SLOW_TICK_MS).length, 1)
    assert.equal(timers.pending(SLOW_TICK_MS), 0)

    // Past the original deadline: the cleared timer must not abort the grant.
    await sleep(SLOW_TICK_MS + 80)
    assert.equal(askedSignal.aborted, false)
    assert.equal(harness.runs, 1)
    assert.deepEqual(auditEvents(session).decided.map(entry => entry.outcome), ['allowed-once'])
  } finally {
    await harness.dispose()
  }
})
