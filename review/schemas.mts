import assert from "node:assert/strict";
import { checkRisk } from "./merge-policy.mts";

const text = { type: "string", minLength: 1, maxLength: 4000 };
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const array = (items: unknown) => ({ type: "array", maxItems: 80, items });

/** Tool-call schema shared by all defect reviewers. */
export const reviewSchema = object({
  head_sha: text,
  reviewer: { enum: ["bugs", "security", "standards", "design", "risk"] },
  status: { enum: ["complete", "partial"] },
  limitations: array(text),
  findings: array(
    object({
      id: text,
      path: text,
      line: { type: "integer", minimum: 1 },
      title: text,
      evidence: text,
      severity: { enum: ["critical", "high", "medium", "low"] },
      blocking: { type: "boolean" },
      standard: { type: "string", maxLength: 1000 },
    }),
  ),
});

/** Risk is required only for the impact/likelihood specialist. */
export const riskSchema = {
  ...reviewSchema,
  required: [...reviewSchema.required, "risk"],
  properties: {
    ...reviewSchema.properties,
    risk: object({
      level: { enum: ["low", "medium", "high", "critical"] },
      impact: text,
      likelihood: text,
      rationale: text,
      release: { type: "boolean" },
    }),
  },
};

/** Synthesis can group findings, but cannot return an approval decision. */
export const verdictSchema = object({
  head_sha: text,
  summary: text,
  groups: array(
    object({
      title: text,
      comment: { type: "string", minLength: 1, maxLength: 600 },
      finding_ids: array(text),
    }),
  ),
});

const record = (value: unknown): Record<string, unknown> => {
  assert(value && typeof value === "object" && !Array.isArray(value), "Expected object");
  return value as Record<string, unknown>;
};
const string = (value: unknown, empty = false): void => {
  assert(
    typeof value === "string" && (empty || value.trim().length > 0) && value.length <= 4000,
    "Invalid text",
  );
};
const strings = (value: unknown): void => {
  assert(Array.isArray(value) && value.length <= 80, "Invalid array");
  value.forEach((item) => string(item));
};

/** Validates external model output before it can become an approval or merge input. */
export function checkReport(value: unknown): void {
  const report = record(value);
  assert(
    typeof report.head_sha === "string" && /^[a-f0-9]{40}$/.test(report.head_sha),
    "Invalid SHA",
  );
  assert(
    ["bugs", "security", "standards", "design", "risk"].includes(report.reviewer as string),
    "Invalid role",
  );
  assert(["complete", "partial"].includes(report.status as string), "Invalid status");
  strings(report.limitations);
  assert(Array.isArray(report.findings) && report.findings.length <= 80, "Invalid findings");
  for (const value of report.findings) {
    const finding = record(value);
    for (const key of ["id", "path", "title", "evidence"]) string(finding[key]);
    string(finding.standard, true);
    assert(Number.isSafeInteger(finding.line) && Number(finding.line) > 0, "Invalid line");
    assert(
      ["critical", "high", "medium", "low"].includes(finding.severity as string),
      "Invalid severity",
    );
    assert(typeof finding.blocking === "boolean", "Invalid blocking flag");
  }
  if (report.reviewer === "risk") checkRisk(report.risk);
}

/** Validates synthesis shape; finish.mts separately preserves all finding identities. */
export function checkVerdict(value: unknown): void {
  const verdict = record(value);
  assert(
    typeof verdict.head_sha === "string" && /^[a-f0-9]{40}$/.test(verdict.head_sha),
    "Invalid SHA",
  );
  string(verdict.summary);
  assert(Array.isArray(verdict.groups) && verdict.groups.length <= 80, "Invalid groups");
  for (const value of verdict.groups) {
    const group = record(value);
    string(group.title);
    string(group.comment);
    assert(
      (group.comment as string).length <= 600 &&
        (group.comment as string).trim().split(/\s+/).length <= 75,
      "Inline comment too verbose",
    );
    assert(
      !/^(?:#{1,6}\s|[-*]\s)|<details|Findings:|(?:bugs|security|standards|design|risk)-\d+/im.test(
        group.comment as string,
      ),
      "Inline comment contains review machinery",
    );
    strings(group.finding_ids);
  }
}
