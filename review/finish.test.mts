import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkGroups, decide } from "./finish.mts";

const sha = "a".repeat(40);
const reports = () =>
  ["bugs", "security", "standards", "design"].map((reviewer) => ({
    reviewer,
    head_sha: sha,
    status: "complete",
    limitations: [] as string[],
    findings: [] as {
      id: string;
      path: string;
      line: number;
      title: string;
      evidence: string;
      blocking: boolean;
      standard: string;
    }[],
  }));
const finding = (role: string, blocking = true) => ({
  id: `${role}-1`,
  path: "src/a.ts",
  line: 1,
  title: "Issue",
  evidence: "Concrete scenario",
  blocking,
  standard: "AGENTS.md#Rule",
});

it("approves only complete reviews without blockers", () => {
  assert.equal(decide(reports(), sha), "APPROVE");
});
it("requests changes for any blocker, without majority voting", () => {
  const input = reports().map((report) =>
    report.reviewer === "bugs" ? { ...report, findings: [finding("bugs")] } : report,
  );
  assert.equal(decide(input, sha), "REQUEST_CHANGES");
});
it("refuses missing, partial, limited, duplicate, and stale reports", () => {
  assert.throws(() => decide(reports().slice(1), sha));
  assert.throws(() =>
    decide(
      reports().map((report) => ({ ...report, status: "partial" })),
      sha,
    ),
  );
  assert.throws(() =>
    decide(
      reports().map((report) => ({ ...report, limitations: ["Unread code"] })),
      sha,
    ),
  );
  assert.throws(() => decide([reports()[0], ...reports().slice(0, 3)], sha));
  assert.throws(() => decide(reports(), "b".repeat(40)));
});
it("keeps design advisory and requires standards citations", () => {
  assert.throws(() =>
    decide(
      reports().map((report) =>
        report.reviewer === "design" ? { ...report, findings: [finding("design")] } : report,
      ),
      sha,
    ),
  );
  assert.throws(() =>
    decide(
      reports().map((report) =>
        report.reviewer === "standards"
          ? { ...report, findings: [{ ...finding("standards"), standard: "" }] }
          : report,
      ),
      sha,
    ),
  );
});
it("does not treat a truthy string as a blocking boolean", () => {
  const invalid = { ...finding("bugs"), blocking: "false" as unknown as boolean };
  assert.throws(() =>
    decide(
      reports().map((report) =>
        report.reviewer === "bugs" ? { ...report, findings: [invalid] } : report,
      ),
      sha,
    ),
  );
});
it("preserves every finding exactly once during synthesis", () => {
  checkGroups(["bugs-1", "security-1"], ["security-1", "bugs-1"]);
  for (const ids of [["bugs-1"], ["bugs-1", "invented"], ["bugs-1", "security-1", "bugs-1"]]) {
    assert.throws(() => checkGroups(["bugs-1", "security-1"], ids));
  }
});

it("starts synthesis in a Git checkout and resolves the collected reports from there", (test) => {
  const workspace = mkdtempSync(join(tmpdir(), "pull-review-synthesis-"));
  test.after(() => rmSync(workspace, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("../", import.meta.url));
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", root, join(workspace, "engine")]);
  mkdirSync(join(workspace, "context"));
  mkdirSync(join(workspace, "results"));
  writeFileSync(
    join(workspace, "context/input.json"),
    JSON.stringify({ head: sha, verdictSeconds: 90 }),
  );
  for (const report of reports()) {
    writeFileSync(join(workspace, `results/${report.reviewer}.json`), JSON.stringify(report));
  }
  const output = join(workspace, "output");
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL("./finish.mts", import.meta.url)), "collect"],
    {
      cwd: workspace,
      env: { ...process.env, REVIEW_RESULT: "success", GITHUB_OUTPUT: output },
    },
  );
  assert.match(readFileSync(output, "utf8"), /^complete=true$/m);
  const workflow = readFileSync(join(root, ".github/workflows/pull-review.yml"), "utf8");
  const synthesisStep = workflow
    .split("- name: Summarize using the cheaper model")[1]
    .split("env:")[0];
  const cwdMatch = synthesisStep.match(/cwd: (\w+)/);
  assert(cwdMatch, "Synthesis must configure a working directory");
  const cwd = join(workspace, cwdMatch[1]);
  execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd, stdio: "pipe" });
  const prompt = readFileSync(join(workspace, "context/verdict.md"), "utf8");
  const reportsMatch = prompt.match(/Read (\S+)\. Budget:/);
  assert(reportsMatch, "Synthesis prompt must locate its reports");
  assert.deepEqual(JSON.parse(readFileSync(resolve(cwd, reportsMatch[1]), "utf8")), reports());
});
