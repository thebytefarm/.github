import assert from "node:assert/strict";

export type Risk = {
  level: "low" | "medium" | "high" | "critical";
  impact: string;
  likelihood: string;
  rationale: string;
  release: boolean;
};

type Pull = {
  state: string;
  draft: boolean;
  title: string;
  head: { sha: string; ref: string };
  base: { sha: string };
  labels: { name: string }[];
};

/** Rejects absent or malformed risk output before it can participate in a decision. */
export function checkRisk(value: unknown): asserts value is Risk {
  assert(value && typeof value === "object", "Missing risk assessment");
  const risk = value as Record<string, unknown>;
  assert(
    typeof risk.level === "string" && ["low", "medium", "high", "critical"].includes(risk.level),
    "Invalid risk level",
  );
  for (const key of ["impact", "likelihood", "rationale"]) {
    assert(
      typeof risk[key] === "string" && risk[key].trim().length > 0 && risk[key].length <= 4000,
      `Missing risk ${key}`,
    );
  }
  assert(typeof risk.release === "boolean", "Missing release assessment");
}

/** Release signals are a hard exclusion, independent of the model's rating. */
export function isRelease(pull: Pull, files: string[]): boolean {
  return (
    /\b(release|releases|version packages|publish)\b/i.test(pull.title) ||
    /(^|[/_-])(release|releases|changeset-release|release-please)([/_-]|$)/i.test(pull.head.ref) ||
    pull.labels.some((label) => /release|publish/i.test(label.name)) ||
    files.some(
      (path) =>
        /(^|\/)(CHANGELOG\.md|\.release-please-manifest\.json)$/i.test(path) ||
        path === ".changeset/pre.json",
    )
  );
}

/** Computes eligibility only; callers must enforce branch rules and atomic head matching. */
export function mergeBlocker(input: {
  pull: Pull;
  files: string[];
  reviewedHead: string;
  reviewedBase: string;
  decision: string;
  risk: unknown;
  ci: "passed" | "pending" | "failed" | "missing";
}): string | undefined {
  if (isRelease(input.pull, input.files)) return "Release PRs require a human";
  if (input.pull.state !== "open" || input.pull.draft) return "PR is not open and ready";
  if (input.pull.head.sha !== input.reviewedHead || input.pull.base.sha !== input.reviewedBase)
    return "PR changed since review";
  if (input.decision !== "APPROVE") return "Reviews are incomplete or have blockers";
  try {
    checkRisk(input.risk);
  } catch {
    return "Risk assessment is missing or invalid";
  }
  if (input.risk.level !== "low") return "Only low-risk changes are eligible";
  if (input.risk.release) return "Release PRs require a human";
  if (input.ci !== "passed") return "Current CI has not passed";
  return undefined;
}

/** Version bumps are release signals even when a PR is renamed or unlabeled. */
export function hasVersionBump(
  files: { filename: string; previous_filename?: string; patch?: string; status?: string }[],
): boolean {
  return files.some((file) => {
    const manifest = /(^|\/)(package\.json|Cargo\.toml|pyproject\.toml)$/;
    if (!manifest.test(file.filename) && !manifest.test(file.previous_filename ?? "")) return false;
    if (!file.patch || ["renamed", "removed"].includes(file.status ?? "")) return true;
    return file.patch.split("\n").some((line) => {
      if (!/^[+-](?![+-])/.test(line)) return false;
      if (file.filename.endsWith("package.json")) return /"version"\s*:/.test(line);
      return (
        /^[+-]\s*(?:(?:workspace\.)?package\.)?(?:version|["']version["'])\s*=/.test(line) ||
        /^[+-]\s*package\s*=.*\bversion\s*=/.test(line)
      );
    });
  });
}

type Check = {
  name: string;
  status: string;
  conclusion: string | null;
  check_suite: { id: number };
  app: { id: number };
};
type Status = { context: string; state: string };

/** Ignores only this review's suite/status; absence or pending checks never count as green CI. */
export function ciState(
  checks: Check[],
  statuses: Status[],
  ownSuite: number,
): "passed" | "pending" | "failed" | "missing" {
  const other = checks.filter((check) => check.check_suite.id !== ownSuite);
  const latest = [
    ...new Map(
      statuses
        .filter((status) => status.context !== "bytefarm/review")
        .reverse()
        .map((status) => [status.context, status]),
    ).values(),
  ];
  if (
    other.some(
      (check) =>
        check.status === "completed" &&
        !["success", "neutral", "skipped"].includes(check.conclusion ?? ""),
    ) ||
    latest.some((status) => ["error", "failure"].includes(status.state))
  )
    return "failed";
  if (
    other.some((check) => check.status !== "completed") ||
    latest.some((status) => status.state === "pending")
  )
    return "pending";
  if (
    other.some((check) => check.conclusion === "success") ||
    latest.some((status) => status.state === "success")
  )
    return "passed";
  return "missing";
}
