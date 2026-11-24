# Upstream provenance

This repository is an **unofficial standalone fork** of the official DSH
package `@deepseek-ai/dsh-experimental-auto-review`. It is not published and not
installed by this task.

## Exact upstream version

| Fact | Value |
| --- | --- |
| Repository | https://github.com/deepseek-ai/deepseek-harness |
| Git tag | `dsh-v0.2.2-rc.3` |
| Git commit | `38a6a5c965aa99ab525161efb7cc5cf1fe62fced` |
| Commit subject | `Merge pull request #8397 from deepseek-harness/worktree-release-dsh-0.2.2-rc.3` |
| Package path | `packages/experimental/auto-review` |
| Package version | `0.2.2-rc.3` |
| Installed DSH build | DeepSeek Harness `0.2.2-rc.3` (supplied by the current app.asar) |

## Captured snapshot

`upstream/dsh-v0.2.2-rc.3/` contains the pristine files needed to reproduce the
patch offline:

- `src/index.ts`, `src/locales.ts` — full production source;
- `package.json` — the **published/installed** variant (exact `0.2.2-rc.3`
  dependency pins; the monorepo checkout uses `workspace:*` instead, which is
  why this one file intentionally differs from the git tag);
- `cordis.patch.yml`, `icon.svg`, `LICENSE`, `locale/*.json`, `README.md`;
- `SHA256SUMS` — recorded hashes of every snapshot file.

The snapshot was captured read-only from the installed DSH build at
`app.asar/dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review` and then
verified file-by-file against the upstream git tag above: `src/index.ts`,
`src/locales.ts`, `cordis.patch.yml`, `README.md`, `README.*`, `icon.svg`,
`LICENSE`, `docs/` and all `locale/*.json` are byte-identical to the tag. Only
`package.json` differs, for the workspace `workspace:*` vs published pin reason
described above.

Recorded SHA-256 of the production source (also in `SHA256SUMS`):

```
72968d3c2a78818e6aeb73c799ef45f9ab2ce56b9814636f0619e8ee94890070  src/index.ts
4e25cd6742910bbbfcf07ff29844d06c7a5f5ee9f978985cc92a26287b31e4cc  src/locales.ts
```

## How to re-verify

Offline (no network, no install):

```sh
node scripts/verify-upstream.mjs
```

This checks the snapshot hashes, applies
`patches/0001-return-concise-reviewer-denial-reasons.patch`,
`patches/0002-add-human-approval-timeout.patch`,
`patches/0003-fix-approval-grant-unload-race.patch`,
`patches/0004-inline-fiber-state-active.patch`,
`patches/0005-add-auto-deny-reviewer-rejections.patch` and
`patches/0006-add-rule-gate-phase1.patch` to a pristine copy and
requires the result to be byte-identical to this repository's `src/index.ts`,
requires the stored patches to still reproduce the committed Issue #3 source
(`56a0252`), Issue #5 source (`5972f49`) and grant/unload race fix (`a25f516`),
requires the frozen patches 0004 and 0005 to keep producing their recorded
sources, verifies
the patches apply only in their committed order and touch only the production
source, and checks the packaging files that must mirror upstream.

Online, against the git tag:

```sh
git clone --filter=blob:none --sparse --depth 1 \
  --branch dsh-v0.2.2-rc.3 \
  https://github.com/deepseek-ai/deepseek-harness /tmp/deepseek-harness-0.2.2-rc.3
cd /tmp/deepseek-harness-0.2.2-rc.3
git sparse-checkout set packages/experimental/auto-review
shasum -a 256 packages/experimental/auto-review/src/index.ts \
  packages/experimental/auto-review/src/locales.ts
```

## Upstream tests (reference, not vendored)

The upstream test suite lives in the monorepo checkout, not in the published
package, and requires the full pnpm workspace. It is therefore not vendored
here; this fork keeps the production source equivalent and rebuilds a smaller
deterministic harness instead.

| Upstream file at `dsh-v0.2.2-rc.3` | Lines | Relevant rules |
| --- | --- | --- |
| `packages/experimental/auto-review/tests/auto-review.spec.ts` | 2083 | native/PTC review requests, decision protocol, never/ask denial behavior, cancellation, teardown |
| `packages/experimental/auto-review/tests/auto-review.e2e.ts` | 413 | real-route certification (opt-in) |
| `packages/experimental/auto-review/tests/fixtures/headless-reviewer.ts` | 44 | test reviewer adapter |

The upstream spec test that documents the pre-patch limitation is
`accepts only the six legal risk and decision forms without exposing risk` plus
`executes a reviewer-denied call only when the user answers <outcome> with a
grant`: they assert that a human rejection reaches the Agent only as
`the user rejected tool "probe"`, with the reviewer's concern retained solely in
the approval audit/UI (`approval/asked.reason`).

The upstream spec has no human-response-timeout, full-auto-denial or
deterministic-rule-gate coverage and expects no `Config` export from this
package: `approvalTimeoutMinutes`, `autoDenyReviewerRejections`, `ruleGate`,
`ruleGateLog`, the `AutoReviewApprovalTimeoutError` and
`AutoReviewRuleDeniedError` identities, `AUTO_REVIEW_APPROVAL_TIMEOUT` and
`AUTO_REVIEW_RULE_DENIED` are fork-only. The `@deepseek-ai/schemastery` **peer**
declaration added for the Loader schema names the same version upstream DSH
packages declare (the DSH installation supplies it at runtime), and it is not an
upstream Auto review peer declaration. The #0003 grant-versus-unload race fix,
the #0005 full-auto reviewer-denial switch and the #0006 Phase 1 rule gate also
have no upstream spec coverage; their regression tests live in
`tests/unload-race.test.mjs`, `tests/auto-deny.test.mjs` and
`tests/rule-gate.test.mjs`, and the race tests mirror the documented synchronous
`Session.append()` observer notification.
