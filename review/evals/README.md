# Local review evals

Run from the repository root with Node 24+ and native Codex installed:

```sh
pnpm install
codex login status
pnpm eval
pnpm eval --repeat 3
pnpm eval --filter-pattern 'duplicate|exception'
pnpm eval:view
```

The repo records the approved `esbuild` install script in `pnpm-workspace.yaml`; a normal `pnpm install` should not require an interactive build approval. Promptfoo is development-only and is not installed in production review jobs.

Codex must already have a ChatGPT login. The adapter uses that existing local login without reading, copying, printing, or uploading its credentials. There is no API-key fallback or paid model grader. Inference consumes subscription usage. Review fixtures are synthetic, not customer source. Sharing and telemetry are disabled by the eval command; results stay local. No inference is run by ordinary CI or `pnpm test`.

The nine cases cover a real install defect, a clean dependency update, mandatory policy, an explicit policy exception, prompt injection concealing an authorization bug, low/elevated risk, release identification, and duplicate report synthesis. Deterministic assertions check expected defects, false positives, anchors, severity, policy citations, risk, release exclusion, finding preservation, and rendered comment length. They are targeted regression checks, not a general proof of review correctness. Review repeated runs for false positives and missed defects; do not weaken the cases just to get green.

The provider uses the **shipped prompts and output schemas**. Synthesis cases also execute the real `finish.mts` renderer. Expected answers are kept outside the model's fixture workspace. Each call creates and removes an isolated synthetic checkout. Native Codex runs read-only, with user configuration/rules and web search disabled, no inherited API/GitHub credentials, and a deadline. This portable local harness is not a reproduction of the production Linux supervisor's stronger filesystem restrictions.

`cases.mjs` holds the snapshots and expectations; `provider.mjs` runs Codex; `grade.mjs` evaluates the result. Add a minimal fixture for each real false positive or missed defect before tuning prompts. Results from `pnpm eval` appear in the local Promptfoo viewer. Use `--output review/evals/results/run.json` for a gitignored export, or `--no-write` for a throwaway run.

Local Codex must support `--ignore-user-config`, `--ignore-rules`, and `--output-schema`; check `codex exec --help`. The evals deliberately fail rather than falling back to API billing or disabling the sandbox.
