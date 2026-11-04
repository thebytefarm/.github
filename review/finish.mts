import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkReport, checkVerdict, verdictSchema } from "./schemas.mts";
import type { Risk } from "./merge-policy.mts";

type Finding = {
  id: string;
  path: string;
  line: number;
  title: string;
  evidence: string;
  blocking: boolean;
  standard: string;
  severity: string;
};
type Report = {
  head_sha: string;
  reviewer: string;
  status: string;
  limitations: string[];
  findings: Finding[];
  risk?: Risk;
};
const roles = ["bugs", "security", "standards", "design", "risk"];
const text = (value: string): string =>
  value.replace(/[<>&@]/g, (char) => `&#${char.charCodeAt(0)};`);

/** Checks code-owned approval invariants, independent of the model's recommendation. */
export function decide(reports: Report[], sha: string): "APPROVE" | "REQUEST_CHANGES" {
  assert.equal(reports.length, roles.length, "Missing specialist");
  assert.equal(new Set(reports.map((report) => report.reviewer)).size, roles.length);
  for (const report of reports) {
    checkReport(report);
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

/** Prevents synthesis from omitting, duplicating, or inventing findings. */
export function checkGroups(expected: string[], actual: string[]): void {
  assert.deepEqual([...actual].sort(), [...expected].sort(), "Synthesis lost or invented findings");
}

const main = (): void => {
  const input = JSON.parse(readFileSync("context/input.json", "utf8"));
  const errors: string[] = [];
  const reports = roles.flatMap((role): Report[] => {
    try {
      const report = JSON.parse(readFileSync(`results/${role}.json`, "utf8")) as Report;
      checkReport(report);
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
      `${prompt}\nHead SHA: ${input.head}. Paths are workspace-relative; read only context/reports.json. Budget: ${input.verdictSeconds}s; reserve 20s for output.\n\n${input.verdictInstructions ?? ""}`,
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
      const result = JSON.parse(readFileSync("context/synthesis.json", "utf8"));
      checkVerdict(result);
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
    ...reports
      .filter((report) => report.reviewer === "risk" && report.risk)
      .map(
        (report) =>
          `### Change risk: ${text(report.risk!.level)}\n\nImpact: ${text(report.risk!.impact)}\n\nLikelihood: ${text(report.risk!.likelihood)}\n\n${text(report.risk!.rationale)}`,
      ),
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
  writeFileSync(
    "context/decision.json",
    JSON.stringify({
      ...input,
      event,
      risk: reports.find((report) => report.reviewer === "risk")?.risk,
    }),
  );
  assert.notEqual(event, "INCOMPLETE", "Review incomplete; no approval");
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
