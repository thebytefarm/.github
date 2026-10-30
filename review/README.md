# Parallel PR reviews

One reusable GitHub Actions workflow, four independent Pullfrog specialists, one cheaper synthesis step, and one deterministic publisher. Public thebytefarm repositories only. No auto-fixes or auto-merge.

**Status: reviewable draft, not enabled in any caller repo.** The central workflow has only a `workflow_call` trigger. The caller template is manual and publishing defaults to false. Model quality, latency, Pullfrog OIDC in reusable workflows, and publication still need a live ciderpress pilot.

## Flow

```text
Trusted workflow revision + base-branch .github/pull.yaml
                         |
              Config / policy / diff preparation
                         |
          +--------------+--------------+--------------+
          |              |              |              |
         bugs         security       standards       design
          |              |              |              |
          +--------------+--------------+--------------+
                         |
              Schema-validated JSON artifacts
                         |
                verdict: group + summarize
                         |
             Code: validate + decide + publish
```

Specialists split by concern, not files. Each reads the full diff and relevant surrounding source. The `verdict` agent cannot remove findings, invent findings, or select an approval event.

| Agent       | Assignment                                                             | Default Synthetic model ID                |
| ----------- | ---------------------------------------------------------------------- | ----------------------------------------- |
| `bugs`      | Correctness, regressions, compatibility, concrete behavioral test gaps | `hf:zai-org/GLM-5.3`                      |
| `security`  | Trust boundaries, auth, injection, secrets, data exposure, CI safety   | `hf:zai-org/GLM-5.3`                      |
| `standards` | Explicit repository rules, with document citations                     | `hf:deepseek-ai/DeepSeek-V4.1-Flash-1017` |
| `design`    | Actionable simplification and architectural feedback; advisory only    | `hf:zai-org/GLM-5.3-Flash`                |
| `verdict`   | Deduplicate by grouping IDs and write the summary                      | `hf:openai/gpt-oss-120b`                  |

These are proposed starting assignments, not benchmark results. Exact IDs and limits are recorded in [models.json](./models.json), sourced from [Synthetic's live catalog](https://api.synthetic.new/openai/v1/models). Preparation verifies the selected IDs still exist; unknown models fail instead of falling back. Updating the allowlist is a central, reviewed change.

## Per-repository configuration

Put configuration at **`.github/pull.yaml`** in the caller repository. See [pull.example.yaml](./pull.example.yaml) for every field. Minimal configuration:

```yaml
version: 1
```

Example overrides:

```yaml
version: 1

instructions: |
  Focus on backwards compatibility for existing user configurations.
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

- All keys except `version` are optional. A missing config file uses central defaults.
- Overall instructions apply to all four specialists; per-role additions apply only to that role. Both inline text and a file can be supplied. They do not customize the synthesizer's policy.
- Paths are relative to the caller repository root. Empty paths mean no extra file. A nonempty missing path, symlink, unknown key, duplicate YAML key, wrong type, or unsupported model fails clearly.
- No role can be disabled. Permissions, schema, public-only guard, and verdict rules are not configurable.
- The config, extra prompt files, and policies come from the captured **base SHA**, never from the proposed PR contents. Changes to review configuration take effect after merge.

### AGENTS.md and standards

Applicable `AGENTS.md` files load independently of custom instructions: root policy plus ancestor-directory policies for changed paths, including previous paths for renames. Their explicitly referenced local Markdown files are bundled recursively. Missing references fail preparation instead of weakening the standards review.

The loader understands single Markdown paths in backticks and Markdown links, resolving repository-root paths first, then paths relative to the referencing document. Remote links are not fetched as policy. Parent traversal, globs, and directory-only references are not expanded; link explicit in-repo documents instead. Policy bundles are capped at 60 documents / 240 KB. Repositories without any applicable AGENTS.md are explicitly reported as having no such policy; none is invented.

Repository-specific additions supplement central policy. They cannot authorize writes, remove blockers, or override review deadlines. As with any prompt-based policy, this hierarchy is guidance, not a formal prompt-injection boundary.

## Timing

- Four specialists run concurrently with `fail-fast: false`.
- Each has an **8-minute action timeout**. The prompt reserves the final minute for structured output; shorter budgets can be configured down to 60 seconds.
- Synthesis has a **90-second action timeout**; configurable down to 30 seconds, with 20 seconds reserved for output.
- Job-level caps are preparation 5 minutes, specialist 12 minutes including setup, synthesis 4 minutes, publisher 3 minutes.
- A newer workflow invocation for the same PR cancels the older invocation. There are no automatic retries or unlimited verification loops.
- These are execution caps, not an end-to-end wall-clock guarantee: runner queues, setup, artifact transfers, and provider limits add time. Four jobs also share provider rate limits; parallelism does not guarantee fourfold speed.

The prompt tells agents to submit a partial result before the deadline rather than pretending to finish. Missing output, malformed JSON, partial work, or a failed job cannot yield approval. Agents inspect test source but do not execute tests or install dependencies.

## Findings and verdicts

Each specialist must produce the schema from [schemas.mts](./schemas.mts): head SHA, role, complete/partial status, limitations, and findings with stable role-prefixed IDs, location, severity, evidence, a blocking flag, and a standards citation when applicable. Outputs are validated by Pullfrog and then independently by the central scripts.

The synthesis schema contains only summary and groups of existing finding IDs. Every input ID must appear exactly once. The publisher renders all original evidence under those groups, so a cheap model's optimistic summary cannot hide a blocker. A model disagreement remains visible for human resolution; there is no majority vote.

| Condition                                                         | Review                          | `bytefarm/review` status   |
| ----------------------------------------------------------------- | ------------------------------- | -------------------------- |
| Four complete specialists, valid synthesis, no blockers           | Approve                         | Success                    |
| Four complete specialists, valid synthesis, any blocker           | Request changes                 | Failure                    |
| Missing, failed, partial, invalid, or inconsistent output         | Incomplete comment; no approval | Error                      |
| Repo becomes private, PR closes/becomes draft, or base/head moves | Do not publish stale results    | No success for the old run |

Design feedback never blocks. The standards reviewer owns explicit architectural requirements. Findings are currently rendered in the review body, not individual inline threads. Status checks are not required for merging unless you separately add `bytefarm/review` to branch protection; this workflow does not change protection rules.

When publishing is enabled, the captured head gets a pending status before preparation continues. Preparation failures or cancelled runs can leave it pending; investigate and rerun. API failures also fail the job rather than produce approval. Reviews specify the reviewed commit, and publication rechecks the PR immediately before writing. GitHub's stale-approval protection is still recommended to close races with pushes.

## Security limits to review before activation

**The worker action does not enforce an output-only GitHub permission boundary.** Pullfrog's custom action obtains its own App token through OIDC and exposes review/comment tools independently of `GITHUB_TOKEN`. `push: disabled` and `shell: disabled` prevent code pushes and shell use, but do not remove all GitHub mutation tools. Our prompts prohibit worker publication; the action API does not currently make that prohibition a hard guarantee.

Consequently, `publish: false` means **the central publisher** does not write; it is not a promise of zero side effects from the underlying agent service. Do not treat this draft as hardened for arbitrary public contributions until output-only tool restrictions are verified or implemented upstream. Disabling extra worker tools needs an enforced harness feature, not a more forceful prompt.

Additional considerations:

- Only run the engine through a trusted `workflow_dispatch` or, after review, `pull_request_target` caller. Never run a secret-bearing caller from `pull_request` or check out PR workflow code as executable tooling.
- The engine checks out its own exact called-workflow revision, resolved from GitHub-issued OIDC `job_workflow_sha`. It does not accidentally run scripts from the caller or a floating central branch.
- The caller's base and head are separate checkouts with persisted credentials disabled. Engine steps never execute either repository's source, package scripts, or tests. The agent's working directory is the trusted base checkout, not the head checkout. Untrusted file contents and model findings can still contain prompt injection; the prompts explicitly treat them as data, which reduces but does not eliminate that risk.
- Pullfrog can auto-load its own standing instructions, setup hooks, modes, or head-directory instruction files. Inspect and disable conflicting automation/hooks for the pilot. The local workflow alone cannot certify those service-side settings.
- Only the final publishing step explicitly requests a Pullfrog installation token for posting the final review; the earlier preparation step requests one for the pending status. Agent steps separately acquire service credentials as described above.
- The publisher runs fresh central code and consumes only data artifacts from this workflow run; it never checks out PR source. It revalidates all findings and synthesis and checks all upstream job results.
- Artifacts contain public source diffs, policy, and findings, are retained seven days, and must not contain credentials. Only the Synthetic key is explicitly forwarded to agent steps; no blanket `secrets: inherit`.
- Central workflows/actions are pinned. The supplied caller must also be pinned to a reviewed central SHA. Configuration cannot redirect the provider endpoint.

## Installation and pilot

1. Review this central implementation and the safety limits above. Merge only after the remaining integration questions are settled.
2. Verify the Pullfrog App installation and BYOK configuration for ciderpress. Supply a Synthetic key as the caller's `SYNTHETIC_API_KEY` Actions secret (or an org secret restricted to the participating public repos). No key is committed here. Existing secret availability has not been verified.
3. Audit Pullfrog's standing instructions, hooks, run/approval checks, and automations. Disable overlapping native auto-review, auto-address-review, issue/label automation, auto-fix CI, and auto-merge as appropriate for review-only operation. No service settings have been changed by this draft.
4. Copy [caller.example.yml](./caller.example.yml) to ciderpress's `.github/workflows/pull-review.yml`; replace `REPLACE_WITH_ENGINE_COMMIT_SHA` with the reviewed central commit SHA. Keep it manual and `publish: false` first.
5. Optionally copy [pull.example.yaml](./pull.example.yaml) to `.github/pull.yaml`, or omit it to inherit defaults. Policy/config must already exist on the PR base branch to apply.
6. Run on a small known PR. Verify each resolved model in logs, role prompts, deadline behavior, output validation, and artifact isolation. Test a known blocker, an advisory-only PR, and a forced failure. Output-only worker tool restrictions remain a release gate for untrusted PRs.
7. Once the safety gate and pilot pass, run with `publish: true` to verify Pullfrog identity, one review, and the commit status. Only then enable automatic triggers and roll out.

For eventual auto-review, replace the manual-only caller trigger with `pull_request_target` for `opened`, `synchronize`, `reopened`, and `ready_for_review`. Pass `github.event.pull_request.number`, skip drafts, and set `publish: true` only after the pilot. Do not reuse this engine's concurrency-group name in the caller.

Current public rollout scope: **ciderpress, bytefarm.dev, almanac, .github, maltty, farmall, marxml**. Private repos receive no caller, and the engine rejects private repos at preparation and again before publication. Existing native automation on private repos has not been audited or changed.

## Local validation

The implementation uses Node 24's built-in TypeScript execution, Node's test runner, and Ruby/Psych for safe YAML decoding. No new npm dependencies, lockfiles, or installed CLI are needed at runtime.

```sh
node --test review/*.test.mts
node review/cli.mts validate-config review/pull.example.yaml
ruby -c review/yaml-to-json.rb
actionlint .github/workflows/pull-review.yml review/caller.example.yml
```

Also run `tsgo` (strict, NodeNext, no emit, Node types), `oxlint review`, and `oxfmt --check README.md review .github/workflows/pull-review.yml` using your installed OXC toolchain. A live Pullfrog run is a separate integration check; passing local tests does not validate service authentication or model quality.

## References

- [Pullfrog custom workflow action, schemas and timeouts](https://docs.pullfrog.com/headless-action)
- [Pullfrog OpenAI-compatible endpoint configuration](https://docs.pullfrog.com/openai-compatible)
- [Pullfrog token helper](https://github.com/pullfrog/pullfrog/tree/8302038bc7ab13f579cfef4bad72941b87f8c1c5/get-installation-token)
- [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows)
- [GitHub OIDC with reusable workflows](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-with-reusable-workflows)
