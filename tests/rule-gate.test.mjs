/**
 * Phase 1 deterministic rule-gate acceptance tests.
 *
 * These run the real production source (or the built `lib/` artifact) against
 * the standalone harness. They cover the closed allow set (read/grep/glob plus
 * metadata tools), the conservative bash deny hard floor (D1/D2/D3/D5), the
 * three modes (`off` / `shadow` / `enforce`), fail-closed escalation for every
 * unproven case, the private JSONL decision record, and the guarantee that the
 * default `off` mode still calls the reviewer exactly as before.
 *
 * Every test uses a throwaway temp workspace and a throwaway record path; no
 * test reads or writes `~/.dsh`.
 *
 * Run with: npm test            (source, Node native TypeScript stripping)
 *           npm run test:lib    (built lib/ artifact)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { loadPlugin, targetName } from './target.mjs'
import { createHarness, textChunks } from './harness/harness.mjs'

const plugin = await loadPlugin()

const REVIEWER_ALLOW = textChunks('{"risk":"low","decision":"allow"}')
const REVIEWER_MEDIUM_ALLOW = textChunks('{"risk":"medium","decision":"allow"}')
const REVIEWER_DENY = textChunks(JSON.stringify({ risk: 'high', decision: 'deny', reason: 'test denial' }))
const RULE_DENIED_INFO = { name: 'AutoReviewRuleDeniedError', code: 'AUTO_REVIEW_RULE_DENIED' }

const A01 = 'A01_READONLY_READ'
const A02 = 'A02_READONLY_SEARCH'
const A04 = 'A04_META_READ'
const D1 = 'D1_RECURSIVE_FORCE_DELETE'
const D2 = 'D2_DEVICE_DESTRUCTION_OR_FORK_BOMB'
const D3 = 'D3_SYSTEM_DIRECTORY_WRITE'
const D5 = 'D5_GIT_HISTORY_REWRITE'
const E = 'E_ESCALATE'

/**
 * Create one throwaway workspace, one outside directory and one record path.
 * @param t - node:test context used for cleanup.
 */
function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'auto-review-rule-gate-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  const logs = join(root, 'logs')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(outside, { recursive: true })
  mkdirSync(join(workspace, 'sub'), { recursive: true })
  mkdirSync(join(workspace, 'build'), { recursive: true })
  const files = {
    notes: join(workspace, 'notes.txt'),
    outsideSecret: join(outside, 'secret.txt'),
    env: join(workspace, '.env'),
    envLocal: join(workspace, '.env.local'),
    sshKey: join(workspace, '.ssh', 'id_rsa'),
    sshEd25519: join(workspace, 'id_ed25519'),
    rsaPublic: join(workspace, 'id_rsa.pub'),
    pem: join(workspace, 'server.pem'),
    key: join(workspace, 'server.key'),
    credentials: join(workspace, 'credentials.json'),
    aws: join(workspace, '.aws', 'credentials'),
    npmrc: join(workspace, '.npmrc'),
    gitCredentials: join(workspace, '.git-credentials'),
    netrc: join(workspace, '.netrc'),
    gitConfig: join(workspace, '.git', 'config'),
    dshrc: join(workspace, '.dshrc'),
    agentTeams: join(workspace, '.agent-teams', 'x'),
    cordisPatch: join(workspace, 'cordis.patch.yml'),
    settings: join(workspace, 'settings.yaml'),
    credentialsYaml: join(workspace, '.credentials.yaml'),
  }
  writeFileSync(files.notes, 'workspace notes content\n')
  writeFileSync(files.outsideSecret, 'outside secret content\n')
  writeFileSync(files.env, 'TOKEN=workspace-secret\n')
  for (const file of [
    files.envLocal,
    files.sshKey,
    files.sshEd25519,
    files.rsaPublic,
    files.pem,
    files.key,
    files.credentials,
    files.aws,
    files.npmrc,
    files.gitCredentials,
    files.netrc,
    files.gitConfig,
    files.dshrc,
    files.agentTeams,
    files.cordisPatch,
    files.settings,
    files.credentialsYaml,
  ]) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, 'sensitive config\n')
  }
  let symlink = true
  try {
    symlinkSync(outside, join(workspace, 'link-out'), 'dir')
  } catch {
    symlink = false
  }
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, workspace, outside, log: join(logs, 'decisions.jsonl'), files, symlink }
}

/** Build a harness bound to the fixture workspace with an optional Loader config. */
function harnessFor(fixture, options = {}) {
  return createHarness({
    plugin,
    cwd: fixture.workspace,
    reviewScript: options.script ?? [],
    preset: options.preset ?? 'auto',
    defaultApprovalPolicy: options.defaultApprovalPolicy ?? 'ask',
    ...options.config === undefined ? {} : { config: options.config },
  })
}

/** Loader config for one rule-gate mode, always with an explicit temp log path. */
function gateConfig(fixture, mode, extra = {}) {
  return { ruleGate: mode, ruleGateLog: fixture.log, ...extra }
}

/** Read every JSONL decision record; a missing file means no records. */
function readRecords(logPath) {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line))
}

/**
 * Append one valid native-call history and execute the pending call once.
 * @returns the harness outcome plus the reviewer-call and body-run deltas.
 */
async function gated(harness, fixture, input) {
  const callId = input.callId ?? 'call-1'
  const name = input.name
  const args = input.args
  const { session, agent } = harness.newSession(input.sessionId ?? `session-${callId}`)
  harness.appendTurnStart(session)
  harness.appendNativeCall(session, { callId, name, args })
  const reviewerBefore = harness.reviewRequests.length
  const runsBefore = harness.runs
  const result = await harness.executeTool({ agent, callId, name, args })
  return {
    session,
    agent,
    result,
    reviewerCalls: harness.reviewRequests.length - reviewerBefore,
    ran: harness.runs - runsBefore,
    record: readRecords(fixture.log).at(-1),
  }
}

/** Run one case expected to escalate: reviewer called, downstream reviewer result returned. */
async function expectEscalate(harness, fixture, input) {
  const outcome = await gated(harness, fixture, input)
  assert.equal(outcome.reviewerCalls, 1, `${input.name} ${JSON.stringify(input.args)} must escalate to the reviewer`)
  assert.equal(outcome.result.isError, false, 'the injected reviewer allow must execute the body')
  assert.equal(outcome.ran, 1)
  assert.equal(outcome.record.tier, 'escalate')
  assert.equal(outcome.record.rule, E)
  assert.equal(outcome.record.cwdRelative, null)
  return outcome
}

// ---------------------------------------------------------------------------
// Configuration and defaults.
// ---------------------------------------------------------------------------

test(`rule gate config: Loader schema declares volatile default-off fields (${targetName})`, () => {
  assert.equal(plugin.Config.type, 'object')
  const mode = plugin.Config.dict.ruleGate
  assert.equal(mode.type, 'string')
  assert.equal(mode.meta.default, 'off', 'the documented default is off (zero behavior change)')
  assert.equal(mode.meta.volatile, true, 'the mode must be read live per reviewed call')
  const log = plugin.Config.dict.ruleGateLog
  assert.equal(log.type, 'string')
  assert.equal(log.meta.default, plugin.DEFAULT_RULE_GATE_LOG)
  assert.equal(
    plugin.DEFAULT_RULE_GATE_LOG,
    '~/.dsh/state/auto-review-rule-gate/decisions.jsonl',
    'the documented private record path',
  )
  assert.equal(log.meta.volatile, true)
  // The pre-existing settings keep their exact declarations.
  assert.equal(plugin.Config.dict.approvalTimeoutMinutes.meta.default, 0)
  assert.equal(plugin.Config.dict.autoDenyReviewerRejections.meta.default, false)
})

test(`rule gate config: every unknown mode normalizes to off (${targetName})`, () => {
  assert.equal(plugin.resolveRuleGateMode('off'), 'off')
  assert.equal(plugin.resolveRuleGateMode('shadow'), 'shadow')
  assert.equal(plugin.resolveRuleGateMode('enforce'), 'enforce')
  for (const value of [undefined, null, 'bogus', 'ENFORCE', 1, true, {}, ['shadow']]) {
    assert.equal(plugin.resolveRuleGateMode(value), 'off', `expected off for ${String(value)}`)
  }
})

test(`rule gate config: an unknown configured mode leaves behavior and records unchanged (${targetName})`, async t => {
  const fixture = createFixture(t)
  const harness = harnessFor(fixture, {
    script: [REVIEWER_ALLOW],
    config: gateConfig(fixture, 'enforcee'),
  })
  try {
    const outcome = await gated(harness, fixture, { name: 'read', args: { file_path: fixture.files.notes } })
    assert.equal(outcome.reviewerCalls, 1, 'an unknown value must not enable enforcement')
    assert.equal(outcome.ran, 1)
    assert.equal(outcome.result.isError, false)
    assert.deepEqual(readRecords(fixture.log), [], 'off (normalized) never writes a record')
    assert.equal(existsSync(dirname(fixture.log)), false)
  } finally {
    await harness.dispose()
  }
})

// ---------------------------------------------------------------------------
// off: today's behavior, byte-for-byte.
// ---------------------------------------------------------------------------

test(`off: reviewer still runs and no shadow record path is touched (${targetName})`, async t => {
  const fixture = createFixture(t)
  const harness = harnessFor(fixture, {
    script: [REVIEWER_MEDIUM_ALLOW],
    config: gateConfig(fixture, 'off'),
  })
  try {
    const outcome = await gated(harness, fixture, { name: 'read', args: { file_path: fixture.files.notes } })
    assert.equal(outcome.reviewerCalls, 1)
    assert.equal(outcome.ran, 1)
    assert.equal(outcome.result.isError, false)
    assert.equal(harness.approvalRequests.length, 0)
    assert.equal(outcome.record, undefined)
    assert.equal(existsSync(fixture.log), false, 'off must not create the record file')
    assert.equal(existsSync(dirname(fixture.log)), false, 'off must not create the record directory')
  } finally {
    await harness.dispose()
  }
})

// ---------------------------------------------------------------------------
// shadow: reviewer unchanged, record written.
// ---------------------------------------------------------------------------

test(`shadow: the reviewer still runs and an allow verdict is recorded privately (${targetName})`, async t => {
  const fixture = createFixture(t)
  const sessionId = 'session-shadow-record'
  const args = { file_path: fixture.files.notes }
  const harness = harnessFor(fixture, {
    script: [REVIEWER_ALLOW],
    config: gateConfig(fixture, 'shadow'),
  })
  try {
    const outcome = await gated(harness, fixture, { name: 'read', args, sessionId })
    assert.equal(outcome.reviewerCalls, 1, 'shadow must still call the reviewer')
    assert.equal(outcome.ran, 1)
    assert.deepEqual(outcome.result, { content: [{ type: 'text', text: 'ran' }], isError: false })

    const records = readRecords(fixture.log)
    assert.equal(records.length, 1)
    const [record] = records
    assert.deepEqual(Object.keys(record), [
      'ts', 'mode', 'tier', 'rule', 'tool', 'sessionIdHash', 'argLength', 'cwdRelative',
    ])
    assert.equal(record.mode, 'shadow')
    assert.equal(record.tier, 'allow')
    assert.equal(record.rule, A01)
    assert.equal(record.tool, 'read')
    assert.equal(new Date(record.ts).toISOString(), record.ts)
    assert.equal(record.sessionIdHash, createHash('sha256').update(sessionId).digest('hex').slice(0, 12))
    assert.equal(record.sessionIdHash.length, 12)
    assert.equal(record.argLength, JSON.stringify(args).length)
    assert.equal(record.cwdRelative, 'notes.txt')

    // Privacy: no arguments, file contents, raw session id or absolute paths.
    const serialized = JSON.stringify(record)
    assert.equal('arguments' in record, false)
    assert.equal(serialized.includes(sessionId), false, 'the raw session id must never be recorded')
    assert.equal(serialized.includes('workspace notes content'), false)
    assert.equal(serialized.includes('TOKEN='), false)
    assert.equal(serialized.includes(fixture.workspace), false, 'no absolute workspace path in a record')
    assert.equal(serialized.includes(homedir()), false, 'no home path in a record')
  } finally {
    await harness.dispose()
  }
})

test(`shadow: decisions, reviewer calls and approvals are identical to off (${targetName})`, async t => {
  const fixture = createFixture(t)
  const runOff = async () => {
    const harness = harnessFor(fixture, {
      script: [REVIEWER_DENY],
      defaultApprovalPolicy: 'never',
      config: gateConfig(fixture, 'off'),
    })
    try {
      const outcome = await gated(harness, fixture, { name: 'read', args: { file_path: fixture.files.notes } })
      return {
        result: outcome.result,
        reviewerCalls: outcome.reviewerCalls,
        ran: outcome.ran,
        approvalRequests: harness.approvalRequests.length,
      }
    } finally {
      await harness.dispose()
    }
  }
  const runShadow = async () => {
    const harness = harnessFor(fixture, {
      script: [REVIEWER_DENY],
      defaultApprovalPolicy: 'never',
      config: gateConfig(fixture, 'shadow'),
    })
    try {
      const outcome = await gated(harness, fixture, { name: 'read', args: { file_path: fixture.files.notes } })
      return {
        result: outcome.result,
        reviewerCalls: outcome.reviewerCalls,
        ran: outcome.ran,
        approvalRequests: harness.approvalRequests.length,
        record: outcome.record,
      }
    } finally {
      await harness.dispose()
    }
  }

  const off = await runOff()
  assert.deepEqual(readRecords(fixture.log), [], 'off wrote no record before the shadow run')
  const shadow = await runShadow()

  assert.deepEqual(shadow.result, off.result, 'shadow must return the exact off decision')
  assert.equal(shadow.reviewerCalls, off.reviewerCalls, 'shadow must call the reviewer exactly like off')
  assert.equal(shadow.ran, off.ran)
  assert.equal(shadow.approvalRequests, off.approvalRequests)
  assert.equal(shadow.result.error.info.code, 'AUTO_REVIEW_DENIED')
  // The shadow record shows what enforcement *would* have done, not what did.
  assert.equal(shadow.record.tier, 'allow')
  assert.equal(shadow.record.rule, A01)
})

// ---------------------------------------------------------------------------
// enforce: allow short-circuits only the reviewer.
// ---------------------------------------------------------------------------

test(`enforce allow: reviewer is skipped, next() runs and the body executes (${targetName})`, async t => {
  const fixture = createFixture(t)
  const harness = harnessFor(fixture, {
    // If the reviewer were called, it would deny; enforcement must not call it.
    script: [REVIEWER_DENY],
    config: gateConfig(fixture, 'enforce'),
  })
  let downstreamCalls = 0
  harness.ctx.on('tools/pre-execute', async (_payload, next) => {
    downstreamCalls += 1
    return next()
  })
  try {
    const outcome = await gated(harness, fixture, { name: 'read', args: { file_path: fixture.files.notes } })
    assert.equal(outcome.reviewerCalls, 0, 'an enforced allow must never call the reviewer')
    assert.equal(downstreamCalls, 1, 'the pass-through path must run the downstream waterfall')
    assert.equal(outcome.ran, 1)
    assert.equal(outcome.result.isError, false)
    assert.equal(harness.approvalRequests.length, 0)
    assert.equal(outcome.record.mode, 'enforce')
    assert.equal(outcome.record.tier, 'allow')
    assert.equal(outcome.record.rule, A01)
  } finally {
    await harness.dispose()
  }
})

test(`enforce deny: reviewer is skipped and AUTO_REVIEW_RULE_DENIED is returned (${targetName})`, async t => {
  const fixture = createFixture(t)
  const harness = harnessFor(fixture, {
    script: [],
    config: gateConfig(fixture, 'enforce'),
  })
  try {
    const outcome = await gated(harness, fixture, { name: 'bash', args: { command: 'rm -rf /' } })
    assert.equal(outcome.reviewerCalls, 0, 'an enforced deny must return before the reviewer')
    assert.equal(outcome.ran, 0, 'the denied body must never execute')
    assert.equal(outcome.result.isError, true)
    assert.match(outcome.result.error.message, /rule gate denied tool "bash"/)
    assert.match(outcome.result.error.message, /D1_RECURSIVE_FORCE_DELETE/)
    assert.deepEqual(outcome.result.error.info, RULE_DENIED_INFO)
    assert.equal(outcome.record.mode, 'enforce')
    assert.equal(outcome.record.tier, 'deny')
    assert.equal(outcome.record.rule, D1)
    assert.equal(outcome.record.cwdRelative, null)
    // The record never contains the command text or any absolute path.
    const serialized = JSON.stringify(outcome.record)
    assert.equal(serialized.includes('rm -rf'), false)
    assert.equal(serialized.includes('/'), false)
  } finally {
    await harness.dispose()
  }
})

// ---------------------------------------------------------------------------
// Path rules: inside workspace allowed, everything unproven escalates.
// ---------------------------------------------------------------------------

test(`path allow: read inside the workspace resolves lexically and through symlinks (${targetName})`, async t => {
  const fixture = createFixture(t)
  const harness = harnessFor(fixture, {
    script: [],
    config: gateConfig(fixture, 'enforce'),
  })
  try {
    const absolute = await gated(harness, fixture, {
      name: 'read',
      callId: 'call-absolute',
      args: { file_path: fixture.files.notes },
    })
    assert.equal(absolute.reviewerCalls, 0)
    assert.equal(absolute.result.isError, false)
    assert.equal(absolute.record.rule, A01)
    assert.equal(absolute.record.cwdRelative, 'notes.txt')

    const relative = await gated(harness, fixture, {
      name: 'read',
      callId: 'call-relative',
      args: { file_path: 'sub/../notes.txt' },
    })
    assert.equal(relative.reviewerCalls, 0, 'a lexical dot-dot that stays inside is provable')
    assert.equal(relative.result.isError, false)
    assert.equal(relative.record.cwdRelative, 'notes.txt')
  } finally {
    await harness.dispose()
  }
})

test(`path escalate: escapes, absolute outside and ~ outside fall through to the reviewer (${targetName})`, async t => {
  const fixture = createFixture(t)
  const harness = harnessFor(fixture, {
    script: [REVIEWER_ALLOW, REVIEWER_ALLOW, REVIEWER_ALLOW],
    config: gateConfig(fixture, 'enforce'),
  })
  try {
    await expectEscalate(harness, fixture, { name: 'read', args: { file_path: '../outside/secret.txt' } })
    await expectEscalate(harness, fixture, { name: 'read', args: { file_path: fixture.files.outsideSecret } })
    await expectEscalate(harness, fixture, { name: 'read', args: { file_path: '~' } })
  } finally {
    await harness.dispose()
  }
})

test(`path escalate: the credential and agent/VCS denylist is never allowed (${targetName})`, async t => {
  const fixture = createFixture(t)
  const sensitive = [
    fixture.files.env,
    fixture.files.envLocal,
    fixture.files.sshKey,
    fixture.files.sshEd25519,
    fixture.files.rsaPublic,
    fixture.files.pem,
    fixture.files.key,
    fixture.files.credentials,
    fixture.files.aws,
    fixture.files.npmrc,
    fixture.files.gitCredentials,
    fixture.files.netrc,
    fixture.files.gitConfig,
    fixture.files.dshrc,
    fixture.files.agentTeams,
    fixture.files.cordisPatch,
    fixture.files.settings,
    fixture.files.credentialsYaml,
  ]
  const harness = harnessFor(fixture, {
    script: sensitive.map(() => REVIEWER_ALLOW),
    config: gateConfig(fixture, 'enforce'),
  })
  try {
    for (const filePath of sensitive) {
      const outcome = await gated(harness, fixture, { name: 'read', args: { file_path: filePath } })
      assert.equal(outcome.reviewerCalls, 1, `${filePath} must escalate`)
      assert.equal(outcome.result.isError, false)
      assert.equal(outcome.record.tier, 'escalate', filePath)
      assert.equal(outcome.record.rule, E, filePath)
    }
  } finally {
    await harness.dispose()
  }
})

test(`path escalate: a symlink that resolves outside the workspace is not allowed (${targetName})`, async t => {
  const fixture = createFixture(t)
  if (!fixture.symlink) {
    t.skip('this environment cannot create symlinks')
    return
  }
  const harness = harnessFor(fixture, {
    script: [REVIEWER_ALLOW],
    config: gateConfig(fixture, 'enforce'),
  })
  try {
    const outcome = await gated(harness, fixture, {
      name: 'read',
      args: { file_path: join(fixture.workspace, 'link-out', 'secret.txt') },
    })
    assert.equal(outcome.reviewerCalls, 1, 'the realpath target is outside: escalate')
    assert.equal(outcome.result.isError, false)
    assert.equal(outcome.record.tier, 'escalate')
  } finally {
    await harness.dispose()
  }
})

// ---------------------------------------------------------------------------
// grep/glob path rules.
// ---------------------------------------------------------------------------

test(`search allow: grep/glob without path use the workspace root, inside paths are allowed (${targetName})`, async t => {
  const fixture = createFixture(t)
  const harness = harnessFor(fixture, {
    script: [],
    config: gateConfig(fixture, 'enforce'),
  })
  try {
    const grepNoPath = await gated(harness, fixture, {
      name: 'grep',
      callId: 'call-grep',
      args: { pattern: 'notes' },
    })
    assert.equal(grepNoPath.reviewerCalls, 0)
    assert.equal(grepNoPath.result.isError, false)
    assert.equal(grepNoPath.record.rule, A02)
    assert.equal(grepNoPath.record.cwdRelative, '.')

    const globNoPath = await gated(harness, fixture, {
      name: 'glob',
      callId: 'call-glob',
      args: { pattern: '**/*.txt' },
    })
    assert.equal(globNoPath.reviewerCalls, 0)
    assert.equal(globNoPath.record.rule, A02)
    assert.equal(globNoPath.record.cwdRelative, '.')

    const globInside = await gated(harness, fixture, {
      name: 'glob',
      callId: 'call-glob-sub',
      args: { pattern: '*', path: join(fixture.workspace, 'sub') },
    })
    assert.equal(globInside.reviewerCalls, 0)
    assert.equal(globInside.record.rule, A02)
    assert.equal(globInside.record.cwdRelative, 'sub')
  } finally {
    await harness.dispose()
  }
})

test(`search escalate: a grep/glob path outside the workspace falls through (${targetName})`, async t => {
  const fixture = createFixture(t)
  const harness = harnessFor(fixture, {
    script: [REVIEWER_ALLOW, REVIEWER_ALLOW],
    config: gateConfig(fixture, 'enforce'),
  })
  try {
    await expectEscalate(harness, fixture, { name: 'grep', args: { pattern: 'x', path: fixture.outside } })
    await expectEscalate(harness, fixture, { name: 'glob', args: { pattern: '*', path: '../outside' } })
  } finally {
    await harness.dispose()
  }
})

// ---------------------------------------------------------------------------
// Metadata tools and unknown tools.
// ---------------------------------------------------------------------------

test(`meta allow: exactly the fixed metadata list is allowed; working_directory and unknown tools escalate (${targetName})`, async t => {
  const fixture = createFixture(t)
  const metadataTools = [
    'job_output',
    'job_list',
    'wait_agent',
    'list_agents',
    'get_goal',
    'list_subagent_models',
    'todo_write',
    'skill',
    'structured_output',
    'agent_teams_status',
    'team_task_list',
    'team_task_get',
    'schedule_list',
    'schedule_view',
    'cordis_inspect_list',
  ]
  const harness = harnessFor(fixture, {
    script: [REVIEWER_ALLOW, REVIEWER_ALLOW],
    config: gateConfig(fixture, 'enforce'),
  })
  try {
    for (const name of metadataTools) {
      const outcome = await gated(harness, fixture, { name, args: {} })
      assert.equal(outcome.reviewerCalls, 0, `${name} must be allowed without the reviewer`)
      assert.equal(outcome.ran, 1)
      assert.equal(outcome.record.tier, 'allow', name)
      assert.equal(outcome.record.rule, A04, name)
      assert.equal(outcome.record.cwdRelative, null)
    }

    // working_directory mutates cwd state, so it is deliberately absent.
    await expectEscalate(harness, fixture, { name: 'working_directory', args: {} })
    await expectEscalate(harness, fixture, { name: 'unknown_tool', args: {} })
  } finally {
    await harness.dispose()
  }
})

test(`malformed: missing, ill-typed and non-object arguments escalate, never allow (${targetName})`, async t => {
  const fixture = createFixture(t)
  const harness = harnessFor(fixture, {
    script: [REVIEWER_ALLOW, REVIEWER_ALLOW, REVIEWER_ALLOW, REVIEWER_ALLOW, REVIEWER_ALLOW, REVIEWER_ALLOW],
    config: gateConfig(fixture, 'enforce'),
  })
  try {
    const cases = [
      { name: 'read', args: {} },
      { name: 'read', args: { file_path: 42 } },
      { name: 'read', args: null },
      { name: 'grep', args: { path: 42 } },
      { name: 'bash', args: {} },
      { name: 'bash', args: { command: 42 } },
    ]
    for (const testCase of cases) {
      const outcome = await expectEscalate(harness, fixture, testCase)
      assert.equal(outcome.record.tool, testCase.name)
    }
  } finally {
    await harness.dispose()
  }
})

// ---------------------------------------------------------------------------
// Bash deny hard floor.
// ---------------------------------------------------------------------------

test(`enforce deny matrix: D1 root/workspace deletes are denied without the reviewer (${targetName})`, async t => {
  const fixture = createFixture(t)
  const commands = [
    'rm -rf /',
    'rm -fr /*',
    'RM -RF /',
    'rm -rf ~',
    'rm -rf $HOME',
    'rm -rf ${HOME}',
    'rm -rf / --no-preserve-root',
    `rm -rf ${fixture.workspace}`,
    'rm -rf .',
    `cd sub && rm -rf ..`,
  ]
  const harness = harnessFor(fixture, { script: [], config: gateConfig(fixture, 'enforce') })
  try {
    for (const command of commands) {
      const outcome = await gated(harness, fixture, { name: 'bash', args: { command } })
      assert.equal(outcome.reviewerCalls, 0, `${command} must not reach the reviewer`)
      assert.equal(outcome.ran, 0, `${command} must not execute`)
      assert.equal(outcome.result.isError, true)
      assert.deepEqual(outcome.result.error.info, RULE_DENIED_INFO, command)
      assert.equal(outcome.record.tier, 'deny', command)
      assert.equal(outcome.record.rule, D1, command)
    }
  } finally {
    await harness.dispose()
  }
})

test(`enforce deny matrix: D2 device destruction and fork bombs are denied (${targetName})`, async t => {
  const fixture = createFixture(t)
  const commands = [
    'mkfs.ext4 /dev/sda',
    'dd if=/dev/zero of=/dev/sda',
    'echo x > /dev/sda',
    'wipefs -a /dev/sda',
    'shred /dev/sda',
    ':(){ :|:& };:',
  ]
  const harness = harnessFor(fixture, { script: [], config: gateConfig(fixture, 'enforce') })
  try {
    for (const command of commands) {
      const outcome = await gated(harness, fixture, { name: 'bash', args: { command } })
      assert.equal(outcome.reviewerCalls, 0, `${command} must not reach the reviewer`)
      assert.equal(outcome.ran, 0)
      assert.deepEqual(outcome.result.error.info, RULE_DENIED_INFO, command)
      assert.equal(outcome.record.tier, 'deny', command)
      assert.equal(outcome.record.rule, D2, command)
    }
  } finally {
    await harness.dispose()
  }
})

test(`enforce deny matrix: D3 system-directory writes are denied, pure reads are not (${targetName})`, async t => {
  const fixture = createFixture(t)
  const commands = [
    'echo x > /etc/passwd',
    'echo x | tee -a /usr/local/agent-x',
    'cp notes.txt /etc/passwd',
    'mv notes.txt /boot/agent-x',
    'install notes.txt /usr/bin/agent-x',
    'sed -i s/a/b/ /etc/passwd',
    'echo x >> /Library/agent-x',
  ]
  const harness = harnessFor(fixture, { script: [], config: gateConfig(fixture, 'enforce') })
  try {
    for (const command of commands) {
      const outcome = await gated(harness, fixture, { name: 'bash', args: { command } })
      assert.equal(outcome.reviewerCalls, 0, `${command} must not reach the reviewer`)
      assert.equal(outcome.ran, 0)
      assert.deepEqual(outcome.result.error.info, RULE_DENIED_INFO, command)
      assert.equal(outcome.record.rule, D3, command)
    }
  } finally {
    await harness.dispose()
  }
})

test(`enforce deny matrix: D5 Git history rewrites are denied (${targetName})`, async t => {
  const fixture = createFixture(t)
  const commands = [
    'git filter-branch --force HEAD',
    'GIT FILTER-BRANCH HEAD',
    'git reflog expire --expire=now --all',
    'git gc --prune=now',
  ]
  const harness = harnessFor(fixture, { script: [], config: gateConfig(fixture, 'enforce') })
  try {
    for (const command of commands) {
      const outcome = await gated(harness, fixture, { name: 'bash', args: { command } })
      assert.equal(outcome.reviewerCalls, 0, `${command} must not reach the reviewer`)
      assert.equal(outcome.ran, 0)
      assert.deepEqual(outcome.result.error.info, RULE_DENIED_INFO, command)
      assert.equal(outcome.record.rule, D5, command)
    }
  } finally {
    await harness.dispose()
  }
})

test(`hard floor is conservative: near misses and pure reads escalate instead of deny (${targetName})`, async t => {
  const fixture = createFixture(t)
  const harness = harnessFor(fixture, {
    script: [REVIEWER_ALLOW, REVIEWER_ALLOW, REVIEWER_ALLOW, REVIEWER_ALLOW, REVIEWER_ALLOW],
    config: gateConfig(fixture, 'enforce'),
  })
  try {
    // Inside the workspace and not the workspace root: not D1.
    await expectEscalate(harness, fixture, { name: 'bash', args: { command: 'rm -rf ./build' } })
    // A pure read of a system directory is never a D3 write.
    await expectEscalate(harness, fixture, { name: 'bash', args: { command: 'cat /etc/hostname' } })
    // git reset --hard is E10 escalation, deliberately not D5.
    await expectEscalate(harness, fixture, { name: 'bash', args: { command: 'git reset --hard HEAD' } })
    // A home subdirectory is not the home directory itself.
    await expectEscalate(harness, fixture, { name: 'bash', args: { command: 'rm -rf ~/scratch' } })
    // Copying *from* a system directory writes only inside the workspace.
    await expectEscalate(harness, fixture, { name: 'bash', args: { command: 'cp /etc/hostname notes-copy.txt' } })
  } finally {
    await harness.dispose()
  }
})

// ---------------------------------------------------------------------------
// Guards, fail-closed behavior and record safety.
// ---------------------------------------------------------------------------

test(`guards: a non-Auto Session never runs the rule gate (${targetName})`, async t => {
  const fixture = createFixture(t)
  const harness = harnessFor(fixture, {
    preset: 'workspace-write',
    script: [],
    config: gateConfig(fixture, 'enforce'),
  })
  try {
    const outcome = await gated(harness, fixture, { name: 'bash', args: { command: 'rm -rf /' } })
    assert.equal(outcome.reviewerCalls, 0)
    assert.equal(outcome.ran, 1, 'outside the Auto preset the existing pipeline executes the call')
    assert.equal(outcome.result.isError, false)
    assert.deepEqual(readRecords(fixture.log), [], 'the rule gate must not record outside the Auto preset')
    assert.equal(existsSync(fixture.log), false)
  } finally {
    await harness.dispose()
  }
})

test(`fail closed: a rule-engine exception logs and escalates instead of failing the call (${targetName})`, async t => {
  const fixture = createFixture(t)
  const warnings = []
  const realWarn = console.warn
  console.warn = (...text) => { warnings.push(text.join(' ')) }
  t.after(() => { console.warn = realWarn })
  const harness = harnessFor(fixture, {
    script: [REVIEWER_ALLOW],
    config: gateConfig(fixture, 'enforce'),
  })
  harness.ctx.workingDirectory.ensure = async () => {
    // Throw only for the rule gate's first lookup; the reviewer's own lookup
    // must still succeed so the test can prove the fail-closed fall-through.
    harness.ctx.workingDirectory.ensureCalls = (harness.ctx.workingDirectory.ensureCalls ?? 0) + 1
    if (harness.ctx.workingDirectory.ensureCalls === 1) throw new Error('workspace lookup exploded')
    return fixture.workspace
  }
  try {
    const outcome = await gated(harness, fixture, { name: 'read', args: { file_path: fixture.files.notes } })
    assert.equal(outcome.reviewerCalls, 1, 'a thrown rule engine must fall through to the reviewer')
    assert.equal(outcome.ran, 1)
    assert.equal(outcome.result.isError, false)
    assert.equal(outcome.result.error, undefined)
    assert.equal(warnings.some(text => text.includes('rule gate failed')), true)
    assert.equal(outcome.record.tier, 'escalate')
    assert.equal(outcome.record.rule, E)
  } finally {
    await harness.dispose()
  }
})

test(`record safety: the log directory is 0700 and the file is 0600 (${targetName}, POSIX only)`, async t => {
  if (process.platform === 'win32') {
    t.skip('POSIX file modes are not meaningful on Windows')
    return
  }
  const fixture = createFixture(t)
  const harness = harnessFor(fixture, {
    script: [REVIEWER_ALLOW],
    config: gateConfig(fixture, 'shadow'),
  })
  try {
    await gated(harness, fixture, { name: 'read', args: { file_path: fixture.files.notes } })
    assert.equal(statSync(fixture.log).mode & 0o777, 0o600)
    assert.equal(statSync(dirname(fixture.log)).mode & 0o777, 0o700)
  } finally {
    await harness.dispose()
  }
})

test(`volatile: the next reviewed call reads a changed ruleGate mode (${targetName})`, async t => {
  const fixture = createFixture(t)
  const live = { mode: 'off' }
  const harness = harnessFor(fixture, {
    script: [REVIEWER_ALLOW, REVIEWER_ALLOW],
    config: { ruleGate: { get: () => live.mode }, ruleGateLog: fixture.log },
  })
  try {
    const first = await gated(harness, fixture, { name: 'read', args: { file_path: fixture.files.notes } })
    assert.equal(first.reviewerCalls, 1)
    assert.deepEqual(readRecords(fixture.log), [])

    live.mode = 'shadow'
    const second = await gated(harness, fixture, {
      name: 'read',
      callId: 'call-2',
      args: { file_path: fixture.files.notes },
    })
    assert.equal(second.reviewerCalls, 1)
    assert.equal(readRecords(fixture.log).length, 1)
    assert.equal(readRecords(fixture.log)[0].mode, 'shadow')
  } finally {
    await harness.dispose()
  }
})

// ---------------------------------------------------------------------------
// ENFORCE MODE REVIEW-FREE: general boundary probes.
// ---------------------------------------------------------------------------

test(`enforce escalate: a metadata tool with an unknown name falls through, not fails (${targetName})`, async t => {
  const fixture = createFixture(t)
  const harness = harnessFor(fixture, {
    script: [REVIEWER_MEDIUM_ALLOW],
    config: gateConfig(fixture, 'enforce'),
  })
  try {
    const outcome = await gated(harness, fixture, { name: 'cordis_inspect', args: {} })
    assert.equal(outcome.reviewerCalls, 1)
    assert.equal(outcome.ran, 1)
    assert.equal(outcome.record.tier, 'escalate')
  } finally {
    await harness.dispose()
  }
})
