/**
 * Denial-feedback acceptance tests for the patched Auto review plugin.
 *
 * These run the real production source (or the built `lib/` artifact) against
 * the standalone harness. They cover the Issue #3 first-version scope:
 * reviewer reasons on automatic denials, unchanged technical failures, absence
 * of reviewer chain-of-thought, and the "denied body never executes" invariant.
 *
 * Run with: npm test            (source, Node native TypeScript stripping)
 *           npm run test:lib    (built lib/ artifact)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadPlugin, targetName } from './target.mjs'
import { createHarness, reasoningChunks, textChunks } from './harness/harness.mjs'

const plugin = await loadPlugin()

/** Create one harness with a fixed reviewer script and approval policy. */
function harnessFor(options) {
  return createHarness({
    plugin,
    reviewScript: options.script ?? [],
    preset: options.preset ?? 'auto',
    approvalPolicyOverride: options.policy === undefined
      ? undefined
      : typeof options.policy === 'function' ? options.policy : () => options.policy,
  })
}

/** Append a valid native-call history and execute the pending call once. */
async function reviewOneCall(harness, input = {}) {
  const { session, agent } = harness.newSession(input.sessionId ?? 'session-1')
  harness.appendTurnStart(session)
  harness.appendNativeCall(session, {
    callId: input.callId ?? 'call-1',
    name: input.name ?? 'probe',
    args: input.args ?? {},
  })
  const result = await harness.executeTool({
    agent,
    callId: input.callId ?? 'call-1',
    name: input.name ?? 'probe',
    args: input.args ?? {},
    ...input.signal === undefined ? {} : { signal: input.signal },
  })
  return { session, agent, result }
}

const DENIED_PREFIX = 'Auto review rejected tool "probe"; its body was not executed'

test(`never policy: reviewer reason reaches the Agent tool result (${targetName})`, async () => {
  const reason = 'the target is a production credential store outside the workspace'
  const harness = harnessFor({
    script: [textChunks(JSON.stringify({ risk: 'high', decision: 'deny', reason }))],
    policy: 'never',
  })
  try {
    const { result, session } = await reviewOneCall(harness)
    assert.equal(result.isError, true)
    assert.equal(result.error.message, `${DENIED_PREFIX}: ${reason}`)
    assert.deepEqual(result.content, [{ type: 'text', text: `Error: ${DENIED_PREFIX}: ${reason}` }])
    assert.deepEqual(result.error.info, {
      name: 'AutoReviewDeniedError',
      code: 'AUTO_REVIEW_DENIED',
      reason,
    })
    // The denied body never runs, and the automatic path asks no human.
    assert.equal(harness.runs, 0)
    assert.equal(harness.approvalRequests.length, 0)
    assert.equal(session.snapshotEvents().filter(event => event.type === 'approval/asked').length, 0)
    // Only the fixed reviewer protocol was sent; the decision reached the Agent.
    assert.equal(harness.reviewRequests.length, 1)
    assert.equal(harness.reviewRequests[0].purpose, 'auto-review')
    // The reviewer's risk class is internal and must not leak into the result.
    assert.equal(JSON.stringify(result).includes('"risk"'), false)
  } finally {
    await harness.dispose()
  }
})

test(`never policy: absent reason keeps the existing concise denial (${targetName})`, async () => {
  const harness = harnessFor({
    script: [textChunks('{"risk":"high","decision":"deny"}')],
    policy: 'never',
  })
  try {
    const { result } = await reviewOneCall(harness)
    assert.equal(result.isError, true)
    assert.equal(result.error.message, DENIED_PREFIX)
    assert.deepEqual(result.content, [{ type: 'text', text: `Error: ${DENIED_PREFIX}` }])
    assert.deepEqual(result.error.info, {
      name: 'AutoReviewDeniedError',
      code: 'AUTO_REVIEW_DENIED',
    })
    assert.equal(harness.runs, 0)
    assert.equal(harness.approvalRequests.length, 0)
  } finally {
    await harness.dispose()
  }
})

test(`never policy: medium-risk denial with reason keeps decision and feedback (${targetName})`, async () => {
  const reason = 'force push would rewrite shared history'
  const harness = harnessFor({
    script: [textChunks(JSON.stringify({ risk: 'medium', decision: 'deny', reason }))],
    policy: 'never',
  })
  try {
    const { result } = await reviewOneCall(harness)
    assert.equal(result.isError, true)
    assert.equal(result.error.message, `${DENIED_PREFIX}: ${reason}`)
    assert.equal(result.error.info.code, 'AUTO_REVIEW_DENIED')
    assert.equal(harness.runs, 0)
  } finally {
    await harness.dispose()
  }
})

test(`never policy: reviewer chain-of-thought is never exposed (${targetName})`, async () => {
  const secret = 'PRIVATE-CHAIN-OF-THOUGHT 4f9c'
  const reason = 'the call would publish private workspace data'
  const harness = harnessFor({
    script: [reasoningChunks(secret, JSON.stringify({ risk: 'high', decision: 'deny', reason }))],
    policy: 'never',
  })
  try {
    const { result } = await reviewOneCall(harness)
    assert.equal(result.isError, true)
    assert.equal(result.error.message, `${DENIED_PREFIX}: ${reason}`)
    const exposed = JSON.stringify(result)
    assert.equal(exposed.includes(secret), false)
    assert.equal(exposed.includes('PRIVATE-CHAIN-OF-THOUGHT'), false)
    assert.equal(harness.runs, 0)
  } finally {
    await harness.dispose()
  }
})

test(`technical reviewer failure keeps the original failed() feedback (${targetName})`, async () => {
  const harness = harnessFor({
    script: [async function* providerFailure() { throw new Error('provider secret') }],
    policy: 'never',
  })
  try {
    const { result } = await reviewOneCall(harness)
    assert.equal(result.isError, true)
    // Mirrors the upstream failure envelope: "Auto review of tool ... failed;
    // its body was not executed: <review error>". The provider's own error is
    // preserved verbatim, exactly as before this patch.
    assert.equal(
      result.error.message,
      'Auto review of tool "probe" failed; its body was not executed: '
      + 'auto-review: reviewer ended with error UNKNOWN: provider secret',
    )
    assert.deepEqual(result.error.info, {
      name: 'AutoReviewFailedError',
      code: 'AUTO_REVIEW_FAILED',
    })
    assert.equal(harness.runs, 0)
    assert.equal(harness.approvalRequests.length, 0)
  } finally {
    await harness.dispose()
  }
})

test(`technical reviewer failure preserves a non-Error thrown value (${targetName})`, async () => {
  const harness = createHarness({
    plugin,
    reviewScript: [],
    approvalPolicyOverride: () => 'never',
    llmStreamMiddleware: () => { throw 'middleware refused' },
  })
  try {
    const { result } = await reviewOneCall(harness)
    assert.equal(result.isError, true)
    assert.equal(
      result.error.message,
      'Auto review of tool "probe" failed; its body was not executed: middleware refused',
    )
    assert.equal(result.error.info.code, 'AUTO_REVIEW_FAILED')
    assert.equal(harness.runs, 0)
  } finally {
    await harness.dispose()
  }
})

test(`allow decisions execute the body and never ask for approval (${targetName})`, async () => {
  const harness = harnessFor({
    script: [textChunks('{"risk":"low","decision":"allow"}')],
    policy: 'never',
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

test(`sessions outside the Auto preset are not reviewed (${targetName})`, async () => {
  const harness = harnessFor({ script: [], preset: 'workspace-write', policy: 'never' })
  try {
    const { result } = await reviewOneCall(harness)
    assert.equal(result.isError, false)
    assert.equal(harness.runs, 1)
    assert.equal(harness.reviewRequests.length, 0)
    assert.equal(harness.approvalRequests.length, 0)
  } finally {
    await harness.dispose()
  }
})

test(`whitespace-only reviewer reason keeps the concise denial (${targetName})`, async () => {
  const harness = harnessFor({
    script: [textChunks(JSON.stringify({ risk: 'high', decision: 'deny', reason: '   ' }))],
    policy: 'never',
  })
  try {
    const { result } = await reviewOneCall(harness)
    assert.equal(result.error.message, DENIED_PREFIX)
    // The user-facing detail still preserves the raw reviewer string.
    assert.equal(result.error.info.reason, '   ')
    assert.equal(harness.runs, 0)
  } finally {
    await harness.dispose()
  }
})

test(`never policy: the reviewer reason is reproduced verbatim (${targetName})`, async () => {
  // Mirrors the upstream PTC test's raw reason: surrounding whitespace and a
  // newline are part of the reviewer's explanation and must not be rewritten.
  const reason = '  exact "scope" was not authorized\nretry with a narrower target  '
  const harness = harnessFor({
    script: [textChunks(JSON.stringify({ risk: 'medium', decision: 'deny', reason }))],
    policy: 'never',
  })
  try {
    const { result } = await reviewOneCall(harness)
    assert.equal(result.error.message, `${DENIED_PREFIX}: ${reason}`)
    assert.equal(result.content[0].text, `Error: ${DENIED_PREFIX}: ${reason}`)
    assert.equal(result.error.info.reason, reason)
    assert.equal(harness.runs, 0)
  } finally {
    await harness.dispose()
  }
})
