/**
 * Approval-path behavior for the denial-feedback patch.
 *
 * Under the interactive `ask` approval mode (ask the human) the patched plugin
 * calls the public approval seam itself instead of returning an `ask` gate,
 * because the tool pipeline's private `serviceAsk()` would otherwise replace
 * the reviewer's concern with a fixed "the user rejected ..." text. These tests
 * lock the four approval outcomes, their structured error codes, the audited
 * ask/decide pair, no duplicate question, approval-mode handling, teardown
 * cancellation, and the invariants that reviewer grants bypass the question and
 * a downstream pre-execute denial keeps precedence.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin, targetName } from './target.mjs'
import { createHarness, reasoningChunks, textChunks } from './harness/harness.mjs'

const plugin = await loadPlugin()
const CONCERN = 'not authorized: the target sits outside the workspace'
const REVIEWER_DENIAL = JSON.stringify({ risk: 'medium', decision: 'deny', reason: CONCERN })
const HUMAN_REJECTED = 'the user rejected tool "probe"'
const HUMAN_REJECTED_WITH_CONCERN = `${HUMAN_REJECTED}; Auto review concern: ${CONCERN}`
const AUDITED_QUESTION = `Auto review denied tool "probe": ${CONCERN}`

/** Create one Auto-session harness; `answer` drives the approval answerer chain. */
function harnessFor(options) {
  const harness = createHarness({
    plugin,
    reviewScript: options.script,
    approvalPolicyOverride: options.override === undefined || options.override === null
      ? options.override
      : () => options.override,
    defaultApprovalPolicy: options.defaultPolicy ?? 'ask',
  })
  if (options.answer !== undefined) {
    harness.ctx.on('approval/request', () => Promise.resolve(options.answer))
  }
  return harness
}

async function reviewOneCall(harness) {
  const { session, agent } = harness.newSession('session-ask')
  harness.appendTurnStart(session)
  harness.appendNativeCall(session, { callId: 'call-1' })
  const result = await harness.executeTool({ agent, callId: 'call-1' })
  return { session, agent, result }
}

/** Poll microtasks until a condition holds (no wall-clock sleeps). */
async function until(predicate) {
  for (let attempt = 0; attempt < 1_000 && !predicate(); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  if (!predicate()) throw new Error('condition did not become true')
}

function auditEvents(session) {
  return {
    asked: session.snapshotEvents().filter(event => event.type === 'approval/asked').map(event => event.data),
    decided: session.snapshotEvents().filter(event => event.type === 'approval/decided').map(event => event.data),
  }
}

test(`ask policy: approval mapping allowed-once executes the body (${targetName})`, async () => {
  const harness = harnessFor({ script: [textChunks(REVIEWER_DENIAL)], answer: 'allowed-once' })
  try {
    const { result, session } = await reviewOneCall(harness)
    assert.equal(result.isError, false)
    assert.equal(harness.runs, 1)
    // Exactly one audited question, carrying the reviewer's concern.
    assert.equal(harness.approvalRequests.length, 1)
    assert.equal(harness.approvalRequests[0].reason, AUDITED_QUESTION)
    assert.equal(harness.approvalRequests[0].displayReason.en, `Auto review denied this call: ${CONCERN}`)
    assert.deepEqual(harness.approvalRequests[0].signal?.aborted, false)
    const audit = auditEvents(session)
    assert.deepEqual(audit.asked.map(entry => entry.reason), [AUDITED_QUESTION])
    assert.deepEqual(audit.decided.map(entry => entry.outcome), ['allowed-once'])
  } finally {
    await harness.dispose()
  }
})

test(`ask policy: approval mapping rejected returns the reviewer concern (${targetName})`, async () => {
  const harness = harnessFor({ script: [textChunks(REVIEWER_DENIAL)], answer: 'rejected' })
  try {
    const { result, session } = await reviewOneCall(harness)
    assert.equal(result.isError, true)
    assert.equal(result.error.message, HUMAN_REJECTED_WITH_CONCERN)
    assert.deepEqual(result.content, [{ type: 'text', text: `Error: ${HUMAN_REJECTED_WITH_CONCERN}` }])
    assert.deepEqual(result.error.info, {
      name: 'ApprovalError',
      code: 'APPROVAL_REJECTED',
      reason: CONCERN,
    })
    assert.equal(harness.runs, 0)
    // One question only: the pipeline does not repeat the approval round.
    assert.equal(harness.approvalRequests.length, 1)
    const audit = auditEvents(session)
    assert.equal(audit.asked.length, 1)
    assert.deepEqual(audit.decided.map(entry => entry.outcome), ['rejected'])
  } finally {
    await harness.dispose()
  }
})

test(`ask policy: rejected without a reviewer reason stays concise (${targetName})`, async () => {
  const harness = harnessFor({
    script: [textChunks('{"risk":"medium","decision":"deny"}')],
    answer: 'rejected',
  })
  try {
    const { result } = await reviewOneCall(harness)
    assert.equal(result.isError, true)
    assert.equal(result.error.message, HUMAN_REJECTED)
    assert.deepEqual(result.error.info, {
      name: 'ApprovalError',
      code: 'APPROVAL_REJECTED',
    })
    assert.equal(harness.runs, 0)
    assert.equal(harness.approvalRequests[0].reason, 'Auto review denied tool "probe"')
  } finally {
    await harness.dispose()
  }
})

test(`ask policy: approval mapping unavailable fails closed (${targetName})`, async () => {
  const harness = harnessFor({ script: [textChunks(REVIEWER_DENIAL)] })
  try {
    const { result, session } = await reviewOneCall(harness)
    assert.equal(result.isError, true)
    assert.equal(
      result.error.message,
      'tool "probe" requires approval, but no approval channel is available',
    )
    assert.deepEqual(result.error.info, {
      name: 'ApprovalError',
      code: 'APPROVAL_UNAVAILABLE',
    })
    assert.equal(harness.runs, 0)
    assert.deepEqual(auditEvents(session).decided.map(entry => entry.outcome), ['unavailable'])
  } finally {
    await harness.dispose()
  }
})

test(`ask policy: approval mapping cancelled aborts before dispatch (${targetName})`, async () => {
  const harness = harnessFor({ script: [textChunks(REVIEWER_DENIAL)] })
  // A human question that never answers; cancellation must withdraw it.
  harness.ctx.on('approval/request', () => new Promise(() => {}))
  try {
    const { session, agent } = harness.newSession('session-ask-cancel')
    harness.appendTurnStart(session)
    harness.appendNativeCall(session, { callId: 'call-1' })
    const controller = new AbortController()
    const pending = harness.executeTool({ agent, callId: 'call-1', signal: controller.signal })
    await until(() => harness.approvalRequests.length === 1)
    controller.abort()
    const result = await pending
    assert.equal(result.isError, true)
    assert.equal(result.error.message, 'tool call aborted before dispatch')
    assert.deepEqual(result.error.info, { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' })
    assert.equal(harness.runs, 0)
    assert.deepEqual(auditEvents(session).decided.map(entry => entry.outcome), ['cancelled'])
  } finally {
    await harness.dispose()
  }
})

test(`ask policy: reviewer reasoning never appears in a human rejection (${targetName})`, async () => {
  const secret = 'PRIVATE-CHAIN-OF-THOUGHT 8c31'
  const harness = harnessFor({
    script: [reasoningChunks(secret, REVIEWER_DENIAL)],
    answer: 'rejected',
  })
  try {
    const { result } = await reviewOneCall(harness)
    assert.equal(result.error.message, HUMAN_REJECTED_WITH_CONCERN)
    assert.equal(JSON.stringify(result).includes(secret), false)
    assert.equal(harness.runs, 0)
  } finally {
    await harness.dispose()
  }
})

test(`ask policy: a default-never policy is an automatic denial, not a user rejection (${targetName})`, async () => {
  const harness = harnessFor({
    script: [textChunks(REVIEWER_DENIAL)],
    defaultPolicy: 'never',
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
    // No human was asked and no "user rejected" wording was fabricated.
    assert.equal(result.error.message.includes('user rejected'), false)
    assert.equal(harness.approvalRequests.length, 0)
    assert.equal(harness.runs, 0)
    assert.deepEqual(auditEvents(session), { asked: [], decided: [] })
  } finally {
    await harness.dispose()
  }
})

test(`ask policy: reviewer allow executes without a human question (${targetName})`, async () => {
  const harness = harnessFor({
    script: [textChunks('{"risk":"low","decision":"allow"}')],
    answer: 'rejected',
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

test(`ask policy: a downstream denial keeps precedence over the human question (${targetName})`, async () => {
  const harness = harnessFor({ script: [textChunks(REVIEWER_DENIAL)], answer: 'allowed-once' })
  harness.ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'deny', reason: 'downstream guard' }))
  try {
    const { result } = await reviewOneCall(harness)
    assert.equal(result.isError, true)
    assert.equal(result.error.message, 'downstream guard')
    assert.equal(harness.runs, 0)
    assert.equal(harness.approvalRequests.length, 0)
  } finally {
    await harness.dispose()
  }
})

test(`ask policy: integration teardown withdraws a pending human question (${targetName})`, async () => {
  const harness = harnessFor({ script: [textChunks(REVIEWER_DENIAL)] })
  harness.ctx.on('approval/request', () => new Promise(() => {}))
  const { session, agent } = harness.newSession('session-ask-teardown')
  harness.appendTurnStart(session)
  harness.appendNativeCall(session, { callId: 'call-1' })
  const pending = harness.executeTool({ agent, callId: 'call-1' })
  await until(() => harness.approvalRequests.length === 1)

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
  assert.deepEqual(auditEvents(session).decided.map(entry => entry.outcome), ['cancelled'])
})

test(`ask policy: an explicit ask override wins over a default-never policy (${targetName})`, async () => {
  const harness = harnessFor({
    script: [textChunks(REVIEWER_DENIAL)],
    override: 'ask',
    defaultPolicy: 'never',
    answer: 'rejected',
  })
  try {
    const { result } = await reviewOneCall(harness)
    assert.equal(result.isError, true)
    assert.equal(result.error.message, HUMAN_REJECTED_WITH_CONCERN)
    assert.equal(harness.approvalRequests.length, 1)
    assert.equal(harness.runs, 0)
  } finally {
    await harness.dispose()
  }
})
