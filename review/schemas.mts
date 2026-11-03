const text = { type: "string", minLength: 1, maxLength: 4000 };
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const array = (items: unknown) => ({ type: "array", maxItems: 80, items });

/** Pullfrog validates specialist output against this schema; no local schema engine. */
export const reviewSchema = object({
  head_sha: text,
  reviewer: { enum: ["bugs", "security", "standards", "design"] },
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

/** Synthesis can group findings, but cannot return an approval decision. */
export const verdictSchema = object({
  head_sha: text,
  summary: text,
  groups: array(object({ title: text, finding_ids: array(text) })),
});
