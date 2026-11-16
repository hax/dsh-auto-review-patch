/**
 * Deterministic, dependency-free integration harness for the patched Auto
 * review plugin.
 *
 * The standalone fork cannot install the upstream DSH pnpm workspace, so this
 * file supplies (a) a minimal Cordis-like context whose `effect`, `on` and
 * service objects are shaped exactly as the plugin consumes them, (b) a fake
 * Session whose `snapshotEvents()` / `surface.nodes` / `requestHeader()` /
 * `header` feed the real `snapshotAutoReview()` code path, and (c) a compact
 * mirror of `ToolsPipeline.prepare()` + `ApprovalService.request()` so the
 * decisions the plugin returns are materialized the way the real pipeline does.
 *
 * The mirrored segments are trimmed from upstream tag `dsh-v0.2.2-rc.3`
 * (commit 38a6a5c965aa99ab525161efb7cc5cf1fe62fced):
 *   - packages/core/tools/src/pipeline.ts  lines ~198-232 (`prepare`)
 *   - packages/core/tools/src/pipeline.ts  lines ~440-481 (`serviceAsk`)
 *   - packages/core/tools/src/pipeline.ts  lines ~767-792 (aborted results)
 *   - packages/interaction/user-approval/src/index.ts (`request` policy,
 *     audit pair, answerer waterfall, signal race)
 * Only the branches the tests exercise are modeled; the real pipeline remains
 * authoritative for integration behavior.
 */
import { FiberState } from '@deepseek-ai/cordis'

const APPROVAL_ERROR_NAME = 'ApprovalError'
const APPROVAL_REJECTED = 'APPROVAL_REJECTED'
const APPROVAL_CANCELLED = 'APPROVAL_CANCELLED'
const APPROVAL_UNAVAILABLE = 'APPROVAL_UNAVAILABLE'

const APPROVAL_OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

/** Canonical result when cancellation prevents tool body invocation. */
function abortedBeforeDispatch() {
  return {
    content: [{ type: 'text', text: 'Error: tool call aborted before dispatch' }],
    isError: true,
    error: {
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: 'ABORTED_BEFORE_DISPATCH' },
    },
  }
}

/** Structured approval denial, mirroring pipeline.ts `approvalDenial()`. */
function approvalDenial(reason, code) {
  return { kind: 'deny', reason, info: { name: APPROVAL_ERROR_NAME, code } }
}

/** Structured tool failure, mirroring pipeline.ts `toolErrorResult()`. */
function toolErrorResult(error) {
  const message = error instanceof Error ? error.message : String(error)
  const code = error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined
  const name = error !== null && typeof error === 'object' && typeof error.name === 'string' ? error.name : 'Error'
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
    error: { message, ...code === undefined ? {} : { info: { name, code } } },
  }
}

/**
 * Create one fake Session matching the members `snapshotAutoReview()` reads.
 * @param id - session id.
 */
function createFakeSession(id) {
  const events = []
  const surfaceNodes = []
  const appendObservers = []
  let requestHeader
  let turnOpen = false
  const session = {
    id,
    header: { origin: 'root' },
    surface: {
      get nodes() { return surfaceNodes },
    },
    snapshotEvents() { return events },
    requestHeader() { return requestHeader },
    isOwnSeq() { return true },
    /**
     * Test-only: observe each committed event synchronously, like the real
     * Session's `session/event` observers after the log push. Lets a test run
     * code (for example integration disposal) inside the `approval/decided`
     * append that produces an `allowed-once` grant.
     */
    observeAppends(observer) {
      appendObservers.push(observer)
      return () => {
        const index = appendObservers.indexOf(observer)
        if (index >= 0) appendObservers.splice(index, 1)
      }
    },
    /** Append one event; only `surface: true` events enter the model surface. */
    append(type, data, options = {}) {
      const event = { type, seq: events.length, data }
      events.push(event)
      if (options.surface === true) surfaceNodes.push(event.seq)
      if (type === 'turn/start') turnOpen = true
      if (type === 'turn/end') turnOpen = false
      // Mirror Session.append: observers run synchronously after the log push.
      for (const observer of [...appendObservers]) observer(event)
      return event
    },
    /** Test-only: set the request header snapshot returned by `requestHeader()`. */
    setRequestHeader(header) { requestHeader = header },
    /** Test-only: whether an approval audit pair is turn-enclosed. */
    isTurnOpen() { return turnOpen },
  }
  return session
}

/** Build the raw argument text exactly as the agent loop logs it. */
function rawArguments(args) {
  return JSON.stringify(args)
}

/**
 * Review scripts may be a chunk array, a chunk-array factory, or an async
 * generator. Adapter throws are normalized into terminal error finishes like
 * `LlmRuntime.stream()` does upstream; `llmStreamMiddleware` throws stay thrown.
 */
function adapterIterable(script, options) {
  return (async function* () {
    try {
      if (typeof script === 'function') yield* script(options)
      else yield* script
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = error !== null && typeof error === 'object' && typeof error.code === 'string'
        ? error.code
        : 'UNKNOWN'
      yield options.signal?.aborted === true
        ? { type: 'finish', reason: { kind: 'aborted', failure: { code, message } } }
        : { type: 'finish', reason: { kind: 'error', failure: { code, message } } }
    }
  })()
}

const DEFAULT_SCHEMA = Object.freeze({
  name: 'probe',
  description: 'live probe description',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
})

/**
 * Create a harness bound to the loaded plugin module.
 * @param options - plugin module plus controllable services.
 */
export function createHarness(options) {
  const {
    plugin,
    reviewScript = [],
    preset = 'auto',
    defaultApprovalPolicy = 'ask',
    approvalPolicyOverride,
    config,
    cwd = '/workspace',
    rootFiberState = FiberState.ACTIVE,
  } = options

  const sessions = new Set()
  const listeners = new Map()
  const script = [...reviewScript]
  const reviewRequests = []
  const approvalRequests = []
  const presetSetCalls = []
  const autoAdmits = []
  const harness = {
    runs: 0,
    reviewRequests,
    approvalRequests,
    presetSetCalls,
    autoAdmits,
    cwd,
  }

  function on(event, listener, listenerOptions = {}) {
    const list = listeners.get(event) ?? []
    if (listenerOptions.prepend === true) list.unshift(listener)
    else list.push(listener)
    listeners.set(event, list)
    return () => {
      const current = listeners.get(event) ?? []
      const index = current.indexOf(listener)
      if (index >= 0) current.splice(index, 1)
    }
  }

  /** Cordis waterfall: each listener receives the payload and `next`. */
  async function waterfall(event, payload, fallback) {
    const list = [...(listeners.get(event) ?? [])]
    const run = (index) => {
      const listener = list[index]
      if (listener === undefined) return Promise.resolve(fallback === undefined ? undefined : fallback())
      return Promise.resolve(listener(payload, () => run(index + 1)))
    }
    return run(0)
  }

  /** Minimal Cordis `ctx.effect` driver: collect generator-yielded disposers, run LIFO. */
  function effect(factory, _label) {
    const disposers = []
    const iterator = factory()
    for (;;) {
      const step = iterator.next()
      if (step.done === true) break
      if (typeof step.value === 'function') disposers.push(step.value)
      else if (step.value !== undefined) disposers.push(() => Promise.resolve(step.value))
    }
    return async () => {
      for (const dispose of disposers.reverse()) await dispose()
    }
  }

  const permissionPresets = {
    current(session) {
      void session
      return typeof preset === 'function' ? preset(session) : preset
    },
    registerAuto(admit) {
      autoAdmits.push(admit)
      return async () => {
        const index = autoAdmits.indexOf(admit)
        if (index >= 0) autoAdmits.splice(index, 1)
      }
    },
    set(session, name) {
      presetSetCalls.push({ session, name })
    },
  }

  /** ApprovalService.request() mirror: policy gate, audit pair, answerer waterfall. */
  const approval = {
    config: { policy: defaultApprovalPolicy },
    overrideOf(session) {
      void session
      return typeof approvalPolicyOverride === 'function'
        ? approvalPolicyOverride(session)
        : approvalPolicyOverride
    },
    async request(req) {
      approvalRequests.push(req)
      const session = req.agent.session
      if (!session.isTurnOpen()) {
        throw new Error(
          'approval.request() outside an open turn: the approval/asked + approval/decided audit pair '
          + 'must be turn-enclosed (a bare event between turns is crash-tail garbage on reload). '
          + 'Ask from inside the turn that needs the decision.',
        )
      }
      const id = `approval-request-${String(approvalRequests.length)}`
      session.append('approval/asked', {
        id,
        toolName: req.toolName,
        ...req.callId === undefined ? {} : { callId: req.callId },
        ...req.reason === undefined ? {} : { reason: req.reason },
      })
      const policy = this.overrideOf(session) ?? this.config.policy ?? 'ask'
      let outcome
      if (req.signal?.aborted === true) outcome = 'cancelled'
      else if (policy === 'never') outcome = 'rejected'
      else {
        const answer = Promise.resolve()
          .then(() => waterfall('approval/request', req, () => 'unavailable'))
          .then(
            result => APPROVAL_OUTCOMES.includes(result) ? result : 'unavailable',
            () => 'unavailable',
          )
        outcome = req.signal === undefined ? await answer : await raceAbort(answer, req.signal)
      }
      session.append('approval/decided', { id, outcome })
      return outcome
    },
  }

  const llm = {
    stream(streamOptions) {
      reviewRequests.push(streamOptions)
      if (options.llmStreamMiddleware !== undefined) options.llmStreamMiddleware(streamOptions)
      const next = script.shift()
      if (next === undefined) throw new Error('review adapter script exhausted')
      return adapterIterable(next, streamOptions)
    },
  }

  const workingDirectory = {
    async ensure() { return cwd },
  }

  const ctx = {
    effect,
    on,
    waterfall,
    sessions: { list: () => [...sessions] },
    approval,
    llm,
    permissionPresets,
    workingDirectory,
    root: { fiber: { state: rootFiberState } },
  }

  /** serviceAsk() mirror from pipeline.ts (approval seam is always composed here). */
  async function serviceAsk(exec, ask) {
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: exec.name,
      callId: exec.callId,
      ...ask.reason === undefined ? {} : { reason: ask.reason },
      ...ask.displayReason === undefined ? {} : { displayReason: ask.displayReason },
      signal: exec.signal,
    })
    switch (outcome) {
      case 'allowed-once': return { decision: { kind: 'allow' }, approvalCancelled: false }
      case 'rejected':
        return { decision: approvalDenial(`the user rejected tool "${exec.name}"`, APPROVAL_REJECTED), approvalCancelled: false }
      case 'cancelled':
        return { decision: approvalDenial(`approval for tool "${exec.name}" was cancelled`, APPROVAL_CANCELLED), approvalCancelled: true }
      case 'unavailable':
        return { decision: approvalDenial(`tool "${exec.name}" requires approval, but no approval channel is available`, APPROVAL_UNAVAILABLE), approvalCancelled: false }
      default:
        throw new Error(`unexpected approval outcome ${String(outcome)}`)
    }
  }

  function newSession(id) {
    const session = createFakeSession(id)
    sessions.add(session)
    return { session, agent: { id, session } }
  }

  function appendTurnStart(session, turn = 1) {
    session.append('turn/start', { turn })
  }

  /**
   * Append a complete, minimal native-call history that satisfies the real
   * `snapshotAutoReview()` validation for `name`/`args`.
   */
  function appendNativeCall(session, input = {}) {
    const {
      callId = 'call-1',
      name = 'probe',
      args = {},
      schema = { ...DEFAULT_SCHEMA, name },
      turn = 1,
      step = 1,
    } = input
    session.setRequestHeader({
      config: { provider: 'review', model: 'same-model' },
      tools: [schema],
    })
    session.append('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Run the probe.' }],
    }, { surface: true })
    session.append('step/start', { turn, step })
    session.append('assistant/message', {
      turn,
      step,
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name, arguments: rawArguments(args) }],
      },
    }, { surface: true })
    session.append('tool/call', { turn, step, callId, name, arguments: rawArguments(args) })
    return { callId, name, args }
  }

  /** Mirror ToolsPipeline.prepare() through dispatch/denial materialization. */
  async function executeTool(input) {
    const {
      name = 'probe',
      args = {},
      callId = 'call-1',
      agent,
      signal = new AbortController().signal,
    } = input
    const exec = { name, callId, rootCallId: callId, arguments: args, agent, signal }
    try {
      if (signal.aborted) return abortedBeforeDispatch()
      const gate = await waterfall('tools/pre-execute', exec, () => ({ kind: 'allow' }))
      const askResolution = gate.kind === 'ask'
        ? await serviceAsk(exec, gate)
        : { decision: gate, approvalCancelled: false }
      const { decision } = askResolution
      if (signal.aborted && askResolution.approvalCancelled) return abortedBeforeDispatch()
      if (decision.kind === 'cancel') return abortedBeforeDispatch()
      if (decision.kind === 'deny') {
        return {
          content: [{ type: 'text', text: `Error: ${decision.reason}` }],
          isError: true,
          error: { message: decision.reason, ...decision.info === undefined ? {} : { info: decision.info } },
        }
      }
      if (signal.aborted) return abortedBeforeDispatch()
      harness.runs += 1
      return { content: [{ type: 'text', text: 'ran' }], isError: false }
    } catch (error) {
      return toolErrorResult(error)
    }
  }

  let disposeEffect
  ctx.effect = (factory, label) => {
    disposeEffect = effect(factory, label)
    return disposeEffect
  }

  // A Loader always passes the parsed config (volatile refs with schema
  // defaults); tests may omit it entirely to exercise the plugin's own
  // no-config default path.
  if (config === undefined) plugin.apply(ctx)
  else plugin.apply(ctx, config)

  harness.ctx = ctx
  harness.newSession = newSession
  harness.appendTurnStart = appendTurnStart
  harness.appendNativeCall = appendNativeCall
  harness.executeTool = executeTool
  harness.dispose = async () => {
    if (disposeEffect !== undefined) await disposeEffect()
  }
  harness.reviewRequest = () => reviewRequests.at(-1)
  harness.readSession = (session) => session.snapshotEvents()
  return harness
}

/** Race one approval answer against the request signal, matching ApprovalService. */
function raceAbort(answer, signal) {
  if (signal.aborted) return Promise.resolve('cancelled')
  return new Promise((resolve) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      resolve('cancelled')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void answer.then((outcome) => {
      signal.removeEventListener('abort', onAbort)
      resolve(outcome)
    })
  })
}

/** Decision chunk helpers matching the reviewer stream protocol. */
export function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Review chunks with a leading reasoning block that must never reach the Agent. */
export function reasoningChunks(reasoningText, decisionText) {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: reasoningText },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoningText } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: decisionText },
    { type: 'block-end', index: 1, block: { type: 'text', text: decisionText } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Loaded target metadata, used by tests to assert which artifact they ran. */
export function describeTarget() {
  return process.env.AUTO_REVIEW_TEST_TARGET ?? 'src'
}
