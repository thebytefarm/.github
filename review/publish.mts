import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { ciState, hasVersionBump, mergeBlocker } from "./merge-policy.mts";

type Pull = Parameters<typeof mergeBlocker>[0]["pull"] & {
  changed_files: number;
  mergeable: boolean | null;
  mergeable_state: string;
};
type File = { filename: string; previous_filename?: string; patch?: string; status: string };
type Run = {
  id: number;
  workflow_id: number;
  event: string;
  status: string;
  conclusion: string | null;
};
type Check = Parameters<typeof ciState>[0][number];
type Status = Parameters<typeof ciState>[1][number];
const api = <T,>(path: string, method = "GET", data?: unknown): T =>
  JSON.parse(
    execFileSync("gh", ["api", path, "--method", method, ...(data ? ["--input", "-"] : [])], {
      input: data ? JSON.stringify(data) : undefined,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 10000000,
    }),
  );
const pages = <T,>(path: string): T[] =>
  JSON.parse(
    execFileSync("gh", ["api", path, "--paginate", "--slurp"], {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 10000000,
    }),
  );
const note = (message: string): void => {
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${message}\n`);
};

const decision = JSON.parse(readFileSync("context/decision.json", "utf8")) as {
  repository: string;
  number: number;
  head: string;
  base: string;
  event: string;
  risk: unknown;
};
const repository = process.env.GITHUB_REPOSITORY!;
const number = Number(process.env.PR_NUMBER);
assert.match(repository, /^thebytefarm\/[\w.-]+$/);
assert(Number.isSafeInteger(number) && number > 0);
assert.equal(decision.repository, repository);
assert.equal(decision.number, number);
assert.equal(decision.head, process.env.REVIEW_HEAD);
assert.equal(decision.base, process.env.REVIEW_BASE);
assert(["APPROVE", "REQUEST_CHANGES", "INCOMPLETE"].includes(decision.event));
assert.equal(api<{ visibility: string }>(`repos/${repository}`).visibility, "public");
const endpoint = `repos/${repository}/pulls/${number}`;
const fresh = () => {
  const pull = api<Pull>(endpoint);
  assert(
    pull.state === "open" &&
      !pull.draft &&
      pull.head.sha === decision.head &&
      pull.base.sha === decision.base,
    "PR moved; rerun review",
  );
  return pull;
};
fresh();
api(`${endpoint}/reviews`, "POST", {
  commit_id: decision.head,
  event: decision.event === "INCOMPLETE" ? "COMMENT" : decision.event,
  body: readFileSync("context/review.md", "utf8"),
});
api(`repos/${repository}/statuses/${decision.head}`, "POST", {
  context: "bytefarm/review",
  state:
    decision.event === "APPROVE"
      ? "success"
      : decision.event === "INCOMPLETE"
        ? "error"
        : "failure",
  description: decision.event,
});
if (process.env.AUTO_MERGE !== "true") {
  note("Review published. Automatic merging is disabled.");
} else {
  const suite = api<{ check_suite_id: number }>(
    `repos/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  ).check_suite_id;
  assert(Number.isSafeInteger(suite) && suite > 0, "Cannot identify this review's check suite");
  const deadline = Date.now() + 30 * 60 * 1000;
  let registered = false;
  while (true) {
    const pull = fresh();
    const files = pages<File[]>(`${endpoint}/files?per_page=100`).flat();
    assert.equal(files.length, pull.changed_files, "File list truncated; no merge");
    const blocker = mergeBlocker({
      pull,
      files: files.map((file) => file.filename),
      reviewedHead: decision.head,
      reviewedBase: decision.base,
      decision: decision.event,
      risk: decision.risk,
      ci: "passed",
    });
    if (blocker || hasVersionBump(files)) {
      note(`Not merged: ${blocker ?? "Package version changes require a human"}.`);
      break;
    }
    // Let workflows register before the first merge decision. No unconditional future merge is queued.
    if (!registered) {
      registered = true;
      await setTimeout(30000);
      continue;
    }
    const checks = pages<{ check_runs: Check[] }>(
      `repos/${repository}/commits/${decision.head}/check-runs?filter=latest&per_page=100`,
    ).flatMap((page) => page.check_runs);
    const statuses = pages<Status[]>(
      `repos/${repository}/commits/${decision.head}/statuses?per_page=100`,
    ).flat();
    const ci = ciState(checks, statuses, suite);
    const runs = pages<{ workflow_runs: Run[] }>(
      `repos/${repository}/actions/runs?head_sha=${decision.head}&per_page=100`,
    ).flatMap((page) => page.workflow_runs);
    // A queued workflow can exist before its first check run. Latest run per workflow/event wins.
    const latestRuns = [
      ...new Map(
        runs
          .filter((run) => run.id !== Number(process.env.GITHUB_RUN_ID))
          .reverse()
          .map((run) => [`${run.workflow_id}:${run.event}`, run]),
      ).values(),
    ];
    const pending = latestRuns.some((run) => run.status !== "completed");
    const failed = latestRuns.some(
      (run) =>
        run.status === "completed" &&
        !["success", "neutral", "skipped"].includes(run.conclusion ?? ""),
    );
    if (ci === "failed" || failed) {
      note("Not merged: CI failed.");
      break;
    }
    if (
      ci === "passed" &&
      !pending &&
      pull.mergeable === true &&
      pull.mergeable_state === "clean"
    ) {
      const finalPull = fresh();
      const finalBlocker = mergeBlocker({
        pull: finalPull,
        files: files.map((file) => file.filename),
        reviewedHead: decision.head,
        reviewedBase: decision.base,
        decision: decision.event,
        risk: decision.risk,
        ci,
      });
      if (finalBlocker) {
        note(`Not merged: ${finalBlocker}.`);
        break;
      }
      assert(
        finalPull.mergeable === true && finalPull.mergeable_state === "clean",
        "Branch rules changed; no merge",
      );
      const result = api<{ merged: boolean }>(`${endpoint}/merge`, "PUT", {
        sha: decision.head,
        merge_method: "squash",
      });
      assert.equal(result.merged, true, "GitHub declined the merge");
      note(`Merged low-risk PR #${number} after CI passed. Releases remain human-only.`);
      break;
    }
    if (Date.now() >= deadline) {
      note(
        "Not merged: CI or branch rules did not become ready within 30 minutes. Rerun review when ready.",
      );
      break;
    }
    await setTimeout(15000);
  }
}
