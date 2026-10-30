# Parallel PR reviews

A reusable workflow: four Pullfrog specialists run in parallel, a cheaper model summarizes their findings, and code publishes one Approve / Request changes review. Public thebytefarm repos only; no fixes or auto-merge.

**Draft: not installed in any caller repo.** Publishing defaults off. A live ciderpress pilot is still required.

## Agents

| Agent       | Looks for                                                            | Default Synthetic model                   |
| ----------- | -------------------------------------------------------------------- | ----------------------------------------- |
| `bugs`      | Incorrect behavior, regressions, compatibility, meaningful test gaps | `hf:zai-org/GLM-5.3`                      |
| `security`  | Broken trust boundaries, auth, injection, secrets, data exposure     | `hf:zai-org/GLM-5.3`                      |
| `standards` | Violations of AGENTS.md and referenced standards, with citations     | `hf:deepseek-ai/DeepSeek-V4.1-Flash-1017` |
| `design`    | Unnecessary complexity and poor boundaries; advisory only            | `hf:zai-org/GLM-5.3-Flash`                |
| `verdict`   | Summarize and group findings; never decide approval                  | `hf:openai/gpt-oss-120b`                  |

Each has a [separate prompt](./prompts/). Agents always read applicable AGENTS.md files and referenced standards from the base checkout. There is no custom standards crawler. They inspect source and test code, but do not execute tests or install dependencies.

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
- Job caps include setup: preparation 5 minutes, specialists 12 minutes, final synthesis/publication 5 minutes. Runner queues and provider limits add wall time. No automatic retries.
- New invocations for a PR cancel older ones.
- Pullfrog validates the output schema. The small finishing script checks reviewer/commit identity, completeness, design's advisory-only constraint, standards citations, and preservation of every finding ID.
- All four complete, valid synthesis, no blockers → **Approve**. Any blocker → **Request changes**. Missing/partial/failed results → **Incomplete**, never approval. Original evidence stays in the review body, regardless of the summary.
- Publication rechecks repository visibility and both PR SHAs. It also writes `bytefarm/review` as pending then success/failure/error. Preparation failure or cancellation can leave it pending; rerun after investigation. Branch protection is not changed.

## Install after review

1. Ensure Pullfrog is installed, BYOK is configured, and the public caller repo has access to an Actions secret named `SYNTHETIC_API_KEY`.
2. Copy [caller.example.yml](./caller.example.yml) to the repo's `.github/workflows/pull-review.yml`. Replace **both** the reusable-workflow ref and `engine-ref` with the same reviewed central commit SHA. The second pin tells checkout where the shared prompts/scripts live—no custom OIDC bootstrap.
3. Start with manual dispatch and `publish: false`. Inspect model routing, prompts, artifacts, failure behavior, and latency on ciderpress before enabling publication or automatic triggers.
4. For eventual automation use a trusted `pull_request_target` caller, not `pull_request`. Disable overlapping Pullfrog auto-review and other native write automations. Do not execute PR code in this credentialed workflow.

Rollout scope: ciderpress, bytefarm.dev, almanac, .github, maltty, farmall, marxml. No private repo callers or live service settings have been changed.

## Known safety limit

**Pullfrog still exposes GitHub mutation tools to custom-workflow agents even with shell and pushes disabled.** Worker publication is prohibited by prompts, not an enforced tool boundary. `publish: false` disables our publisher, not every possible agent-service side effect. Resolve or verify output-only tool restrictions before enabling arbitrary public contributions. Also audit Pullfrog's service-side hooks and standing instructions; this workflow does not control them.

The agent cwd is the trusted base checkout; the head checkout is review data only. Prompts tell agents to ignore head-branch instructions, but this is not a formal prompt-injection boundary. Artifacts contain public source/policy and last seven days. No secrets are committed or passed with blanket inheritance.

## What code remains

- [prepare.mts](./prepare.mts): fetch config/diff, resolve models, assemble prompts and matrix.
- [finish.mts](./finish.mts): check results, prepare synthesis, compute verdict, optionally publish.
- [schemas.mts](./schemas.mts): schemas consumed by Pullfrog; no custom validator.
- [finish.test.mts](./finish.test.mts): focused tests for the approval safeguards.

Run `node --test review/*.test.mts` and `actionlint .github/workflows/pull-review.yml review/caller.example.yml`; also run strict `tsgo`, `oxlint`, and `oxfmt` checks. Runtime uses Node 24 plus the hosted Ubuntu runner's `gh`, `jq`, and `yq`; no package installs.

References: [Pullfrog custom workflows](https://docs.pullfrog.com/headless-action), [custom endpoints](https://docs.pullfrog.com/openai-compatible), [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows).
