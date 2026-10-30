import { assertSafePath, reviewers } from "./config.mts";
import { reviewSchema, validate, verdictSchema } from "./schemas.mts";
import type { Finding, Metadata, ReviewResult, Reviewer, VerdictResult } from "./types.mts";

/** Validates identity, scope and findings in addition to the output schema. */
export function parseReview({
  value,
  role,
  metadata,
}: {
  value: unknown;
  role: Reviewer;
  metadata: Metadata;
}): ReviewResult {
  validate(reviewSchema, value);
  const result = value as ReviewResult;
  if (result.reviewer !== role || result.head_sha !== metadata.head_sha)
    throw new Error(`Wrong reviewer or commit for ${role}`);
  if (result.status === "complete" && result.limitations.length)
    throw new Error(`${role} claims complete with limitations`);
  const ids = result.findings.map((finding) => finding.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${role} has duplicate finding IDs`);
  for (const finding of result.findings) {
    assertSafePath(finding.path);
    if (!finding.id.startsWith(`${role}-`) || !metadata.files.includes(finding.path))
      throw new Error(`Out-of-scope finding: ${finding.id}`);
    if (role === "standards") {
      const [path, section] = finding.standard.split("#");
      if (!section?.trim() || !metadata.policy_paths.includes(path))
        throw new Error("Standards findings must cite a loaded policy and section");
    }
    if (role === "design" && finding.blocking) throw new Error("Design findings must be advisory");
  }
  return result;
}

/** Requires every original finding exactly once, so synthesis cannot erase blockers. */
export function parseVerdict({
  value,
  reports,
  headSha,
}: {
  value: unknown;
  reports: ReviewResult[];
  headSha: string;
}): VerdictResult {
  validate(verdictSchema, value);
  const result = value as VerdictResult;
  if (result.head_sha !== headSha) throw new Error("Verdict references a different commit");
  const expected = reports.flatMap((report) => report.findings.map((finding) => finding.id)).sort();
  const actual = result.groups.flatMap((group) => group.finding_ids).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    throw new Error("Verdict must preserve every finding exactly once");
  return result;
}

/** Returns a deterministic verdict from original specialist data, never model prose. */
export function decide(reports: ReviewResult[]): "APPROVE" | "REQUEST_CHANGES" | "INCOMPLETE" {
  if (
    reports.length !== reviewers.length ||
    new Set(reports.map((report) => report.reviewer)).size !== reviewers.length ||
    reports.some((report) => report.status !== "complete" || report.limitations.length)
  )
    return "INCOMPLETE";
  return reports.some((report) => report.findings.some((finding) => finding.blocking))
    ? "REQUEST_CHANGES"
    : "APPROVE";
}

const escape = (text: string): string =>
  text
    .replace(/[<>&]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[char]!)
    .replace(/@/g, "@\u200b");
const renderFinding = (finding: Finding): string =>
  [
    `- **${escape(finding.title)}** (${finding.severity}; ${finding.blocking ? "blocking" : "advisory"}; ${finding.id})`,
    `  - File: ${escape(finding.path)}:${finding.line}`,
    `  - ${escape(finding.evidence)}`,
    finding.standard ? `  - Standard: ${escape(finding.standard)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

/** Renders all original evidence beneath the cheaper model's grouping and summary. */
export function renderReview({
  reports,
  verdict,
}: {
  reports: ReviewResult[];
  verdict: VerdictResult;
}): string {
  const event = decide(reports);
  const findings = new Map(
    reports.flatMap((report) => report.findings.map((finding) => [finding.id, finding] as const)),
  );
  return [
    "<!-- bytefarm-pull-review -->",
    `## ${event === "APPROVE" ? "Approved" : event === "REQUEST_CHANGES" ? "Changes requested" : "Review incomplete"}`,
    escape(verdict.summary),
    ...verdict.groups.map(
      (group) =>
        `### ${escape(group.title)}\n\n${group.finding_ids.map((id) => renderFinding(findings.get(id)!)).join("\n\n")}`,
    ),
    "Reviewed by bugs, security, standards, and design. Tests were not executed. Design findings are advisory.",
  ].join("\n\n");
}

/** Keeps findings from completed/partial workers visible when another stage fails. */
export function renderIncomplete({
  reports,
  errors,
}: {
  reports: ReviewResult[];
  errors: string[];
}): string {
  return [
    "<!-- bytefarm-pull-review -->",
    "## Review incomplete",
    "No approval was submitted. Inspect the workflow logs and rerun.",
    ...errors.map((error) => `- ${escape(error)}`),
    ...reports.flatMap((report) => [
      ...report.limitations.map((limitation) => `- ${report.reviewer}: ${escape(limitation)}`),
      ...report.findings.map(renderFinding),
    ]),
    "Findings above are preserved from the available specialist results; the full review did not complete. Tests were not executed.",
  ].join("\n\n");
}
