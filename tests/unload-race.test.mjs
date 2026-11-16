/**
 * Grant-versus-unload race acceptance tests (final-review blocker).
 *
 * A human approval can produce `allowed-once` while the approval service's
 * synchronous `approval/decided` observer unloads the integration (or the
 * caller aborts). The grant must then be discarded: the mapped cancel wins, the
 * tool body never executes, and the already-committed approval audit pair stays
 * exactly once. The same re-check covers the timeout-less direct approval path
 * as well as the #5 deadline path.
 *
 * These tests run the real production source (or the built `lib/` artifact)
 * against the standalone harness, whose fake Session now mirrors the real
 * Session's synchronous append observers.
 *
 * Run with: npm test            (source, Node native TypeScript stripping)
 *           npm run test:lib    (built lib/ artifact)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin, targetName } from './target.mjs'
import { createHarness, textChunks } from './harness/harness.mjs'

const plugin = await loadPlugin()

const CONCERN = 'the call would export a production credential store'
const REVIEWER_DENIAL = JSON.stringify({ risk: 'medium', decision: 'deny', reason: CONCERN })
const ABORTED_INFO = { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' }

/** Create one Auto-session harness with a human allow and optional #5 config. */
function harnessFor(options = {}) {
  const harness = createHarness({
    plugin,
    reviewScript: [textChunks(REVIEWER_DENIAL)],
    ...options.config === undefined ? {} : { config: options.config },
  })
  harness.ctx.on('approval/request', () => Promise.resolve('allowed-once'))
  return harness
}

/** Append the pending native call for one Auto session. */
function prepareCall(harness, sessionId = 'session-race') {
  const { session, agent } = harness.newSession(sessionId)
  harness.appendTurnStart(session)
  harness.appendNativeCall(session, { callId: 'call-1' })
  return { session, agent }
}

/** Collect the audited approval question/decision pair. */
function auditEvents(session) {
  return {
    asked: session.snapshotEvents().filter(event => event.type === 'approval/asked').map(event => event.data),
    decided: session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data),
  }
}

/**
 * Run one call and invoke `onGrant` synchronously inside the `approval/decided`
 * append that commits an `allowed-once` grant. The callback may start a disposal
 * or abort a caller signal exactly where the reviewer race appears: after the
 * decision is durable, before the plugin maps the outcome.
 */
async function executeWithGrantHook(harness, { signal, onGrant }) {
  const { session, agent } = prepareCall(harness)
  const unsubscribe = session.observeAppends((event) => {
    if (event.type !== 'approval/decided' || event.data.outcome !== 'allowed-once') return
    onGrant(event)
  })
  try {
    const result = await harness.executeTool({
      agent,
      callId: 'call-1',
      ...signal === undefined ? {} : { signal },
    })
    return { session, result }
  } finally {
    unsubscribe()
  }
}

test(`unload race: disposal on the allowed-once grant discards it, direct path (${targetName})`, { timeout: 5_000 }, async () => {
  const harness = harnessFor()
  let disposal
  try {
    const { session, result } = await executeWithGrantHook(harness, {
      onGrant: () => { disposal = harness.dispose() },
    })
    await disposal
    assert.equal(result.isError, true)
    assert.equal(result.error.message, 'tool call aborted before dispatch')
    assert.deepEqual(result.error.info, ABORTED_INFO)
    assert.equal(harness.runs, 0, 'an unloaded integration must never dispatch a granted body')
    // The audit pair committed before the unload is kept exactly once.
    assert.equal(harness.approvalRequests.length, 1)
    const audit = auditEvents(session)
    assert.equal(audit.asked.length, 1)
    assert.deepEqual(audit.decided.map(entry => entry.outcome), ['allowed-once'])
  } finally {
    if (disposal === undefined) await harness.dispose()
  }
})

test(`unload race: disposal on the allowed-once grant discards it while a deadline is configured (${targetName})`, { timeout: 5_000 }, async () => {
  const harness = harnessFor({ config: { approvalTimeoutMinutes: 0.05 } })
  let disposal
  try {
    const { session, result } = await executeWithGrantHook(harness, {
      onGrant: () => { disposal = harness.dispose() },
    })
    await disposal
    assert.equal(result.isError, true)
    assert.deepEqual(result.error.info, ABORTED_INFO)
    assert.equal(harness.runs, 0)
    // Cancellation by unload wins over the pending deadline: no timeout denial.
    assert.equal(result.error.info.code === 'AUTO_REVIEW_APPROVAL_TIMEOUT', false)
    assert.equal(harness.approvalRequests.length, 1)
    const audit = auditEvents(session)
    assert.equal(audit.asked.length, 1)
    assert.deepEqual(audit.decided.map(entry => entry.outcome), ['allowed-once'])
  } finally {
    if (disposal === undefined) await harness.dispose()
  }
})

test(`unload race: a caller abort on the allowed-once grant still cancels, not allows (${targetName})`, { timeout: 5_000 }, async () => {
  const harness = harnessFor({ config: { approvalTimeoutMinutes: 0.05 } })
  const controller = new AbortController()
  try {
    const { session, result } = await executeWithGrantHook(harness, {
      signal: controller.signal,
      onGrant: () => { controller.abort() },
    })
    assert.equal(result.isError, true)
    assert.deepEqual(result.error.info, ABORTED_INFO)
    assert.equal(harness.runs, 0)
    assert.equal(harness.approvalRequests.length, 1)
    const audit = auditEvents(session)
    assert.equal(audit.asked.length, 1)
    assert.deepEqual(audit.decided.map(entry => entry.outcome), ['allowed-once'])
  } finally {
    await harness.dispose()
  }
})

test(`unload race: a reviewer reason cannot turn a discarded grant into an execution (${targetName})`, { timeout: 5_000 }, async () => {
  // The concern only affects denial text; it must be irrelevant to the race.
  const harness = harnessFor()
  let disposal
  try {
    const { result } = await executeWithGrantHook(harness, {
      onGrant: () => { disposal = harness.dispose() },
    })
    await disposal
    assert.equal(harness.runs, 0)
    assert.equal(JSON.stringify(result).includes('never executed'), false)
    assert.deepEqual(result.error.info, ABORTED_INFO)
  } finally {
    if (disposal === undefined) await harness.dispose()
  }
})
