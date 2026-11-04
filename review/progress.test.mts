import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { progressSnapshot } from "./progress.mts";

const names = [
  "prepare",
  "Review / bugs",
  "Review / security",
  "Review / standards",
  "Review / design",
  "Review / risk",
  "finish",
  "publish",
];
const jobs = (status = "completed", conclusion: string | null = "success") =>
  names.map((name, index) => ({ id: index + 1, name: `review / ${name}`, status, conclusion }));

it("shows each specialist independently without treating workflow completion as approval", () => {
  const snapshot = progressSnapshot(
    jobs().map((job) =>
      job.name.endsWith(" / publish") ? { ...job, status: "in_progress", conclusion: null } : job,
    ),
  );
  assert.equal(snapshot.complete, false);
  assert.match(snapshot.body, /Bugs \| Passed/);
  assert.match(snapshot.body, /Design \(advisory\) \| Passed/);
  assert.match(snapshot.body, /Publication \/ merge gate \| Running/);
  const final = progressSnapshot(jobs());
  assert.equal(final.complete, true);
  assert.match(final.body, /Workflow completion is not an approval/);
});

it("terminates an unsuccessful preparation and preserves failed or cancelled job states", () => {
  for (const conclusion of ["failure", "cancelled", "timed_out", "skipped"]) {
    const snapshot = progressSnapshot([jobs("completed", conclusion)[0]]);
    assert.equal(snapshot.complete, true);
    assert.match(snapshot.body, /Review incomplete/);
    assert.doesNotMatch(snapshot.body, /Review workflow complete/);
  }
});

it("covers every running and completed transition with sixteen updates", () => {
  let current = jobs("queued", null);
  const signatures = new Set([progressSnapshot(current).signature]);
  assert.equal(progressSnapshot([]).signature, progressSnapshot(current).signature);
  for (const name of names) {
    current = current.map((job) =>
      job.name.endsWith(` / ${name}`) ? { ...job, status: "in_progress" } : job,
    );
    signatures.add(progressSnapshot(current).signature);
    current = current.map((job) =>
      job.name.endsWith(` / ${name}`)
        ? { ...job, status: "completed", conclusion: "success" }
        : job,
    );
    signatures.add(progressSnapshot(current).signature);
  }
  assert.equal(signatures.size - 1, 16);
});

for (const scenario of ["active", "newer-run", "new-head", "closed"] as const) {
  it(`handles ${scenario} progress using read-only GitHub calls`, (test) => {
    const root = mkdtempSync(join(tmpdir(), "review-progress-"));
    test.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "bin"));
    const marker =
      scenario === "newer-run"
        ? "<!-- bytefarm-review-run:100:1 -->"
        : "<!-- bytefarm-review-run:99:1 -->";
    writeFileSync(
      join(root, "bin/gh"),
      `#!${process.execPath}\n
      if (process.env.GH_TOKEN !== 'read-only') throw new Error('Wrong read identity');
      const args = process.argv.slice(2);
      if (args[0] !== 'api' || args.some(arg => /POST|PATCH|DELETE|--method|--input/.test(arg))) throw new Error('Unexpected write');
      const path = args[1];
      if (path.includes('/issues/comments/')) console.log(JSON.stringify({body: ${JSON.stringify(marker)}}));
      else if (path.includes('/pulls/')) console.log(JSON.stringify({head: {sha: ${JSON.stringify((scenario === "new-head" ? "b" : "a").repeat(40))}}, state: ${JSON.stringify(scenario === "closed" ? "closed" : "open")}, merged: false}));
      else if (path.includes('/jobs?')) console.log(JSON.stringify([{jobs: ${JSON.stringify(jobs())}}]));
      else throw new Error('Unexpected endpoint');
    `,
      { mode: 0o755 },
    );
    writeFileSync(join(root, "outputs"), "");
    writeFileSync(join(root, "env"), "");
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./progress.mts", import.meta.url))],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10000,
        env: {
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          GH_TOKEN: "read-only",
          GITHUB_REPOSITORY: "thebytefarm/fixture",
          PR_NUMBER: "7",
          GITHUB_RUN_ID: "99",
          GITHUB_RUN_ATTEMPT: "1",
          PROGRESS_COMMENT_ID: "12",
          REVIEW_HEAD: "a".repeat(40),
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_OUTPUT: join(root, "outputs"),
          GITHUB_ENV: join(root, "env"),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(root, "env"), "utf8"), /REVIEW_PROGRESS_DONE=true/);
    if (scenario === "newer-run") {
      assert(!existsSync(join(root, "context/progress.md")));
      assert.equal(readFileSync(join(root, "outputs"), "utf8"), "");
    } else {
      const body = readFileSync(join(root, "context/progress.md"), "utf8");
      assert.match(body, /bytefarm-review-run:99:1/);
      assert.match(body, /actions\/runs\/99\/attempts\/1/);
      assert.match(body, scenario === "active" ? /Review workflow complete/ : /Review superseded/);
      assert.match(readFileSync(join(root, "outputs"), "utf8"), /ready=true/);
    }
  });
}

it("starts progress independently before checkout and confines comment writes to a pinned action", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/pull-review.yml", import.meta.url),
    "utf8",
  );
  const observer = workflow.split("\n  progress:")[1];
  assert(observer);
  assert.doesNotMatch(
    observer,
    /needs:|CODEX_AUTH_JSON|agent\.mts|statuses: write|pull-requests: write/,
  );
  assert.match(observer, /if: inputs.publish .*github.event.repository.private == false/);
  assert(observer.indexOf("Announce review immediately") < observer.indexOf("actions/checkout@"));
  assert.match(observer, /ref: \$\{\{ steps.context.outputs.sha \}\}/);
  assert.equal((observer.match(/uses: \.\/engine\/review\/progress/g) ?? []).length, 16);
  assert.match(observer, /failure\(\) \|\| cancelled\(\)/);
  const action = readFileSync(new URL("./progress/action.yml", import.meta.url), "utf8");
  const pin = "marocchino/sticky-pull-request-comment@5770ad5eb8f42dd2c4f34da00c94c5381e49af88";
  assert(action.includes(pin));
  assert(observer.includes(pin));
  assert.match(action, /header: bytefarm-review-progress/);
  assert.match(action, /GITHUB_TOKEN: \$\{\{ inputs.token \}\}/);
  assert.match(action, /GH_TOKEN: \$\{\{ inputs.read-token \}\}/);
});
