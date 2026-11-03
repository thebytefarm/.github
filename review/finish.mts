import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { verdictSchema } from "./schemas.mts";

type Finding = {
  id: string;
  path: string;
  line: number;
  title: string;
  evidence: string;
  blocking: boolean;
  standard: string;
};
type Report = {
  head_sha: string;
  reviewer: string;
  status: string;
  limitations: string[];
  findings: Finding[];
};
const roles = ["bugs", "security", "standards", "design"];
const text = (value: string): string =>
  value.replace(/[<>&@]/g, (char) => `&#${char.charCodeAt(0)};`);

/** Checks the invariants that remain code-owned after Pullfrog's schema validation. */
export function decide(reports: Report[], sha: string): "APPROVE" | "REQUEST_CHANGES" {
  assert.equal(reports.length, roles.length, "Missing specialist");
  assert.equal(new Set(reports.map((report) => report.reviewer)).size, roles.length);
  for (const report of reports) {
    assert(roles.includes(report.reviewer) && report.head_sha === sha, "Wrong reviewer/commit");
    assert(report.status === "complete" && report.limitations.length === 0, "Review incomplete");
    for (const finding of report.findings) {
      assert(typeof finding.blocking === "boolean" && finding.id.startsWith(`${report.reviewer}-`));
      assert(report.reviewer !== "design" || !finding.blocking, "Design is advisory");
      assert(
        report.reviewer !== "standards" || finding.standard.includes("#"),
        "Missing standards citation",
      );
    }
  }
  const findings = reports.flatMap((report) => report.findings);
  assert.equal(new Set(findings.map((finding) => finding.id)).size, findings.length);
  return findings.some((finding) => finding.blocking) ? "REQUEST_CHANGES" : "APPROVE";
}

/** Prevents the cheaper model from omitting, duplicating, or inventing findings. */
export function checkGroups(expected: string[], actual: string[]): void {
  assert.deepEqual([...actual].sort(), [...expected].sort(), "Synthesis lost or invented findings");
}

const main = (): void => {
  const input = JSON.parse(readFileSync("context/input.json", "utf8"));
  const errors: string[] = [];
  const reports = roles.flatMap((role): Report[] => {
    try {
      const report = JSON.parse(readFileSync(`results/${role}.json`, "utf8")) as Report;
      assert.equal(report.reviewer, role);
      return [report];
    } catch {
      errors.push(`Missing ${role} result`);
      return [];
    }
  });
  const decision = (() => {
    try {
      assert.equal(process.env.REVIEW_RESULT, "success", "A specialist job failed");
      return decide(reports, input.head);
    } catch (error) {
      errors.push(String(error));
      return "INCOMPLETE";
    }
  })();
  if (process.argv[2] === "collect") {
    writeFileSync("context/reports.json", JSON.stringify(reports));
    const prompt = readFileSync(new URL("./prompts/verdict.md", import.meta.url), "utf8");
    writeFileSync(
      "context/verdict.md",
      `${prompt}\nHead SHA: ${input.head}. Your cwd is the engine checkout; read only the supplied reports, not checkout source or instructions. Read ../context/reports.json. Budget: ${input.verdictSeconds}s; reserve 20s for output.`,
    );
    appendFileSync(
      process.env.GITHUB_OUTPUT!,
      `complete=${decision !== "INCOMPLETE"}\nschema=${JSON.stringify(verdictSchema)}\n`,
    );
    return;
  }
  let event = decision;
  const synthesis = (() => {
    try {
      assert.equal(process.env.SYNTHESIS_RESULT, "success", "Synthesis failed or skipped");
      const result = JSON.parse(process.env.AGENT_RESULT ?? "");
      assert.equal(result.head_sha, input.head);
      checkGroups(
        reports.flatMap((report) => report.findings.map((finding) => finding.id)),
        result.groups.flatMap((group: { finding_ids: string[] }) => group.finding_ids),
      );
      return result as { summary: string; groups: { title: string; finding_ids: string[] }[] };
    } catch (error) {
      event = "INCOMPLETE";
      errors.push(String(error));
      return {
        summary: "Review incomplete; no approval.",
        groups: [
          {
            title: "Available findings",
            finding_ids: reports.flatMap((report) => report.findings.map((finding) => finding.id)),
          },
        ],
      };
    }
  })();
  const findings = new Map(
    reports.flatMap((report) => report.findings.map((finding) => [finding.id, finding] as const)),
  );
  const body = [
    `## ${event}`,
    text(synthesis.summary),
    ...errors.map(text),
    ...synthesis.groups.map((group) =>
      [
        `### ${text(group.title)}`,
        ...group.finding_ids.map((id) => {
          const finding = findings.get(id)!;
          return `- **${text(finding.title)}** (${finding.blocking ? "blocking" : "advisory"}; ${text(id)})\n  ${text(finding.path)}:${finding.line} — ${text(finding.evidence)}${finding.standard ? `\n  Standard: ${text(finding.standard)}` : ""}`;
        }),
      ].join("\n\n"),
    ),
    "Tests were not executed. Design findings are advisory.",
  ].join("\n\n");
  assert(body.length < 60000, "Review too long; refusing to truncate evidence");
  writeFileSync("context/review.md", body);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, body);
  if (process.env.PUBLISH === "true") {
    const api = (path: string, data?: unknown): string =>
      execFileSync("gh", ["api", path, ...(data ? ["--method", "POST", "--input", "-"] : [])], {
        input: data ? JSON.stringify(data) : undefined,
        encoding: "utf8",
        timeout: 30000,
      });
    const latest = JSON.parse(api(`repos/${input.repository}/pulls/${input.number}`));
    assert.equal(JSON.parse(api(`repos/${input.repository}`)).visibility, "public");
    assert(
      latest.state === "open" &&
        !latest.draft &&
        latest.head.sha === input.head &&
        latest.base.sha === input.base,
      "PR moved; rerun instead of publishing stale results",
    );
    api(`repos/${input.repository}/pulls/${input.number}/reviews`, {
      commit_id: input.head,
      event: event === "INCOMPLETE" ? "COMMENT" : event,
      body,
    });
    api(`repos/${input.repository}/statuses/${input.head}`, {
      context: "bytefarm/review",
      state: event === "APPROVE" ? "success" : event === "INCOMPLETE" ? "error" : "failure",
      description: event,
    });
  }
  assert.notEqual(event, "INCOMPLETE", "Review incomplete; no approval");
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
