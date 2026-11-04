import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

type Job = { id: number; name: string; status: string; conclusion: string | null };
const stages = [
  ["prepare", "Preparation"],
  ["Review / bugs", "Bugs"],
  ["Review / security", "Security"],
  ["Review / standards", "Standards"],
  ["Review / design", "Design (advisory)"],
  ["Review / risk", "Risk"],
  ["finish", "Synthesis"],
  ["publish", "Publication / merge gate"],
] as const;

/** Builds progress from actual job state, never from model claims or PR content. */
export function progressSnapshot(jobs: Job[]) {
  const latest = stages.map(([name, label]) => ({
    label,
    job: jobs
      .filter((job) => job.name === name || job.name.endsWith(` / ${name}`))
      .toSorted((a, b) => b.id - a.id)[0],
  }));
  const preparation = latest[0].job;
  const publication = latest.at(-1)!.job;
  const complete =
    publication?.status === "completed" ||
    (preparation?.status === "completed" && preparation.conclusion !== "success");
  const failed = latest.some(
    ({ job }) => job?.status === "completed" && job.conclusion !== "success",
  );
  const title = complete
    ? failed
      ? "Review incomplete"
      : "Review workflow complete"
    : "Review in progress";
  const state = (job: Job | undefined): string =>
    !job
      ? "Waiting"
      : job.status === "in_progress"
        ? "Running"
        : job.status === "completed"
          ? ({
              success: "Passed",
              failure: "Failed",
              cancelled: "Cancelled",
              skipped: "Skipped",
              timed_out: "Timed out",
              neutral: "Neutral",
            }[job.conclusion ?? ""] ?? "Incomplete")
          : "Queued";
  return {
    complete,
    signature: latest
      .map(({ job }) =>
        job?.status === "completed"
          ? job.conclusion
          : job?.status === "in_progress"
            ? "running"
            : "pending",
      )
      .join(","),
    body: [
      `### ${title}`,
      "",
      "| Stage | Status |\n| :--- | :--- |",
      ...latest.map(({ label, job }) => `| ${label} | ${state(job)} |`),
      "",
      complete
        ? "See the review and workflow run for findings and merge outcome. Workflow completion is not an approval."
        : "Findings will appear inline. Approval and merging remain gated until review and CI checks finish.",
    ].join("\n"),
  };
}

const main = async (): Promise<void> => {
  if (process.env.REVIEW_PROGRESS_DONE === "true") return;
  const repository = process.env.GITHUB_REPOSITORY!;
  const number = process.env.PR_NUMBER!;
  const run = process.env.GITHUB_RUN_ID!;
  const attempt = process.env.GITHUB_RUN_ATTEMPT!;
  const comment = process.env.PROGRESS_COMMENT_ID!;
  const head = process.env.REVIEW_HEAD!;
  assert.match(repository, /^thebytefarm\/[\w.-]+$/);
  for (const value of [number, run, attempt, comment]) assert.match(value, /^[1-9][0-9]*$/);
  assert.match(head, /^[a-f0-9]{40}$/);
  const marker = `<!-- bytefarm-review-run:${run}:${attempt} -->`;
  const api = <T,>(path: string): T =>
    JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", timeout: 30000 }));
  const statePath = "context/progress-state.json";
  mkdirSync("context", { recursive: true });
  const previous = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : { started: Date.now(), signature: progressSnapshot([]).signature };
  const done = () => appendFileSync(process.env.GITHUB_ENV!, "REVIEW_PROGRESS_DONE=true\n");
  while (true) {
    const current = api<{ body: string }>(`repos/${repository}/issues/comments/${comment}`);
    if (!current.body.includes(marker)) {
      done();
      return;
    }
    const pull = api<{ head: { sha: string }; state: string; merged: boolean }>(
      `repos/${repository}/pulls/${number}`,
    );
    const pages = JSON.parse(
      execFileSync(
        "gh",
        [
          "api",
          `repos/${repository}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100`,
          "--paginate",
          "--slurp",
        ],
        { encoding: "utf8", timeout: 30000 },
      ),
    ) as { jobs: Job[] }[];
    const snapshot = progressSnapshot(pages.flatMap((page) => page.jobs));
    const moved = pull.head.sha !== head || (pull.state === "closed" && !pull.merged);
    const expired = Date.now() - previous.started > 55 * 60 * 1000;
    if (moved || expired || snapshot.complete || snapshot.signature !== previous.signature) {
      const body = moved
        ? "### Review superseded\n\nThe PR changed or closed. This run cannot approve the current PR; a fresh review is required."
        : expired
          ? "### Progress reporting timed out\n\nCheck the workflow run for the current review state. No approval or merge is implied."
          : snapshot.body;
      writeFileSync(
        "context/progress.md",
        `${marker}\n\n${body}\n\nCommit: \`${head.slice(0, 7)}\` · [Workflow run](${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${run}/attempts/${attempt})\n`,
      );
      writeFileSync(
        statePath,
        JSON.stringify({ started: previous.started, signature: snapshot.signature }),
      );
      appendFileSync(process.env.GITHUB_OUTPUT!, "ready=true\n");
      if (moved || expired || snapshot.complete) done();
      return;
    }
    await setTimeout(20000);
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
