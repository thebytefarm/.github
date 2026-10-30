const text = { type: "string", maxLength: 12000 } as const;
const shortText = { type: "string", minLength: 1, maxLength: 500 } as const;
const sha = { type: "string", pattern: "^[a-f0-9]{40}$" } as const;
const model = { type: "string", minLength: 1, maxLength: 200 } as const;
const instructions = {
  instructions: text,
  "instructions-path": { type: "string", maxLength: 500 },
} as const;
const agent = {
  type: "object",
  additionalProperties: false,
  properties: { model, ...instructions },
} as const;

/** Supported per-repository configuration; omitted settings inherit central defaults. */
export const configSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version"],
  properties: {
    version: { const: 1 },
    ...instructions,
    reviewers: {
      type: "object",
      additionalProperties: false,
      properties: { bugs: agent, security: agent, standards: agent, design: agent },
    },
    verdict: { type: "object", additionalProperties: false, properties: { model } },
    limits: {
      type: "object",
      additionalProperties: false,
      properties: {
        "reviewer-timeout": { type: "string", pattern: "^[1-9][0-9]*(s|m)$" },
        "verdict-timeout": { type: "string", pattern: "^[1-9][0-9]*(s|m)$" },
      },
    },
  },
} as const;

/** JSON Schema passed directly to Pullfrog's required structured-output input. */
export const reviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["head_sha", "reviewer", "status", "findings", "limitations"],
  properties: {
    head_sha: sha,
    reviewer: { enum: ["bugs", "security", "standards", "design"] },
    status: { enum: ["complete", "partial"] },
    findings: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "path", "line", "title", "evidence", "severity", "blocking", "standard"],
        properties: {
          id: { type: "string", pattern: "^(bugs|security|standards|design)-[1-9][0-9]*$" },
          path: shortText,
          line: { type: "integer", minimum: 1 },
          title: shortText,
          evidence: { ...text, minLength: 1 },
          severity: { enum: ["critical", "high", "medium", "low"] },
          blocking: { type: "boolean" },
          standard: text,
        },
      },
    },
    limitations: { type: "array", maxItems: 20, items: shortText },
  },
} as const;

/** The combiner groups existing IDs; it cannot create findings or choose a verdict. */
export const verdictSchema = {
  type: "object",
  additionalProperties: false,
  required: ["head_sha", "summary", "groups"],
  properties: {
    head_sha: sha,
    summary: { type: "string", minLength: 1, maxLength: 2000 },
    groups: {
      type: "array",
      maxItems: 80,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "finding_ids"],
        properties: {
          title: shortText,
          finding_ids: { type: "array", minItems: 1, maxItems: 80, items: shortText },
        },
      },
    },
  },
} as const;

type Schema = {
  type?: string;
  const?: unknown;
  enum?: readonly unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  minItems?: number;
  maxItems?: number;
  items?: Schema;
  required?: readonly string[];
  properties?: Readonly<Record<string, Schema>>;
  additionalProperties?: boolean;
};

/** Validates the JSON Schema subset used above, including unknown-key rejection. */
export function validate(schema: Schema, value: unknown, path = "$"): void {
  const fail = (message: string): never => {
    throw new Error(`${path}: ${message}`);
  };
  if ("const" in schema && value !== schema.const) fail("unexpected constant");
  if (schema.enum && !schema.enum.includes(value)) fail("unexpected enum value");
  if (schema.type === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      fail("expected object");
    const record = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!(key in record)) fail(`missing ${key}`);
    for (const [key, item] of Object.entries(record)) {
      if (!Object.hasOwn(properties, key)) {
        if (schema.additionalProperties === false) fail(`unknown key ${key}`);
      } else validate(properties[key], item, `${path}.${key}`);
    }
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) fail("expected array");
    const items = value as unknown[];
    if (items.length < (schema.minItems ?? 0) || items.length > (schema.maxItems ?? Infinity))
      fail("invalid array length");
    if (schema.items)
      items.forEach((item, index) => validate(schema.items!, item, `${path}[${index}]`));
  }
  if (schema.type === "string") {
    if (typeof value !== "string") fail("expected string");
    const string = value as string;
    if (string.length < (schema.minLength ?? 0) || string.length > (schema.maxLength ?? Infinity))
      fail("invalid string length");
    if (schema.pattern && !new RegExp(schema.pattern).test(string)) fail("invalid format");
  }
  if (schema.type === "boolean" && typeof value !== "boolean") fail("expected boolean");
  if (
    schema.type === "integer" &&
    (!Number.isSafeInteger(value) || Number(value) < (schema.minimum ?? -Infinity))
  )
    fail("invalid integer");
}
