# Parallel PR reviews

A reusable workflow: five native Codex specialists run in parallel, lower-effort Codex summarizes their findings, and a separate non-agent job publishes one Approve / Request changes review. Inference uses a ChatGPT/Codex subscription, not a third-party provider or API billing. With explicit opt-in, code merges approved low-risk changes after CI passes. Public thebytefarm repos only; no fixes. Release PRs require a human merge.

Publishing and automatic merging both default off. `publish: true` submits the review/status; additionally setting `auto-merge: true` enables the merge gate. Existing installed callers remain manual-only on the older engine until updated.

## Agents

| Agent       | Looks for                                                            | Codex effort |
| ----------- | -------------------------------------------------------------------- | ------------ |
| `bugs`      | Incorrect behavior, regressions, compatibility, meaningful test gaps | high         |
| `security`  | Broken trust boundaries, auth, injection, secrets, data exposure     | high         |
| `standards` | Violations of AGENTS.md and referenced standards, with citations     | high         |
| `design`    | Unnecessary complexity and poor boundaries; advisory only            | high         |
| `risk`      | Change impact and likelihood; low, medium, high, or critical         | high         |
| `verdict`   | Summarize and group findings; never decide approval                  | low          |

Each has a [separate prompt](./prompts/). Agents read applicable AGENTS.md files and referenced standards from the base checkout. Codex's managed sandbox allows read/search commands against permitted data, not filesystem writes or direct network access. Prompts forbid executing repository code, tests, or installers. These are native Codex tools, not the earlier custom read-tool loop.

## Per-repo config

Put **`.github/pull.yaml`** on the repo's base branch. Missing config inherits defaults. See [pull.example.yaml](./pull.example.yaml) for all fields.

```yaml
version: 1
instructions: Focus on backwards compatibility.
instructions-path: contributing/review.md
reviewers:
  bugs:
    instructions: Check deterministic sidebar ordering.
    instructions-path: contributing/review-bugs.md
  design:
    model: "" # Codex's default model for the connected subscription.
verdict:
  model: ""
limits:
  reviewer-timeout: 8m
  verdict-timeout: 90s
```

Overall instructions apply to all specialists; role-specific instructions add to them. Both inline text and a repo-relative file can be supplied. Config and additional prompt files are fetched at the captured **base SHA**, never from the PR head. Nonempty missing paths fail. Roles and approval rules are fixed; config cannot disable a specialist or change permissions.

YAML parsing uses the runner's existing `yq`. All roles use Codex's default model unless a native Codex model name is supplied. There is no third-party model catalog lookup or provider routing. Remove earlier `hf:...` model overrides when migrating; those are rejected. Model availability is verified by Codex under the connected subscription. Lower synthesis effort is not a guarantee of a different model or a specific usage reduction.

## Timeouts and decisions

- Specialists run simultaneously, capped at **8 minutes each**; the prompt reserves the final minute for output.
- Synthesis is capped at **90 seconds**, using lower Codex reasoning effort. Config may shorten either timeout.
- Job caps include setup: preparation 5 minutes, specialists 12 minutes, synthesis 5 minutes, publication/CI wait 35 minutes. Runner queues and provider limits add wall time. No automatic retries.
- New invocations for a PR cancel older ones.
- Tool schemas describe model output; code validates report/synthesis shapes, reviewer/commit identity, completeness, design's advisory-only constraint, standards citations, and preservation of every finding ID. Invalid output never approves.
- All five complete, valid synthesis, no blockers → **Approve**. Any blocker → **Request changes**. Missing/partial/failed results → **Incomplete**, never approval. Findings are inline diff threads, grouped by root cause and location. Comments are 2–3 short sentences, capped at 75 words/600 characters, without headings, specialist IDs, or duplicate evidence. Overlong comments fail validation rather than being truncated. Invalid/out-of-diff anchors fail publication rather than silently falling back to a timeline roll-up.

### Review presentation

The review opens with three SVG badges: **review verdict**, **risk level**, and **auto-merge policy**. These are static Shields.io images with descriptive alt text; only fixed status labels are sent to Shields.io, never repository names, source, findings, or credentials. No dependency or image upload is needed. Text below the badges reports the issue count, specialist completion, and merge restriction even if images fail to load.

Approval means no blocking defects were found—not that a change is low risk or eligible to merge. Elevated risk and detected release preparation show **human only**. A clean low-risk change shows **CI gate pending**, never a claim that CI passed or merging is enabled. The publisher independently rechecks release signals, current head/base, CI, and merge policy before merging.

Impact, likelihood, and rationale appear once in a collapsed **Why this risk level?** section, without a second model-written summary repeating them. Actions summaries use the same compact layout; full original evidence remains in a separate collapsed section in the artifact and Actions summary. Inline issue comments stay short and badge-free.

- Publication rechecks repository visibility and both PR SHAs. It writes `bytefarm/review` as success/failure/error after synthesis. A previous status is not evidence for merging: the gate requires this run's bound decision and current CI. Branch protection is not changed.

## Change risk and merge policy

The risk specialist explains **impact**, **likelihood**, and its rationale without a numeric score. See its [prompt](./prompts/risk.md) for examples of all four levels. Dependency update type informs the assessment but never decides it alone. Missing evidence must not become a low-risk assessment.

Approval and merge eligibility are separate: a medium/high/critical change without blocking defects can receive approval but still requires a human merge. Missing or invalid risk output makes the entire review incomplete.

The gate requires a complete approved review, low risk, unchanged base/head, an open non-draft PR, current independent passing CI, and GitHub's clean mergeability state. Pending, failed, cancelled, timed-out, missing, or entirely skipped CI cannot authorize a merge. Optional skipped/neutral checks are allowed alongside an actual success, matching GitHub's check semantics. Queued workflows also block. The current review's own check suite/status cannot count as CI.

Release titles/branches/labels, changelogs, prerelease configuration, release manifests, and package-version changes in package.json/Cargo.toml/pyproject.toml are conservative hard exclusions. Missing manifest patches and renamed/removed manifests also block merging. The risk agent independently flags release preparation even without those markers. These checks intentionally overblock; new release conventions must be added before rollout to a repo that uses them.

`publish.mts` waits up to 30 minutes for CI and branch rules, rechecking the PR and release signals. It merges immediately using the reviewed head SHA, never queues a future unconditional auto-merge, and never requests an admin bypass. A moved base/head requires a fresh review. GitHub's merge endpoint atomically checks the head SHA; the base is rechecked immediately before merging but cannot be atomically pinned through that endpoint. Keep strict up-to-date branch requirements where that race matters.

## Permission boundary

- **Preparation** has read-only GitHub access to obtain pinned base config and the current diff. It cannot mint a Pullfrog installation token.
- **Specialists and synthesis** use `agent.mts` to launch pinned native Codex CLI **0.166.0** (resolved from npm's latest stable version when this change was authored). There is no Pullfrog worker runtime or custom model HTTP loop.
- Each run gets a private temporary `CODEX_HOME` containing only a dedicated ChatGPT login and trusted config. Login files are mode 0600 and removed after the run; no local user login is loaded automatically. API-key fallback is rejected.
- A named Codex permission profile grants minimal system-runtime reads, the exact native Codex executable needed for Linux sandbox re-execution, and the explicit review inputs. It does not grant access to the executable's parent installation directory. It denies tool filesystem writes, network access, authentication home, Git metadata, `/proc`, and service sockets. Synthesis gets only the collected reports. Nested symlink targets must still satisfy the sandbox policy.
- Codex runs outside either checkout with automatic project-document loading disabled; prompts explicitly direct it to base-branch standards. No untrusted head config, rules, hooks, or home MCP configuration is loaded. The generated home has no MCP servers or plugins.
- The supervisor starts Codex as the runner UID with cleared supplementary groups/capabilities and `no_new_privs`. Its environment contains only PATH, HOME, CODEX_HOME, and LANG; model tools inherit no runner environment and receive only a fixed system PATH. No GitHub tokens, OIDC variables, provider API keys, or raw login JSON are forwarded. GNU timeout kills the Codex process group at the configured deadline. Failure never falls back to an unsandboxed mode.
- **Publication** is a separate job with no model invocation or model secret. Only it receives OIDC permission and obtains the Pullfrog installation token for reviews and merging. Commit statuses use its separate Actions token with `statuses: write`; preparation, specialists, and synthesis receive no status-write permission. Reusable callers must allow that permission ceiling.

```text
engine/                 # Pinned trusted supervisor; not granted to Codex tools
source/                 # Trusted base checkout; specialist read/search access
head/                   # Untrusted PR source; read-only review data
context/pr.diff         # Specialist input
context/reports.json    # The only synthesis-readable file
results/<role>.json     # Saved structured specialist outputs
context/decision.json   # Code-owned result passed to the publication job
```

The supervisor supplies an absolute workspace path; review paths resolve against it, not Codex's empty working directory. Synthesis cannot read source, diff, prompts, or engine code through its sandbox. The trusted CLI writes the schema-constrained final response outside tool permissions; output filenames come from trusted workflow code. There are hard execution time caps and no automatic retries.

The model can still produce incorrect findings or misjudge risk. The tool boundary prevents agent-side writes; it does not make model judgment a formal security proof. Never execute head code in these credentialed workflows.

## Installation

1. With explicit owner approval, create a **dedicated CI Codex login** using `codex login --device-auth` under a new, isolated `CODEX_HOME`. Complete ChatGPT sign-in, then securely store that home's native `auth.json` as the repository-accessible Actions secret **`CODEX_AUTH_JSON`**. Do not paste credentials into chat, copy your everyday local login, print tokens, or upload the auth directory as an artifact. No API key is required. Pullfrog remains installed only for the publisher's installation-token exchange.
2. Copy [caller.example.yml](./caller.example.yml) to the repo's `.github/workflows/pr-review.yml`. Call the central reusable workflow at **`@main`**; no tag or caller-side engine SHA is needed. Preparation reads the executing workflow's immutable SHA from GitHub's run metadata, and all jobs check out that same commit. Updates merged into central `main` apply to future runs everywhere without per-repo upgrade PRs. This intentionally trusts central `main` as executable workflow code. Keep the caller separate from the reusable engine's `pull-review.yml`, including in this repo.

   Keep the caller's explicit `fromJSON(github.event.inputs.pr-number)` conversion: manual dispatch can deliver numeric inputs as strings, and the reusable workflow requires a number. Without conversion, GitHub may fail the call before creating any jobs or logs.

3. Dispatch with `publish: false` first and verify actual inference, model routing, report completeness, and artifacts. Then verify publication without automatic merging. Only then enable `auto-merge: true` alongside `publish: true`.
4. Before automatic triggers, disable overlapping Pullfrog auto-review and existing Dependabot auto-merge rules: they could bypass this risk gate. Clear any previously queued auto-merges, especially release PRs. For automatic triggers use a trusted `pull_request_target` caller, not `pull_request`; handle opened/synchronize/reopened/ready_for_review and pass the event PR number. Do not execute PR code. This change does not enable those triggers automatically.

Hosted GitHub runners do not inherit your workstation's ChatGPT login. The subscription credential above is still needed, but it is not a new provider API key. Subscription limits apply. OAuth expiry/rotation, including parallel-job refresh behavior, must be tested before activation; refreshes in disposable homes are not written back to GitHub secrets. If sign-in expires or refresh fails, review stays incomplete until a new dedicated login is provisioned. This workflow does not implement a credential-refresh broker.

### Public repository callers

The earlier installation PRs below added manual-only callers on the old engine. A one-time migration changes their secret mapping, permission ceiling, dispatch conversion, and workflow reference to `@main`. Subsequent central engine fixes need no caller PRs. No automatic review or merge triggers are added here.

| Repository     | Installation PR                                            |
| -------------- | ---------------------------------------------------------- |
| `.github`      | [#4](https://github.com/thebytefarm/.github/pull/4)        |
| `ciderpress`   | [#208](https://github.com/thebytefarm/ciderpress/pull/208) |
| `bytefarm.dev` | [#4](https://github.com/thebytefarm/bytefarm.dev/pull/4)   |
| `almanac`      | [#30](https://github.com/thebytefarm/almanac/pull/30)      |
| `maltty`       | [#221](https://github.com/thebytefarm/maltty/pull/221)     |
| `farmall`      | [#2](https://github.com/thebytefarm/farmall/pull/2)        |
| `marxml`       | [#24](https://github.com/thebytefarm/marxml/pull/24)       |

Dedicated repository-scoped `CODEX_AUTH_JSON` secrets are provisioned in all seven public repos. Native Pullfrog auto-merge was disabled everywhere; ciderpress's overlapping native reviews and old Dependabot auto-merge workflow are now disabled, and marxml's queued installation auto-merge was cleared. No private repos or branch protection were changed. Caller migrations remain staged and manual-only; complete live review, synthesis, and review/status publication are verified. Inline publication and main-tracking execution still require live verification.

## Verification limits

Local tests cover subscription-only authentication, clean process environments, profile construction, CLI failure/cleanup, output validation, incomplete reviews, releases, CI gating, and collection/publication CLIs with transport fixtures. Native sandbox probes verify permitted reads and denied writes, credentials, symlink escapes, network, and synthesis source access without any login or inference. CI runs these probes with the pinned CLI on hosted Linux. [Live artifact-only verification](https://github.com/thebytefarm/almanac/actions/runs/41769949098) completed all five specialist reviews and lower-effort synthesis against almanac #31: Request changes, medium risk, with every finding preserved. [Publication verification](https://github.com/thebytefarm/almanac/actions/runs/41776103333) published the review and failing status successfully with auto-merge disabled. Inline publication, main-tracking execution, OAuth refresh behavior, merging, and downstream shipping remain unverified.

Artifacts contain public source/policy and last seven days. No secrets are committed or passed with blanket inheritance. Codex is version-pinned, and supervisor/config code uses the executing workflow SHA resolved once per run, even though callers track `main`. The token-exchange action remains separately SHA-pinned. Sandbox setup enables unprivileged user namespaces on disposable Ubuntu runners, matching Codex's hosted-Linux requirements; it must not be copied unchanged to shared self-hosted runners.

## Implementation

- [prepare.mts](./prepare.mts): fetch config/diff, resolve models, assemble prompts and matrix.
- [finish.mts](./finish.mts): check results, prepare synthesis, and render a code-owned decision without write credentials.
- [agent.mts](./agent.mts): isolated native Codex launcher, ChatGPT login validation, and read-only permission profile.
- [publish.mts](./publish.mts): isolated review/status writer and head-matched merge executor.
- [merge-policy.mts](./merge-policy.mts): risk/release safeguards and CI decisions.
- [schemas.mts](./schemas.mts): tool schemas and explicit output-shape assertions; no generic schema engine.
- Co-located tests cover approval, isolation, CI/release gating, and transport fixtures.

Run `pnpm test` and `actionlint .github/workflows/pull-review.yml review/caller.example.yml`; also run strict `tsgo`, `oxlint`, and `oxfmt`. With Codex installed, `CODEX_SANDBOX_TESTS=true node --test review/agent.test.mts` runs native probes without logging in or consuming inference. Runtime uses Node 24, pinned native Codex, and hosted Ubuntu's `sudo`, `setpriv`, `timeout`, `gh`, and `yq`. No application dependencies are installed or executed by the production review workflow.

For local prompt regression testing, see [review evals](./evals/README.md). `pnpm eval` runs Promptfoo through native Codex using an existing ChatGPT login; `pnpm eval --repeat 3` samples variability. There is no API-key requirement or automatic inference in CI.

References: [Codex CLI](https://github.com/openai/codex), [Codex permissions](https://developers.openai.com/codex/permissions), [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows).
