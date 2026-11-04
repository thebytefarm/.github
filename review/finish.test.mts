import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { checkGroups, decide } from "./finish.mts";

const sha = "a".repeat(40);
const reports = () =>
  ["bugs", "security", "standards", "design", "risk"].map((reviewer) => ({
    reviewer,
    head_sha: sha,
    status: "complete",
    limitations: [] as string[],
    ...(reviewer === "risk"
      ? {
          risk: {
            level: "low" as const,
            impact: "Isolated change",
            likelihood: "Covered by tests",
            rationale: "Small and reversible",
            release: false,
          },
        }
      : {}),
    findings: [] as {
      id: string;
      path: string;
      line: number;
      title: string;
      evidence: string;
      blocking: boolean;
      standard: string;
      severity: string;
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
  severity: "high",
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
it("requires a risk assessment without treating elevated risk as a defect", () => {
  assert.throws(() =>
    decide(
      reports().map((report) => ({ ...report, risk: undefined })),
      sha,
    ),
  );
  for (const level of ["medium", "high", "critical"] as const) {
    const input = reports().map((report) =>
      report.risk ? { ...report, risk: { ...report.risk, level } } : report,
    );
    assert.equal(decide(input, sha), "APPROVE");
  }
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

it("restricts synthesis to the collected reports without a GitHub identity", (test) => {
  const workspace = mkdtempSync(join(tmpdir(), "pull-review-synthesis-"));
  test.after(() => rmSync(workspace, { recursive: true, force: true }));
  const root = fileURLToPath(new URL("../", import.meta.url));
  mkdirSync(join(workspace, "context"));
  mkdirSync(join(workspace, "results"));
  writeFileSync(
    join(workspace, "context/input.json"),
    JSON.stringify({ head: sha, verdictSeconds: 90, verdictInstructions: "Summarize tersely." }),
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
    .split("- name: Summarize with lower-effort Codex")[1]
    .split("- name: Compute verdict")[0];
  assert.match(synthesisStep, /node engine\/review\/agent.mts/);
  assert.doesNotMatch(synthesisStep, /GH_TOKEN|id-token|pullfrog\/pullfrog/);
  const prompt = readFileSync(join(workspace, "context/verdict.md"), "utf8");
  assert.match(prompt, /read only context\/reports.json/);
  assert.match(prompt, /Summarize tersely/);
  assert.deepEqual(
    JSON.parse(readFileSync(join(workspace, "context/reports.json"), "utf8")),
    reports(),
  );
});

it("renders a bound low-risk decision only after complete reviews and synthesis", (test) => {
  const workspace = mkdtempSync(join(tmpdir(), "review-decision-"));
  test.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(join(workspace, "context"));
  mkdirSync(join(workspace, "results"));
  writeFileSync(
    join(workspace, "context/input.json"),
    JSON.stringify({
      repository: "thebytefarm/fixture",
      number: 7,
      head: sha,
      base: "b".repeat(40),
    }),
  );
  for (const report of reports())
    writeFileSync(join(workspace, `results/${report.reviewer}.json`), JSON.stringify(report));
  writeFileSync(
    join(workspace, "context/synthesis.json"),
    JSON.stringify({ head_sha: sha, summary: "No findings", groups: [] }),
  );
  const cli = fileURLToPath(new URL("./finish.mts", import.meta.url));
  execFileSync(process.execPath, [cli, "render"], {
    cwd: workspace,
    env: {
      ...process.env,
      REVIEW_RESULT: "success",
      SYNTHESIS_RESULT: "success",
      GITHUB_STEP_SUMMARY: "",
    },
  });
  const decision = JSON.parse(readFileSync(join(workspace, "context/decision.json"), "utf8"));
  assert.equal(decision.event, "APPROVE");
  assert.equal(decision.head, sha);
  assert.equal(decision.risk.level, "low");
  assert.equal(decision.risk.release, false);
  const partial = { ...reports()[0], status: "partial", limitations: ["Missing context"] };
  writeFileSync(join(workspace, "results/bugs.json"), JSON.stringify(partial));
  assert.throws(() =>
    execFileSync(process.execPath, [cli, "render"], {
      cwd: workspace,
      stdio: "pipe",
      env: {
        ...process.env,
        REVIEW_RESULT: "success",
        SYNTHESIS_RESULT: "success",
        GITHUB_STEP_SUMMARY: "",
      },
    }),
  );
  assert.equal(
    JSON.parse(readFileSync(join(workspace, "context/decision.json"), "utf8")).event,
    "INCOMPLETE",
  );
});
