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
  waiting forever.

This repository is an **unofficial patch/fork**: it is not published and is
not installed in the running profile by this task. It is based
on the current DSH `0.2.2-rc.3` official source; exact upstream provenance is in
[UPSTREAM.md](UPSTREAM.md). The production delta is stored as three independent,
ordered patches:
`patches/0001-return-concise-reviewer-denial-reasons.patch` (Issue #3, frozen),
`patches/0002-add-human-approval-timeout.patch` (Issue #5, frozen), and
`patches/0003-fix-approval-grant-unload-race.patch` (grant/unload race fix).

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
  described in section 5. The approval audit pair is still written exactly once;
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

### 4. Minute-level human-response timeout (`approvalTimeoutMinutes`)

The fork adds one Loader config setting:

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

Configure it in the profile patch alongside the inserted plugin row:

```yaml
- id: auto-review
  name: "@deepseek-ai/dsh-experimental-auto-review"
  config:
    approvalTimeoutMinutes: 5
```

Scope limit: the deadline belongs to the plugin's own direct approval question.
A downstream `ask` gate produced by another pre-execute listener (after a
reviewer allow, or outside the reviewer-denial path) is still resolved by
`ToolsPipeline`'s private `serviceAsk()` and is **not** timed by this patch.

### 5. Grant-versus-unload race (final-review fix)

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
  and, when configured, the human-response deadline.

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

The #5 additions are fork-only as well: the official plugin exports no `Config`
schema, so `approvalTimeoutMinutes`, `AutoReviewApprovalTimeoutError` and
`AUTO_REVIEW_APPROVAL_TIMEOUT` have no upstream counterpart. This fork therefore
depends on `@deepseek-ai/schemastery` (`~3.19.0`, the version upstream DSH
packages declare) for its Loader config schema; official Auto review does not.
The upstream spec does not cover a human-response timeout at all, so the
regression tests in this repository are its only automated coverage.

The #0003 fix additionally relies on the documented `Session.append()` behavior
of notifying `session/event` observers synchronously after the log push; that is
what lets an observer unload the integration between the durable approval grant
and its mapping. If a future DSH release defers observer notification, revisit
the race window and its regression tests.

## Layout

```
src/index.ts                 patched production source (real official code + three minimal patches)
src/locales.ts               verbatim upstream production source
types/                       trimmed 0.2.2-rc.3 ambient declarations for offline typecheck
upstream/dsh-v0.2.2-rc.3/    pristine upstream snapshot + SHA256SUMS
patches/0001-*.patch         Issue #3 denial-reason delta vs the pristine snapshot (frozen)
patches/0002-*.patch         Issue #5 human-response timeout delta, applied after 0001 (frozen)
patches/0003-*.patch         grant-versus-unload race fix, applied after 0002
tests/harness/               deterministic fake Cordis context / Session / tool pipeline
tests/stubs/                 test doubles for the six runtime @deepseek-ai imports
tests/denial-feedback.test.mjs    never-mode denial, failure, CoT and body-suppression tests
tests/ask-approval.test.mjs       approval mapping/audit/approval-mode/teardown tests
tests/approval-timeout.test.mjs   timeout config, deadline, late-answer, cancellation and cleanup tests
tests/unload-race.test.mjs        grant-versus-unload/caller-cancel race tests
scripts/make-patch.mjs       regenerates patches/0003 from the pristine snapshot + frozen 0001/0002
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
runtime dependency, `@deepseek-ai/schemastery` (`~3.19.0`), for the Loader
config schema added by Issue #5. This offline workflow does not install it: the
tests resolve a local test double and typecheck uses trimmed ambient
declarations, so a real installation must resolve that dependency from the DSH
package tree or a registry.

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
npm run verify:upstream    # snapshot hashes; pristine + 0001 + 0002 + 0003 == src/index.ts; frozen 0001/0002 == commits 56a0252/5972f49
npm run verify             # all of the above, from an empty node_modules
```

On a networked machine a plain `npm install` remains available; the vendored
tarball is only the deterministic offline path for the current no-install
verification environment.

Current status in this working tree: `typecheck` clean, 46/46 tests pass in
both source and `lib/` modes (21 Issue #3 + 21 Issue #5 + 4 grant/unload race),
builds and syntax checks pass, 12/12 offline provenance checks pass (pristine +
0001 + 0002 + 0003 reconstruct `src/index.ts` byte-for-byte, and the frozen
patches still reproduce the committed Issue #3 source at `56a0252` and Issue #5
source at `5972f49`), and `git diff --check` is clean. This was re-verified from
an empty `node_modules` in a plain shell with no `tsc` on `PATH`: `npm run
verify` bootstraps the vendored TypeScript offline and completes in a few
seconds, and `npm run typecheck` / `npm run build` work standalone the same way.

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
  `@deepseek-ai/schemastery` dependency is not installed by this no-install
  workflow.
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

## License

MIT, inherited from the upstream package; see [LICENSE](LICENSE).
