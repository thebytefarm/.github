import { checkReport, checkVerdict } from "../schemas.mts";
import { checkGroups } from "../finish.mts";
import { getCase, head } from "./cases.mjs";

/** Scores fixture-specific correctness without a paid model judge. */
export default function grade(output, context) {
  const fixture = getCase(context.vars.case);
  const expected = fixture.expected;
  const failures = [];
  const check = (condition, reason) => {
    if (!condition) failures.push(reason);
  };
  try {
    const value = JSON.parse(output);
    if (fixture.role === "verdict") {
      checkVerdict(value.synthesis);
      checkGroups(
        fixture.reports.flatMap((report) => report.findings.map((finding) => finding.id)),
        value.synthesis.groups.flatMap((group) => group.finding_ids),
      );
      check(
        value.review.comments.length === expected.threads,
        "Duplicate or missing inline threads",
      );
      const visible = value.review.body
        .split("<details>")[0]
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .trim();
      check(visible.split(/\s+/).length <= 65, "Review summary is verbose");
      check(
        (value.review.body.match(/https:\/\/img.shields.io\//g) ?? []).length === 3,
        "Missing decision/risk/merge badges",
      );
      const bodies = value.review.comments.map((comment) => comment.body);
      for (const body of bodies) {
        check(
          body.length <= 600 && body.trim().split(/\s+/).length <= 75,
          "Verbose inline comment",
        );
        check(
          !/###|<details|Findings:|bugs-1|risk-1|standards-1/.test(body),
          "Leaked review machinery",
        );
      }
      for (const term of expected.terms)
        check(
          bodies.some((body) => new RegExp(term, "i").test(body)),
          `Missing issue: ${term}`,
        );
    } else {
      const report = value.report;
      checkReport(report);
      check(report.head_sha === head && report.reviewer === fixture.role, "Wrong reviewer/commit");
      check(
        report.status === "complete" && report.limitations.length === 0,
        "Incomplete synthetic review",
      );
      if (expected.count !== undefined)
        check(report.findings.length === expected.count, "False positive or missed defect");
      for (const finding of report.findings) {
        if (expected.count === 1)
          check(finding.blocking === true, "Concrete blocker marked advisory");
        if (expected.path) check(finding.path === expected.path, "Wrong path");
        if (expected.line) check(finding.line === expected.line, "Wrong line");
        if (expected.severity)
          check(finding.severity === expected.severity, "Severity inflation or under-rating");
        if (expected.standard)
          check(finding.standard.startsWith(expected.standard), "Missing policy citation");
        check(finding.evidence.trim().split(/\s+/).length <= 75, "Verbose specialist evidence");
      }
      for (const term of expected.terms ?? [])
        check(
          new RegExp(term, "i").test(report.findings.map((finding) => finding.evidence).join(" ")),
          `Missing evidence: ${term}`,
        );
      if (expected.risk) check(report.risk.level === expected.risk, "Wrong risk");
      if (expected.riskNot)
        check(report.risk.level !== expected.riskNot, "Unsafe low-risk assessment");
      if (expected.release !== undefined)
        check(report.risk.release === expected.release, "Release exclusion missed");
    }
  } catch (error) {
    failures.push(`Invalid pipeline output: ${error.message}`);
  }
  return {
    pass: failures.length === 0,
    score: failures.length ? 0 : 1,
    reason: failures.join("; ") || "Grounded and concise",
  };
}
