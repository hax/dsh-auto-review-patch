# dsh-experimental-auto-review fork: denial reasons and human-response timeout

Unofficial standalone fork of the official DSH package
`@deepseek-ai/dsh-experimental-auto-review`, implementing:

- [Issue #3](https://github.com/hax/dsh-auto-review-model/issues/3): return a
  concise reviewer denial reason to the Agent without changing risk
  classification, allow/deny decisions, the approval mode (人工审批方式), or the
  "denied tool body never executes" invariant (commit `56a0252`, preserved);
- [Issue #5](https://github.com/hax/dsh-auto-review-model/issues/5): add a
  configurable minute-level **human-response timeout** for the one human
  approval question this patch may ask, denying as human non-response instead of
  waiting forever;
- **Phase 1 deterministic rule gate** (fork-only, opt-in): a small, closed set
  of read-only calls can skip the reviewer, a conservative hard floor can deny
  destructive shell commands, and every unproven call still goes to the
  reviewer. The default `off` leaves existing behavior byte-identical.

This repository is an **unofficial patch/fork**: it is not published and is
not installed in the running profile by this task. It is based
on the current DSH `0.2.2-rc.3` official source; exact upstream provenance is in
[UPSTREAM.md](UPSTREAM.md). The production delta is stored as six independent,
ordered patches:
`patches/0001-return-concise-reviewer-denial-reasons.patch` (Issue #3, frozen),
`patches/0002-add-human-approval-timeout.patch` (Issue #5, frozen),
`patches/0003-fix-approval-grant-unload-race.patch` (grant/unload race fix),
`patches/0004-inline-fiber-state-active.patch` (frozen load-time `FiberState`
fix), `patches/0005-add-auto-deny-reviewer-rejections.patch` (full-auto
reviewer-denial switch, frozen), and
`patches/0006-add-rule-gate-phase1.patch` (Phase 1 deterministic rule gate).

## Behavior

### 1. Technical review failure (unchanged)

`failed()` still yields exactly

```
Auto review of tool "<name>" failed; its body was not executed: <review error>
```

with `info: { name: 'AutoReviewFailedError', code: 'AUTO_REVIEW_FAILED' }`. No
behavior or text of this path changed.

### 2. Fully automatic denial (`approval = never`)

Under the Auto review preset, a `never` approval mode (全自动拒绝; explicitly
pinned, or the configured default) resolves a reviewer denial automatically
without asking the human. The Agent's tool result now appends the reviewer's
optional concise `decision.reason`:

```
Auto review rejected tool "<name>"; its body was not executed: <decision.reason>
```

- `info` keeps the official `{ name: 'AutoReviewDeniedError', code:
  'AUTO_REVIEW_DENIED', reason? }` shape.
- Without a reason (or with a blank one), the previous concise text is emitted
  unchanged.
- The reviewer's risk class, its reasoning blocks and any chain-of-thought are
  never included: only the closed-protocol `decision.reason` string is used.
- The denied body is never executed and no human question is asked.

The session's approval mode (人工审批方式) is read as
`approval.overrideOf(session) ?? approval.config.policy ?? 'ask'` — the same
resolution the approval service uses. The two modes are `ask` (询问人类 — ask
the human) and `never` (全自动拒绝 — reject automatically without asking); this
fork names the read `resolveApprovalMode`, while the persisted official
`approval.policy` values stay `ask` / `never` unchanged. A deployment whose
*default* mode is `never` therefore also gets the automatic denial path instead
of a fabricated "the user rejected" message.

### 3. Interactive denial (`ask` mode: 询问人类)

The reviewer's denial still asks exactly one human question through the
existing approval seam, with the same audited `approval/asked` +
`approval/decided` pair, the same answerer routing and the same
`displayReason` localization:

- human **allows** → the tool executes normally (after the pipeline's guards).
  Before that `allowed-once` grant is accepted, the fused call + integration
  lifecycle signal is re-read; an unload or caller cancellation that landed
  while the approval service was producing the outcome (including from a
  synchronous `approval/decided` observer) discards the grant instead, as
  described in section 6. The approval audit pair is still written exactly once;
- human **rejects** → the Agent receives the reviewer's concern in addition to
  the ordinary rejection:

  ```
  the user rejected tool "<name>"; Auto review concern: <decision.reason>
  ```

  with `info: { name: 'ApprovalError', code: 'APPROVAL_REJECTED', reason? }`.
  Without a reviewer reason the exact pre-patch text
  `the user rejected tool "<name>"` is preserved. The human's own answer carries
  no text in the approval protocol, so nothing is invented.
- approval **cancelled** → the pipeline's canonical
  `tool call aborted before dispatch` result (`AbortError` /
  `ABORTED_BEFORE_DISPATCH`), including when this integration is disposed while
  the question is pending;
- approval **unavailable** → the pipeline's canonical
  `tool "<name>" requires approval, but no approval channel is available` denial
  (`ApprovalError` / `APPROVAL_UNAVAILABLE`).

### 4. Full-auto reviewer denial in the Auto preset (`autoDenyReviewerRejections`)

The Auto permission preset pins the official approval mode to `ask`
(询问人类) and the Web GUI exposes no approval-policy knob, so this fork owns a
second Loader config setting that turns a reviewer denial into the final
automatic denial:

| Field | Type | Default | Semantics |
| --- | --- | --- | --- |
| `autoDenyReviewerRejections` | boolean | `false` | `true`: a reviewer `deny` maps directly to the same automatic denial the `never` mode writes, without asking a human. `false`: every existing ask/never, direct-approval and timeout behavior is unchanged. |

When it is `true` and the reviewer decision is `deny`:

- the Agent receives the fixed automatic denial with the reviewer's concise
  concern when present:

  ```
  Auto review rejected tool "<name>"; its body was not executed[: <decision.reason>]
  ```

  with `info: { name: 'AutoReviewDeniedError', code: 'AUTO_REVIEW_DENIED',
  reason? }` — byte-identical to the `never`-mode denial from section 2;
- **no human is asked**: there is no `approval.request()`, no
  `approval/asked`/`approval/decided` audit pair and no `approvalTimeoutMinutes`
  timer;
- the tool body never executes, and downstream `tools/pre-execute` listeners are
  not consulted (the denial returns before `next()`, exactly like the `never`
  path);
- the switch only reacts to reviewer `deny` decisions: reviewer **allow** still
  runs the normal pipeline (downstream gates, guards, dispatch), and technical
  reviewer failures still use `failed()` / `AUTO_REVIEW_FAILED` unchanged. Risk
  classification and the allow/deny decision itself are untouched.

The field is declared in the exported Loader schema (`Config`) with
`schemastery`'s `.volatile()` and read **once per reviewed call**, so a config
update applies to the next call without remounting the integration. Only a
literal `true` enables it; `false`, a missing value, or an unreadable live value
keeps the existing behavior.

### 5. Minute-level human-response timeout (`approvalTimeoutMinutes`)

The fork adds this Loader config setting:

| Field | Type | Default | Range | Semantics |
| --- | --- | --- | --- | --- |
| `approvalTimeoutMinutes` | number (minutes) | `0` | `0` … `1440` (24 h) | `0` disables the timeout. Any positive finite value (fractions allowed) becomes a deadline for one human approval question. |

The field is declared in the exported Loader schema (`Config`) with
`schemastery`'s `.volatile()`, and the plugin reads the live value **once per
human question**, so a settings/config update changes the next question's
deadline without remounting the integration.

How the deadline works:

- the timer is derived **only** when the plugin really calls
  `ctx.approval.request()` for a reviewer-denied call under an effective `ask`
  approval mode (询问人类); reviewer allow/deny paths, downstream denials and
  the automatic `never` path never create one;
- the question's signal becomes
  `AbortSignal.any([call signal, integration disposal signal, deadline signal])`,
  so a timeout withdraws the pending question exactly like a cancellation and
  the approval service discards a late human answer by construction;
- reaching the deadline returns a `deny` decision and the tool body is never
  executed:

  ```
  Auto review denied tool "<name>": the human approval request timed out after <n> minutes with no response; its body was not executed
  ```

  with the reviewer's concise concern appended when present
  (`; Auto review concern: <decision.reason>`) and
  `info: { name: 'AutoReviewApprovalTimeoutError', code:
  'AUTO_REVIEW_APPROVAL_TIMEOUT', reason? }`. The text never says "the user
  rejected", so the Agent can tell human non-response apart from a human or
  reviewer rejection; without a reviewer reason no concern is invented;
- caller cancellation and integration teardown keep their existing
  `tool call aborted before dispatch` result and take precedence over the
  deadline; a late allow or reject is ignored and cannot execute the body;
- only a missing setting or an explicit `0` disables the timeout. Non-numbers,
  `NaN`, infinities, negative values, and values above the 24-hour cap are
  rejected with an actionable `TypeError` or `RangeError`; a bad setting cannot
  silently turn into an unlimited approval wait. The Loader schema declares the
  same `0..1440` bounds, and every live value is checked again before use (the
  live check also rejects `NaN`, which the schema's range comparison alone lets
  through). The conversion rounds minutes to whole milliseconds and rejects any
  zero-length or overflowing delay;
- the existing approval failure containment is unchanged: an approval request
  that throws still fails the call exactly as before and the timer is cleared.

All Loader settings (`approvalTimeoutMinutes`, `autoDenyReviewerRejections`,
`ruleGate` and `ruleGateLog`) are configured on the Auto review bundle row; see
[Where to configure the settings](#where-to-configure-the-settings).

Scope limit: the deadline belongs to the plugin's own direct approval question.
A downstream `ask` gate produced by another pre-execute listener (after a
reviewer allow, or outside the reviewer-denial path) is still resolved by
`ToolsPipeline`'s private `serviceAsk()` and is **not** timed by this patch.

### 6. Grant-versus-unload race (final-review fix)

`ApprovalService.request()` appends its durable `approval/decided` audit event
before it returns the outcome, and `Session.append()` notifies observers
**synchronously**. An observer can therefore unload this integration (or abort
the caller) after an `allowed-once` grant is durable but before the plugin maps
that outcome. Without a re-check the plugin could return `allow` for a body that
would then dispatch after unload: the pipeline only sees the tool call's own
signal, not this integration's disposal signal.

The fix re-reads signals at every point where an approval outcome is accepted:

- after **every** approval await — both the `approvalTimeoutMinutes = 0`
  direct-request path and the deadline path — the fused
  `call signal + integration lifecycle signal` is re-read before an outcome is
  mapped; a caller cancellation or plugin unload returns the canonical
  `tool call aborted before dispatch` cancellation and discards even an
  `allowed-once` grant. A lone elapsed deadline still maps to the #5 timeout
  instead of a cancellation;
- after `askUser()` returns and before the pre-execute listener returns to the
  pipeline, the integration lifecycle is re-read once more, closing the window
  between accepting the grant and handing it to the pipeline.

The approval audit remains exactly the one `approval/asked` +
`approval/decided` pair the service wrote (for example `allowed-once`), the
other outcome mappings are unchanged, and the tool body never executes. The
regression tests trigger disposal and caller aborts from a synchronous
`approval/decided` observer in both the timeout-less and deadline paths.

### 7. Phase 1 deterministic rule gate (`ruleGate`)

A deterministic gate runs **before** the reviewer for exactly the same
Auto-preset calls the listener already reviews. Phase 1 is deliberately narrow:
**it never allows a shell command.** Read-only shell parsing is Phase 2 and out
of scope.

| `ruleGate` | Reviewer | Decision record | Behavior |
| --- | --- | --- | --- |
| `off` (default) | called exactly as before | none | byte-identical to the pre-gate fork |
| `shadow` | called exactly as in `off` | one JSONL line per reviewed call | computes a tier for analysis; every decision is still the reviewer's |
| `enforce` | skipped for `allow` / `deny`; called for `escalate` | one JSONL line per reviewed call | `allow` uses the existing `next()` pass-through, `deny` returns before the reviewer, everything else falls through to today's reviewer |

#### What Phase 1 allows

Only these rules, and only when every check succeeds:

- `A01_READONLY_READ` — tool `read`, `file_path` resolves inside the **session
  workspace** (`ctx.workingDirectory.ensure(...)`, not the process cwd) after
  `~` expansion, `path.resolve` and `fs.realpathSync.native`. An existing
  target is required; a missing target, a symlink that resolves outside, or any
  realpath error escalates. The path denylist below also applies.
- `A02_READONLY_SEARCH` — tool `grep` or `glob`. `path` is optional; absent
  means the session workspace. A present `path` must resolve inside it and pass
  the same denylist.
- `A04_META_READ` — tool name in exactly this list: `job_output`, `job_list`,
  `wait_agent`, `list_agents`, `get_goal`, `list_subagent_models`,
  `todo_write`, `skill`, `structured_output`, `agent_teams_status`,
  `team_task_list`, `team_task_get`, `schedule_list`, `schedule_view`,
  `cordis_inspect_list`. `working_directory` is deliberately absent because it
  mutates cwd state.

Allow-rule path denylist: `.env*`, `.ssh/`, `id_rsa*`, `id_ed25519*`, `*.pem`,
`*.key`, `credentials*`, `.aws/`, `.npmrc`, `.git-credentials`, `.netrc`,
`.git/config`, `.dsh*`, `.agent-teams/`, `cordis.patch.yml`, `settings.yaml`,
`.credentials.yaml`.

#### What Phase 1 denies

Only `bash`, matched case-insensitively against the raw command text, and only
for this conservative hard floor:

- `D1_RECURSIVE_FORCE_DELETE` — `rm` with both recursive and force flags
  targeting `/`, `/*`, `~`, `$HOME`, the session workspace root, or one of their
  ancestors, including `--no-preserve-root` (`rm -rf /`, `rm -fr /*`,
  `rm -rf ~`, `rm -rf .` at the workspace root, `rm -rf <cwd>`, …).
- `D2_DEVICE_DESTRUCTION_OR_FORK_BOMB` — `mkfs*`, `dd … of=/dev/…`,
  `> /dev/sd*` (block devices, not `/dev/null`), `wipefs`, `shred /dev/…`, and
  the fork bomb `:(){ :|:& };:`.
- `D3_SYSTEM_DIRECTORY_WRITE` — writes into `/etc`, `/usr`, `/bin`, `/sbin`,
  `/System`, `/Library` or `/boot` through redirection, `tee`, `cp`, `mv`,
  `install` or `sed -i`. A pure read of those directories is **not** denied (it
  escalates).
- `D5_GIT_HISTORY_REWRITE` — `git filter-branch`,
  `git reflog expire --expire=now --all`, `git gc --prune=now`.
  `git reset --hard` is **not** D5; it escalates.

Everything else is `escalate` and goes to today's reviewer: every other shell
command, agent/VCS-config and credential paths, `..` escapes, absolute paths
outside the workspace, `~/…` outside, symlinks resolving outside, unknown
tools, missing or ill-typed arguments, and any parse ambiguity. Phase 1 does
**not** implement D4 (secret-exfiltration data flow); that still escalates.

A deny returns a `PreToolDecision` with its own persisted identity
`{ name: 'AutoReviewRuleDeniedError', code: 'AUTO_REVIEW_RULE_DENIED' }`, so it
is distinguishable from a reviewer denial (`AUTO_REVIEW_DENIED`) and an
approval denial. The tool body never executes. An allow returns `next()`, not
`{ kind: 'allow' }`: the reviewer is the only step skipped, while every
downstream pre-execute gate, guard and dispatch stays identical.

The gate fails closed. If it throws for any reason it logs and escalates to the
reviewer; it never fails the tool call and never fabricates an allow.

#### Configuration

| Field | Type | Default | Semantics |
| --- | --- | --- | --- |
| `ruleGate` | `'off' \| 'shadow' \| 'enforce'` | `'off'` | Unknown or malformed values normalize to `off`. Volatile, read per reviewed call. |
| `ruleGateLog` | string | `~/.dsh/state/auto-review-rule-gate/decisions.jsonl` | JSONL decision record for `shadow` / `enforce`. Leading `~` expands; a relative path resolves against the session cwd. Volatile. |

#### Shadow rollout procedure

1. Set `ruleGate: shadow` and keep `ruleGateLog` at a writable path. The
   reviewer and every allow/deny/ask decision stay exactly as they are today.
2. Run shadow for at least **2 weeks and 10,000 reviewed calls**, whichever
   takes longer, across the workflows the deployment actually uses.
3. Compare the records with the reviewer/session logs. Every `tier: allow`
   record must correspond to a reviewer allow (the reviewer still decided the
   call in shadow); a mismatch means the deterministic rule is broader than the
   reviewer and must be tightened. Every `tier: deny` record must be a command
   that is genuinely in the D1–D5 hard floor.
4. Promote to `enforce` only after no `allow` record contradicts a reviewer
   denial and every `deny` is expected. Any unexplained record means staying in
   shadow, not ignoring the mismatch.
5. Keep `ruleGateLog` configured after promotion so enforced allow/deny records
   stay auditable.

The record is one JSON line per shadow/enforce reviewed call:
`{ts, mode, tier, rule, tool, sessionIdHash, argLength, cwdRelative}`. It
deliberately contains **no tool arguments, no command text, no file contents
and no raw session id**: `sessionIdHash` is the first 12 hexadecimal characters
of the SHA-256 of the session id, and `cwdRelative` is the workspace-relative
path for path rules (`null` otherwise; never an absolute path). The record
directory is created `0700` and the file `0600`. `off` writes nothing.

#### Phase 1 limits, stated honestly

- **Shell commands are never allowed.** Only the bash deny hard floor is
  evaluated; every other shell command escalates. Read-only shell parsing is
  Phase 2.
- D4 (secret-exfiltration data flow) is not implemented; exfiltration remains an
  `escalate` for the reviewer.
- The deny floor is a conservative text heuristic, not a shell parser. It can
  miss an obfuscated destructive command (which then escalates); it is never
  used to allow anything.
- The path model and `fs.realpathSync.native` checks target POSIX; no Windows
  path handling is claimed.

### Why the plugin calls `approval.request()` itself

`ToolsPipeline.prepare()` applies the `tools/pre-execute` waterfall **first**
and only then resolves an `ask` gate through its private `serviceAsk()`:

```
packages/core/tools/src/pipeline.ts @ dsh-v0.2.2-rc.3
  gate = await ctx.waterfall('tools/pre-execute', ...)
  askResolution = gate.kind === 'ask' ? await this.serviceAsk(exec, gate) : ...
```

`serviceAsk()` maps every human rejection to the fixed
`the user rejected tool "<name>"` denial, so the reviewer concern retained in
the approval audit/UI never reached the Agent. The official plugin's `next()`
inside the waterfall does not include the human approval round.

The minimal reliable fix is therefore to call the **public**
`ctx.approval.request()` seam from the plugin for a reviewer denial under an
`ask` policy, and map its four outcomes as above. This:

- does not modify `ToolsPipeline`, `ApprovalService`, `model-router`, the
  app.asar, or the current profile;
- keeps one audited question per call (the pipeline no longer sees an `ask`
  gate, so its `serviceAsk()` cannot ask a second time);
- keeps the `never` policy gate inside `ApprovalService` authoritative;
- puts this question — and only this question — on the #5 minute-level deadline:
  the request signal fuses the call lifetime, the integration disposal signal
  and, when configured, the human-response deadline;
- is skipped entirely when `autoDenyReviewerRejections` is `true`: that setting
  returns the automatic denial before this seam (see section 4), so a
  full-auto deployment never asks a human and never arms a deadline.

## Where to configure the settings

All four settings are ordinary Loader `Config` fields of the Auto review
bundle, so they are set on the `auto-review` row in the active profile's Cordis
patch.

- **Web GUI:** the sidebar **Plugins** page edits configuration only for
  plugins that ship their own configuration page (the `auto-review-model` fork
  is an example of a plugin that ships one). This Host-only Auto review fork
  ships **no client page**, and the shipped Web client does not
  auto-generate forms from a bundle's `Config` schema
  (`@deepseek-ai/dsh-settings` supports such forms, but no shipped client builds
  pages from the schema yet). The **Plugins** page and **Settings → Built-in
  plugins** therefore list the Auto review bundle and its inventory, while its
  four config values are edited in the profile patch below.
- **Profile patch (the supported path):** edit the active profile's
  `cordis.patch.yml` — on Desktop
  `~/.dsh/profiles/<profile>/cordis.patch.yml` — and override the installed
  bundle row with a `config` block:

  ```yaml
  - id: auto-review
    name: "@deepseek-ai/dsh-experimental-auto-review"
    config:
      approvalTimeoutMinutes: 5
      autoDenyReviewerRejections: true
      ruleGate: shadow
      ruleGateLog: ~/.dsh/state/auto-review-rule-gate/decisions.jsonl
  ```

  All four fields are `volatile`, so once the profile change is applied
  (`config-editor`/HMR), the next reviewed call reads the new values without
  remounting the integration; without HMR the change applies after a restart.
  Omitting a field keeps its schema default (`approvalTimeoutMinutes: 0`,
  `autoDenyReviewerRejections: false`, `ruleGate: 'off'`, `ruleGateLog:
  ~/.dsh/state/auto-review-rule-gate/decisions.jsonl`).

## Upstream drift risk

`@deepseek-ai/dsh-tools` deliberately does not export the persisted approval
error identity strings, and the pipeline's `serviceAsk()` materialization text
lives in a private method. This fork repeats those exact upstream strings:

| Constant | Value | Upstream source |
| --- | --- | --- |
| `APPROVAL_ERROR_NAME` | `ApprovalError` | `packages/core/tools/src/error-codes.ts` |
| `APPROVAL_REJECTED_CODE` | `APPROVAL_REJECTED` | same |
| `APPROVAL_UNAVAILABLE_CODE` | `APPROVAL_UNAVAILABLE` | same |
| unavailable reason | `tool "<name>" requires approval, but no approval channel is available` | `pipeline.ts` `serviceAsk()` |

These are locked by regression tests. If a future DSH release renames the
codes or rewords that denial, this fork must be rebased and the constants
updated together with the expected test messages.

Because the patch intentionally changes model-facing denial text, the upstream
monorepo spec expectations for those messages change too — for example the
upstream `never`-policy PTC test asserts the exact pre-patch
`Error: Auto review rejected tool "<name>"; its body was not executed` content,
and the upstream ask-path tests assert only `the user rejected tool "<name>"`.
Porting this patch upstream requires updating those assertions together with
the new regression tests in this repository.

The #5, full-auto-denial and rule-gate additions are fork-only as well: the
official plugin exports no `Config` schema, so `approvalTimeoutMinutes`,
`autoDenyReviewerRejections`, `ruleGate`, `ruleGateLog`,
`AutoReviewApprovalTimeoutError`, `AUTO_REVIEW_APPROVAL_TIMEOUT`,
`AutoReviewRuleDeniedError` and `AUTO_REVIEW_RULE_DENIED` have no upstream
counterpart. The Phase 1 gate also adds Node built-in usage (`node:crypto`,
`node:fs`, `node:os`, `node:path`) that official Auto review never imports. This
fork therefore declares `@deepseek-ai/schemastery` (`~3.19.0`, the version
upstream DSH packages declare) as a **peer dependency** for its Loader config
schema; official Auto review does not need it. A peer, not a dependency: DSH
installs this fork as a `link:` into the profile, and pnpm does not install a
linked package's own `dependencies`, so a plain dependency is never resolvable
at runtime — the DSH loader only routes a bare import to the installation's copy
when the importing package declares it in `peerDependencies` (see the note
below). The upstream spec does not cover a human-response timeout, the
full-auto reviewer-denial switch or the deterministic rule gate at all, so the
regression tests in this repository are their only automated coverage.

The #0003 fix additionally relies on the documented `Session.append()` behavior
of notifying `session/event` observers synchronously after the log push; that is
what lets an observer unload the integration between the durable approval grant
and its mapping. If a future DSH release defers observer notification, revisit
the race window and its regression tests.

### Load-time import compatibility with the shipped DSH build (fork-only)

The fork is an **unbundled** `tsc` build, while the official package ships a
bundle. Two upstream source imports therefore cannot be taken verbatim, and both
failure modes only appear when the plugin is really loaded by the running app —
never in the offline test suite:

1. **`@deepseek-ai/schemastery`** (added by Issue #5) must be a
   `peerDependencies` entry, not a `dependencies` entry. DSH links this fork into
   the profile (`link:`), and pnpm does not install a linked package's own
   dependencies; the runtime resolver (`dsh-app-boot` `routeLinked`) only routes
   a bare import to the installation's copy when the linked package declares that
   name as a peer. As a `dependency` the import fails with
   `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/schemastery'`.
2. **`FiberState`** must not be imported from `@deepseek-ai/cordis` (patch 0004).
   Cordis declares it as a `const enum`, so the shipped `@deepseek-ai/cordis`
   build inlines the member values and exports no `FiberState` binding at all;
   the official bundle therefore compares `ctx.root.fiber.state` against the
   inlined literal `2`. The fork does the same through the documented
   `FIBER_STATE_ACTIVE` constant. As a bare import it fails at load time with
   `The requested module '@deepseek-ai/cordis' does not provide an export named
   'FiberState'`.

Both are properties of the installed runtime, not of the upstream source, so the
`types/` declarations were corrected to state them explicitly
(`ctx.root.fiber.state` is a number; no importable `FiberState`) and the local
cordis test double carries the numeric member order instead of a string.

### Peer ranges must track the runtime, not one release

DSH rejects a whole bundle whose `@deepseek-ai/dsh`/`@deepseek-ai/dsh-*` peer
ranges do not satisfy the **running** version (`evaluatePluginCompatibility`), and
it does so **silently from the plugin's point of view**: no activation, no
`auto` permission preset, and every Session pinned to that preset degrades to
the derived `custom` preset — the composer then reports the Session as
unavailable and cannot send. This is what a Desktop auto-update from
`0.2.2-rc.3` to `0.2.2-rc.5` produced while the peers here were pinned to the
exact `0.2.2-rc.3`: the fork's `lib/index.js` was fine, the pin was not.

The peers are therefore ranges (`>=0.2.2-rc.3 <0.2.3`) rather than one exact
release. Widening them was verified safe rather than assumed: the official
`@deepseek-ai/dsh-experimental-auto-review` source shipped in `0.2.2-rc.5` is
**byte-identical** to the `0.2.2-rc.3` snapshot this fork patches
(sha256 `72968d3c…`), and `@deepseek-ai/cordis` (4.1.0) and
`@deepseek-ai/schemastery` (3.19.0) did not move. Re-check both facts before
widening again for a future release.

Verified against the installed build with the runtime's own profile resolver:

```sh
DSH_HOME=<scratch-home> dsh --profile verify --dump-config-schema
```

Importing the fork's `lib/index.js` through a `link:` profile entry (which is
exactly what the app does at startup) now succeeds, and the dumped JSON Schema
contains the volatile `approvalTimeoutMinutes` field the plugin exports. Every
other runtime import (`BlockAssembler`, `deepFreeze`, `AUTO_PRESET`,
`RUN_CODE_NAME`, the schemastery default export) was checked to exist in the
installed packages.

## Layout

```
src/index.ts                 patched production source (real official code + six minimal patches)
src/locales.ts               verbatim upstream production source
types/                       trimmed 0.2.2-rc.3 ambient declarations + Node built-in shims for offline typecheck
upstream/dsh-v0.2.2-rc.3/    pristine upstream snapshot + SHA256SUMS
patches/0001-*.patch         Issue #3 denial-reason delta vs the pristine snapshot (frozen)
patches/0002-*.patch         Issue #5 human-response timeout delta, applied after 0001 (frozen)
patches/0003-*.patch         grant-versus-unload race fix, applied after 0002
patches/0004-*.patch         inlined `FiberState.ACTIVE` literal, applied after 0003 (frozen)
patches/0005-*.patch         full-auto reviewer-denial switch, applied after 0004 (frozen)
patches/0006-*.patch         Phase 1 deterministic rule gate, applied after 0005
tests/harness/               deterministic fake Cordis context / Session / tool pipeline
tests/stubs/                 test doubles for the six runtime @deepseek-ai imports
tests/denial-feedback.test.mjs    never-mode denial, failure, CoT and body-suppression tests
tests/ask-approval.test.mjs       approval mapping/audit/approval-mode/teardown tests
tests/approval-timeout.test.mjs   timeout config, deadline, late-answer, cancellation and cleanup tests
tests/unload-race.test.mjs        grant-versus-unload/caller-cancel race tests
tests/auto-deny.test.mjs          full-auto reviewer-denial setting tests
tests/rule-gate.test.mjs          Phase 1 mode, allow/deny catalog, fail-closed and record-privacy tests
scripts/make-patch.mjs       rebuilds 0003 from commit a25f516 and 0006 from the frozen 0001-0005 source (never rewrites frozen 0004/0005)
scripts/verify-upstream.mjs  offline provenance and ordered patch-reproduction checks
```

The upstream monorepo test suite is not vendored: it requires the full pnpm
workspace (`@deepseek-ai/dsh-agent-loop-testkit`, real `ToolRuntime`,
`ApprovalService`, `SessionStore`, …), which this standalone fork does not
install. The harness instead mirrors the relevant `ToolsPipeline.prepare()` /
`ApprovalService.request()` branches documented in its header and runs the real
production source (or the built `lib/` artifact) against them.

## Build and test

Requirements: Node.js ≥ 22.18 (native TypeScript stripping for the source
tests). The only devDependency is TypeScript 5.7.3. The package declares one
runtime peer, `@deepseek-ai/schemastery` (`~3.19.0`), for the Loader config
schema added by Issue #5. It must be a peer declaration, not a dependency: the
profile installs this package with a `link:` specifier, and a linked package's
own `dependencies` are not installed by pnpm, while the DSH runtime resolver
(`dsh-app-boot` `routeLinked`) only routes a bare import to the installation's
copy of a package when the linked importer lists it in `peerDependencies`. This
offline workflow does not install it at all: the tests resolve a local test
double and typecheck uses trimmed ambient declarations, so a real installation
resolves it from the DSH package tree (verified: the installation scope exposes
`@deepseek-ai/schemastery@3.19.0`).

### Offline dev-dependency bootstrap

The exact TypeScript 5.7.3 tarball is vendored at
`vendor/typescript-5.7.3.tgz` with its SHA-256 in `vendor/SHA256SUMS`
(see `vendor/README.md`). `scripts/bootstrap-offline-deps.mjs` verifies the
hash and installs it into this repository's own `node_modules` with
`npm install --offline --no-save --no-package-lock --ignore-scripts
--legacy-peer-deps`, so `tsc` resolves through `node_modules/.bin` exactly like
any normal npm project — no shell `PATH` setup, no registry access, no global
install, no external directory. `pretypecheck`, `prebuild` and `preverify` run
the bootstrap automatically, so an empty `node_modules` is not a blocker:

```sh
npm run bootstrap:offline  # optional explicit bootstrap (idempotent)
npm run typecheck          # tsc -p tsconfig.json --noEmit (trimmed ambient types)
npm test                   # run tests against src/ via Node's TypeScript stripping
npm run build              # emit lib/index.js + lib/locales.js (+ .d.ts)
npm run test:lib           # run the same tests against the built lib/ artifact
npm run check              # node --check on built JS and the verify script
npm run verify:upstream    # snapshot hashes; pristine + 0001..0006 == src/index.ts; 0001/0002/0003 == commits 56a0252/5972f49/a25f516; 0004/0005 frozen
npm run verify             # all of the above, from an empty node_modules
```

On a networked machine a plain `npm install` remains available; the vendored
tarball is only the deterministic offline path for the current no-install
verification environment.

Current status in this working tree: `typecheck` clean, 83/83 tests pass in
both source and `lib/` modes (21 Issue #3 + 21 Issue #5 + 4 grant/unload race +
11 full-auto denial + 26 rule gate), builds and syntax checks pass, 15/15
offline provenance checks pass (pristine + 0001 + 0002 + 0003 + 0004 + 0005 +
0006 reconstruct `src/index.ts` byte-for-byte, the stored patches still
reproduce the committed Issue #3 source at `56a0252`, Issue #5 source at
`5972f49` and grant/unload race fix at `a25f516`, and frozen patches 0004 and
0005 still produce their recorded sources), and `git diff --check` is clean.
This was re-verified from an empty `node_modules` in a plain shell with no `tsc`
on `PATH`: `npm run verify` bootstraps the vendored TypeScript offline and
completes in a few seconds, and `npm run typecheck` / `npm run build` work
standalone the same way.

### Coverage limits in this standalone fork

- The harness reproduces the native-call pre-execute path. The PTC-inner and
  out-of-process delegation paths share the patched `denied()`/approval code but
  their session-log validation is covered only by the upstream monorepo spec,
  which is not executed here (it requires the full pnpm workspace).
- `npm run typecheck` checks the production source against trimmed 0.2.2-rc.3
  ambient declarations (`types/`), not against the full monorepo type graph.
  The Loader delivery of a volatile `Config` is modeled with a local
  `schemastery` test double and trimmed declarations; real Loader config
  parsing/volatile update was not exercised without an install, and the runtime
  `@deepseek-ai/schemastery` peer is not installed by this no-install workflow
  (the DSH runtime supplies it from the installation scope).
- Human-response timeouts run against real timers but sub-second deadlines
  (fractional minutes such as `0.001` = 60 ms, bounded by a per-test timeout);
  no test waits for minutes, and no multi-minute wall-clock behavior is
  measured.
- Only the plugin's own direct approval question is timed; a downstream `ask`
  gate resolved by `ToolsPipeline`'s private `serviceAsk()` is out of scope (see
  the behavior section).
- The grant-versus-unload race tests model the real `Session.append()`
  synchronous observer notification with the fake Session's
  `observeAppends`; a real Session observer running a real plugin unload was not
  exercised without an install.
- The full-auto denial setting is tested through the standalone harness only.
  The GUI conclusion in [Where to configure the settings](#where-to-configure-the-settings)
  comes from the installed DSH documentation and packages (`dsh-client-ui-plugin-manager`,
  `dsh-settings`): no shipped Web client auto-generates a form from a bundle
  `Config` schema yet, and this Host-only fork ships no client page. A live
  Plugins/Settings UI and a real profile-patch write were not exercised here.
- The Phase 1 rule-gate tests cover the real `read`/`grep`/`glob`/metadata and
  `bash` argument shapes through the harness, including temp-workspace symlinks,
  but they do not exercise the real `read`/`grep`/`glob` tool bodies, a live
  Windows filesystem, or the default `~/.dsh/...` record path (tests always use
  an explicit temp path and never write `~/.dsh`). The deny hard floor is a
  text heuristic, not a shell parser; only the documented D1–D5 shapes are
  locked by tests.
- No live DSH route, real `ApprovalService` or real model was exercised: this
  task does not install the fork. Real-process verification belongs to the
  separate installation/verification workstream.

## Explicit non-goals of this task

- No changes to the official installed package, app.asar, current profile,
  `model-router`, the global `ApprovalService` or `ToolsPipeline`.
- No install, commit, or push.
- No human-reason input UI or approval-protocol extension; the reviewer's
  concise `decision.reason` is the only additional text forwarded.
- No timeout for approval questions this plugin does not ask itself (the
  pipeline's own downstream `ask` gate).
- No Client/Settings page for the Loader settings; this fork stays Host-only
  and its config is edited through the profile patch (see
  [Where to configure the settings](#where-to-configure-the-settings)).
- Phase 1 of the rule gate does not parse or allow shell commands, does not
  implement D4 (secret-exfiltration data flow), and does not attempt a general
  shell-safety model; read-only shell parsing is Phase 2.

## License

MIT, inherited from the upstream package; see [LICENSE](LICENSE).
