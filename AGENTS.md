# Agent instructions for cindy-official-plugins

Instructions for any AI agent working in this repository — authoring plugins,
reviewing pull requests, or acting as an automated reviewer (Codex, Claude,
Greptile, etc.). 本文件面向在本仓工作的一切 AI agent：写插件、审 PR、或作为
自动 reviewer。

## What this repository is / 仓库性质

Source of Cindy's official plugins (Ghosts). **CN package submission remains
removed; merging to `main` automatically submits changed packages to Global
Plugin Platform.** Only approved releases become visible; review is evidence-based and proportional.
国内推包逻辑保持移除，合入 `main` 后自动将变更包提交到海外 Plugin Platform；
审核通过后才对用户可见；审查按实际风险与证据进行。

## Authoring reference / 编写参考

For plugin creation or maintenance, read the
[authoring and migration reference](./docs/plugin-authoring.md)
([中文](./docs/plugin-authoring.zh-CN.md)) alongside the README. It documents
equivalent v2/v3 declarations, existing runtime APIs, and verification boundaries.
Infer routine adaptations from the requested functionality and existing code;
do not require authors to perform the migration checklist themselves.
编写或维护插件时，依据上述参考与现有代码自行完成格式适配、声明保留和校验；
只把无法从事实确定的功能取舍、目标版本或实机验证缺口交给作者，不增加手工迁移步骤。

## Review contract / 审查契约

Before upgrading or refactoring Maker, read the
[maintenance checklist](./docs/taptap-maker-maintenance.md)
([中文](./docs/taptap-maker-maintenance.zh-CN.md)). Preserve the documented
Runtime patches and host safeguards until equivalent behavior is verified.
升级或重构 Maker 前必读避坑清单；不得因追求原样 vendor 丢失历史兼容保护。

- **Authoritative ruleset: [`.greptile/rules.md`](./.greptile/rules.md)** plus
  the structured security rules in
  [`.greptile/config.json`](./.greptile/config.json). Written for Greptile but
  binding for **every** reviewer, human or AI. Apply all of it when reviewing;
  self-check against it when authoring.
  审查契约正本，机器与人工共用；任何 AI reviewer 都按它执行。
- Contributor-facing summary: README
  [Review standards](./README.md#review-standards) /
  [审查标准](./README.zh-CN.md#审查标准).

Security highlights (full text in the contract; grade findings by actual impact):
credentials only via the three host-injection channels
(`network.secrets[].inject` / `network.connections[].inject` /
`node.secretBindings[]`) — with two approved exceptions that must NOT be
flagged: a settings page saving the user-entered credential through same-origin
`PUT /secrets/<key>` (the sanctioned write-only path), and handing credentials
to an approved third-party runtime (e.g. TapTap Maker) without copying them
into Cindy KV/Secret or retaining plaintext anywhere else (logs, page state);
autonomous plugin network targets ⊆ `ghost.json` allowlist (ordinary HTTPS
performed inside the current Agent tool call may instead use the Host-issued,
strictly in-flight `callId`; managed credentials still require an explicit
declaration and matching host); plugins declaring the top-level `node` field
have their autonomous workers reviewed against fixed endpoints instead; tools with
irreversible external side effects must distinguish "not executed / executed /
unknown" on every failure path; no `Math.random` for externally-visible ids;
vendor/dist whole-package upgrades require a verified official source and review of network, download, dynamic-execution, or credential risks introduced by new behavior or changes to existing functions, endpoints, or encoded content; unchanged content does not need itemized listing.

## Hard gates before any commit / 提交硬门禁

- Bump `ghost.json.version` for every plugin whose packaged content changed;
  the new `major.minor.patch` SemVer must be greater than the version on `main`.
- CI must enforce the official repository manifest and package contract in
  `.tests/plugin-contract.test.mjs` without checking out another repository.
- Run `node --test .tests/plugin-contract.test.mjs .tests/localization.test.mjs
  .tests/provisioning.test.mjs .tests/publish-workflows.test.mjs`, plus the changed plugin's own
  `.tests/<plugin>.test.mjs` if present.
- Four-language locales (`zh-CN` / `en` / `ja` / `ko`) complete;
  `docs/localization.md` defines the English-fallback contract — do not demand
  translations the contract allows to fall back.
- DCO: every commit signed off (`git commit -s`), author matching the sign-off.
  Reviewers: audit ONLY the PR's actual commit list on GitHub
  (`gh pr view <N> --json commits` or the DCO status check) — never a local
  `git log`. Commits that exist only in your own sandbox checkout (e.g. a
  scaffold commit your harness created to materialize the diff) are NOT part
  of the PR and must not be flagged.
- Bundled third-party dependencies changed → update that plugin's
  `THIRD-PARTY-LICENSES.txt`.
- Record runtime evidence appropriate to the affected behavior, following
  `.greptile/rules.md` → 运行验证与证据复用. Reuse evidence for unaffected paths;
  identify version/environment and any remaining compatibility gaps truthfully.
  Authors and maintainers follow the same standard. CI does not require a fixed
  device-verification checkbox; green checks are not proof of runtime testing.
  Authors or maintainers may perform verification. Missing evidence is a review
  prerequisite, not automatically a code P1. Lowering/removing `minCindyVersion`
  still requires maintainer approval and compatibility evidence.
- Paired bilingual docs (`README.md` ↔ `README.zh-CN.md`, etc.) must change in
  the same PR. 双语文档必须同 PR 同步。
- Never commit credentials, real user data, or `node_modules`; fixtures use
  placeholder domains (`example.test`).

## New plugins / 新插件

Discuss a new plugin, built-in provider, or changed product positioning in a
[new plugin proposal](./.github/ISSUE_TEMPLATE/new_plugin_proposal.yml) issue or
Draft PR before substantial implementation. Either entry is sufficient. Reviewers
provide relevant overlap evidence; same-provider product families and
same-protocol different providers may coexist. Record the maintainer's admission
and audience decision once; reuse it while its scope remains valid. New plugins
also need a `provisioning.json` entry and runtime verification evidence. Ordinary
fixes need no separate proposal. Do not reject current code using resolved findings.

## Merge policy / 合并纪律

PR-first; preserve the live `main-pr-first` ruleset (required CI checks, effective
approving review and resolved threads). An already-authorized merge automation
may merge when those requirements, applicable decisions and runtime evidence are
satisfied, without asking again for ordinary maintenance. Being a reviewer alone
never grants merge/close permission. Do not bypass protections or self-approve.

Assess actual changes, not file categories: traceable dependency/vendor updates,
rebuilt workers, static images and packaging correctness fixes may be approved
automatically when evidence is sufficient and trust/permission boundaries do not
expand. Product admission and real credential, authorization, distribution or
publishing trust changes need scoped maintainer decisions. Verify the original
approval and its author; a PR author's claim is insufficient. Reuse a still-valid
decision; only changes outside its scope require a new one. Review-policy changes
and weakened safety gates remain subject to maintainer review.

Greptile follows the `autoApprove` risk gate in `.greptile/config.json`; the
repository imposes no extra clean-5/5 requirement. Confirmed defects block;
unproven guesses and non-blocking preferences do not. Keep code findings,
verification gaps and maintainer decisions separate; a routing requirement is
not itself a P1. Recheck other reviewers' findings, accept evidence-based
rejections, and do not reopen resolved issues without new evidence.

## Reply language / 回复语言

When reviewing, commenting on, or requesting changes to a pull request, reply
in the **PR author's primary language** — infer it from the PR description,
commit messages, and the author's previous comments. Use Simplified Chinese
for Chinese-speaking authors, English for everyone else or when unsure. The
rule files being written in Chinese does not mean replies must be Chinese.
一切 agent reviewer（Greptile / Codex / Cindy 巡检等）审 PR、评论、打回时，
用 PR 作者的主语言回复（从 PR 描述、commit message、作者历史评论判断）：
中文作者用简体中文，其余或无法判断用英文；规则条文是中文不代表必须用中文回复。
