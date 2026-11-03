# Parallel PR reviews

A reusable workflow: five read-only specialists run in parallel, a cheaper model summarizes their findings, and a separate non-agent job publishes one Approve / Request changes review. With explicit opt-in, code merges approved low-risk changes after CI passes. Public thebytefarm repos only; no fixes. Release PRs require a human merge.

Publishing and automatic merging both default off. `publish: true` submits the review/status; additionally setting `auto-merge: true` enables the merge gate. Existing installed callers remain manual-only on the older engine until updated.

## Agents

| Agent       | Looks for                                                            | Default Synthetic model                   |
| ----------- | -------------------------------------------------------------------- | ----------------------------------------- |
| `bugs`      | Incorrect behavior, regressions, compatibility, meaningful test gaps | `hf:zai-org/GLM-5.3`                      |
| `security`  | Broken trust boundaries, auth, injection, secrets, data exposure     | `hf:zai-org/GLM-5.3`                      |
| `standards` | Violations of AGENTS.md and referenced standards, with citations     | `hf:deepseek-ai/DeepSeek-V4.1-Flash-1017` |
| `design`    | Unnecessary complexity and poor boundaries; advisory only            | `hf:zai-org/GLM-5.3-Flash`                |
| `risk`      | Change impact and likelihood; low, medium, high, or critical         | `hf:zai-org/GLM-5.3`                      |
| `verdict`   | Summarize and group findings; never decide approval                  | `hf:openai/gpt-oss-120b`                  |

Each has a [separate prompt](./prompts/). Agents read applicable AGENTS.md files and referenced standards from the base checkout. They inspect source and test code, but cannot execute commands, install dependencies, or access GitHub tools.

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
    model: hf:zai-org/GLM-5.3-Flash
verdict:
  model: hf:openai/gpt-oss-120b
limits:
  reviewer-timeout: 8m
  verdict-timeout: 90s
```

Overall instructions apply to all specialists; role-specific instructions add to them. Both inline text and a repo-relative file can be supplied. Config and additional prompt files are fetched at the captured **base SHA**, never from the PR head. Nonempty missing paths fail. Roles and approval rules are fixed; config cannot disable a specialist or change permissions.

YAML parsing uses the runner's existing `yq`. Synthetic model IDs and token limits come from its [live catalog](https://api.synthetic.new/openai/v1/models), not a maintained model registry. Unknown model IDs fail. These assignments have not been benchmarked.

## Timeouts and decisions

- Specialists run simultaneously, capped at **8 minutes each**; the prompt reserves the final minute for output.
- Synthesis is capped at **90 seconds**, on the explicitly selected cheaper model. Config may shorten either timeout.
- Job caps include setup: preparation 5 minutes, specialists 12 minutes, synthesis 5 minutes, publication/CI wait 35 minutes. Runner queues and provider limits add wall time. No automatic retries.
- New invocations for a PR cancel older ones.
- Tool schemas describe model output; code validates report/synthesis shapes, reviewer/commit identity, completeness, design's advisory-only constraint, standards citations, and preservation of every finding ID. Invalid output never approves.
- All five complete, valid synthesis, no blockers → **Approve**. Any blocker → **Request changes**. Missing/partial/failed results → **Incomplete**, never approval. Original evidence stays in the review body, regardless of the summary.
- Publication rechecks repository visibility and both PR SHAs. It writes `bytefarm/review` as success/failure/error after synthesis. A previous status is not evidence for merging: the gate requires this run's bound decision and current CI. Branch protection is not changed.

## Change risk and merge policy

The risk specialist explains **impact**, **likelihood**, and its rationale without a numeric score. See its [prompt](./prompts/risk.md) for examples of all four levels. Dependency update type informs the assessment but never decides it alone. Missing evidence must not become a low-risk assessment.

Approval and merge eligibility are separate: a medium/high/critical change without blocking defects can receive approval but still requires a human merge. Missing or invalid risk output makes the entire review incomplete.

The gate requires a complete approved review, low risk, unchanged base/head, an open non-draft PR, current independent passing CI, and GitHub's clean mergeability state. Pending, failed, cancelled, timed-out, missing, or entirely skipped CI cannot authorize a merge. Optional skipped/neutral checks are allowed alongside an actual success, matching GitHub's check semantics. Queued workflows also block. The current review's own check suite/status cannot count as CI.

Release titles/branches/labels, changelogs, prerelease configuration, release manifests, and package-version changes in package.json/Cargo.toml/pyproject.toml are conservative hard exclusions. Missing manifest patches and renamed/removed manifests also block merging. The risk agent independently flags release preparation even without those markers. These checks intentionally overblock; new release conventions must be added before rollout to a repo that uses them.

`publish.mts` waits up to 30 minutes for CI and branch rules, rechecking the PR and release signals. It merges immediately using the reviewed head SHA, never queues a future unconditional auto-merge, and never requests an admin bypass. A moved base/head requires a fresh review. GitHub's merge endpoint atomically checks the head SHA; the base is rechecked immediately before merging but cannot be atomically pinned through that endpoint. Keep strict up-to-date branch requirements where that race matters.

## Permission boundary

- **Preparation** has read-only GitHub access to obtain pinned base config and the current diff. It cannot mint a Pullfrog installation token.
- **Specialists and synthesis** use `agent.mts`, a dependency-free tool loop calling the fixed Synthetic chat-completions endpoint. They receive the model credential but no installation token or OIDC permission. No Pullfrog agent runtime is loaded.
- The only model tools are bounded local `read_file`, `list_files`, `search_text`, and `set_output`. Read tools resolve real paths and deny Git metadata, credentials, and symlink escapes. They cannot execute shell commands, write files, inspect environment variables, call arbitrary URLs, or mutate GitHub.
- **Publication** is a separate job with no model invocation or model secret. Only it receives OIDC permission and obtains the Pullfrog installation token for review/status publication and merging.

```text
engine/                 # Pinned trusted runtime; not readable through model tools
source/                 # Trusted base checkout; specialist read tools
head/                   # Untrusted PR source; specialist read tools only
context/pr.diff         # Specialist input; paginated reads
context/reports.json    # The only synthesis-readable file
results/<role>.json     # Saved structured specialist outputs
context/decision.json   # Code-owned result passed to the publication job
```

Tool paths are workspace-relative, not relative to a Git checkout. Synthesis cannot read source, diff, prompts, or engine code through its tools. Output filenames are selected by trusted workflow code, never model arguments. Model calls have time, turn, and context caps; no silent conversation truncation or automatic retry.

The model can still produce incorrect findings or misjudge risk. The tool boundary prevents agent-side writes; it does not make model judgment a formal security proof. Never execute head code in these credentialed workflows.

## Installation

1. Give the public caller repo access to an Actions secret named `SYNTHETIC_API_KEY`. Pullfrog must be installed for the publication job's installation-token exchange; worker inference calls Synthetic directly and does not use Pullfrog BYOK.
2. Copy [caller.example.yml](./caller.example.yml) to the repo's `.github/workflows/pr-review.yml`. Replace **both** the reusable-workflow ref and `engine-ref` with the same reviewed central commit SHA. The second pin tells checkout where the shared prompts/scripts live—no custom OIDC bootstrap. Keep the caller separate from the reusable engine's `pull-review.yml`, including in this repo.
3. Dispatch with `publish: false` first and verify actual inference, model routing, report completeness, and artifacts. Then verify publication without automatic merging. Only then enable `auto-merge: true` alongside `publish: true`.
4. Before automatic triggers, disable overlapping Pullfrog auto-review and existing Dependabot auto-merge rules: they could bypass this risk gate. Clear any previously queued auto-merges, especially release PRs. For automatic triggers use a trusted `pull_request_target` caller, not `pull_request`; handle opened/synchronize/reopened/ready_for_review and pass the event PR number. Do not execute PR code. This change does not enable those triggers automatically.

### Public repository callers

Each caller is manual-only and pins both central refs to `e1ba85a421032865ae326526880a997c78cd4576`. Caller PRs install the entry point; they do not enable automatic PR reviews. The workflow becomes available for manual dispatch after its caller is merged onto the default branch.

| Repository     | Installation PR                                            |
| -------------- | ---------------------------------------------------------- |
| `.github`      | [#4](https://github.com/thebytefarm/.github/pull/4)        |
| `ciderpress`   | [#208](https://github.com/thebytefarm/ciderpress/pull/208) |
| `bytefarm.dev` | [#4](https://github.com/thebytefarm/bytefarm.dev/pull/4)   |
| `almanac`      | [#30](https://github.com/thebytefarm/almanac/pull/30)      |
| `maltty`       | [#221](https://github.com/thebytefarm/maltty/pull/221)     |
| `farmall`      | [#2](https://github.com/thebytefarm/farmall/pull/2)        |
| `marxml`       | [#24](https://github.com/thebytefarm/marxml/pull/24)       |

No private repo callers, branch protection, or live Pullfrog service settings have been changed. The earlier installation PRs do not deploy this risk/merge extension. Repository and accessible organization-secret listings showed no `SYNTHETIC_API_KEY` in these seven repos; activation remains blocked until credentials are supplied and live execution is verified.

## Verification limits

Local tests cover tool isolation, symlink/metadata denials, output validation, incomplete reviews, release exclusions, CI gating, and real collection/publication CLI execution with transport fixtures. They do not prove real provider/tool-call compatibility or installation-token exchange. Live inference, publication, merging, and downstream shipping have not been verified. Pullfrog service-side hooks/settings are separate and must be audited before activation.

Artifacts contain public source/policy and last seven days. No secrets are committed or passed with blanket inheritance. The runner and API endpoint are pinned by the central engine SHA; the floating Pullfrog worker download is no longer part of inference. The token-exchange action remains separately SHA-pinned.

## Implementation

- [prepare.mts](./prepare.mts): fetch config/diff, resolve models, assemble prompts and matrix.
- [finish.mts](./finish.mts): check results, prepare synthesis, and render a code-owned decision without write credentials.
- [agent.mts](./agent.mts): read-only local tools and timeboxed Synthetic inference.
- [publish.mts](./publish.mts): isolated review/status writer and head-matched merge executor.
- [merge-policy.mts](./merge-policy.mts): risk/release safeguards and CI decisions.
- [schemas.mts](./schemas.mts): tool schemas and explicit output-shape assertions; no generic schema engine.
- Co-located tests cover approval, isolation, CI/release gating, and transport fixtures.

Run `node --test review/*.test.mts` and `actionlint .github/workflows/pull-review.yml review/caller.example.yml`; also run strict `tsgo`, `oxlint`, and `oxfmt` checks. Runtime uses Node 24 plus the hosted Ubuntu runner's `gh`, `git`, and `yq`; no package installs.

References: [Synthetic chat completions](https://dev.synthetic.new/docs/openai/chat-completions), [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows).
