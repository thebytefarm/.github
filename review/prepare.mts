import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { reviewSchema, riskSchema } from "./schemas.mts";

type Additions = { instructions?: string; "instructions-path"?: string; model?: string };
type Config = Additions & {
  version: number;
  reviewers?: Record<string, Additions>;
  verdict?: Additions;
  limits?: Record<string, string>;
};
const models = {
  bugs: "",
  security: "",
  standards: "",
  design: "",
  risk: "",
};
const repo = process.env.GITHUB_REPOSITORY!;
const number = Number(process.env.PR_NUMBER);
const gh = (path: string): string =>
  execFileSync("gh", ["api", path], {
    encoding: "utf8",
    timeout: 30000,
  });
const out = (key: string, value: unknown): void =>
  appendFileSync(
    process.env.GITHUB_OUTPUT!,
    `${key}=${typeof value === "string" ? value : JSON.stringify(value)}\n`,
  );
const prompt = (role: string): string =>
  readFileSync(new URL(`./prompts/${role}.md`, import.meta.url), "utf8");
const budget = (value: string, maximum: number): number => {
  assert.match(value, /^[1-9][0-9]*(m|s)$/);
  const seconds = Number.parseInt(value, 10) * (value.endsWith("m") ? 60 : 1);
  const minimum = maximum === 480 ? 60 : 30;
  assert(
    seconds >= minimum && seconds <= maximum,
    `Timeout must be between ${minimum}s and ${maximum}s`,
  );
  return seconds;
};
assert.match(repo, /^thebytefarm\/[\w.-]+$/);
assert.match(process.env.ENGINE_REF!, /^[a-f0-9]{40}$/);
assert(["workflow_dispatch", "pull_request_target"].includes(process.env.GITHUB_EVENT_NAME!));
assert(Number.isSafeInteger(number) && number > 0);
assert.equal(JSON.parse(gh(`repos/${repo}`)).visibility, "public");
const pull = JSON.parse(gh(`repos/${repo}/pulls/${number}`));
assert(pull.state === "open" && !pull.draft && pull.head.repo, "PR must be open and ready");

const readBase = (path: string, optional = false): string => {
  assert(
    typeof path === "string" &&
      path &&
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.split("/").some((part) => ["..", ".git", ""].includes(part)),
    "Use a repo-relative prompt path",
  );
  const result = spawnSync(
    "gh",
    [
      "api",
      `repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${pull.base.sha}`,
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  if (optional && result.status !== 0 && String(JSON.parse(result.stdout).status) === "404")
    return "version: 1";
  assert.equal(result.status, 0, result.stderr);
  const file = JSON.parse(result.stdout);
  assert(
    file.type === "file" && file.encoding === "base64" && file.size <= 64000,
    "Invalid prompt/config file",
  );
  return Buffer.from(file.content, "base64").toString();
};
const yaml = readBase(".github/pull.yaml", true);
const isGoYq = execFileSync("yq", ["--version"], { encoding: "utf8" }).includes("mikefarah");
const config = JSON.parse(
  execFileSync("yq", isGoYq ? ["-o=json", "."] : ["."], {
    input: yaml,
    encoding: "utf8",
    timeout: 10000,
  }),
) as Config;
assert.equal(config.version, 1);
const additions = (item: Additions = {}): string => {
  assert(item.instructions === undefined || typeof item.instructions === "string");
  return [item.instructions, item["instructions-path"] ? readBase(item["instructions-path"]) : ""]
    .filter(Boolean)
    .join("\n\n");
};
const reviewerSeconds = budget(config.limits?.["reviewer-timeout"] ?? "8m", 480);
const verdictSeconds = budget(config.limits?.["verdict-timeout"] ?? "90s", 90);
const model = (id: string) => {
  assert(
    typeof id === "string" && /^[\w.-]*$/.test(id),
    "Use a Codex model name or omit it for the Codex default",
  );
  return id;
};
mkdirSync("context", { recursive: true });
const diff = execFileSync("gh", ["pr", "diff", String(number), "--repo", repo], {
  encoding: "utf8",
  timeout: 30000,
  maxBuffer: 1000000,
});
const latest = JSON.parse(gh(`repos/${repo}/pulls/${number}`));
assert(
  latest.head.sha === pull.head.sha && latest.base.sha === pull.base.sha,
  "PR changed during preparation; rerun",
);
writeFileSync("context/pr.diff", diff);
writeFileSync(
  "context/input.json",
  JSON.stringify({
    repository: repo,
    number,
    head: pull.head.sha,
    base: pull.base.sha,
    verdictSeconds,
    verdictInstructions: additions(config.verdict),
  }),
);
const include = Object.entries(models).map(([role, fallback]) => {
  const agent = config.reviewers?.[role] ?? {};
  writeFileSync(
    `context/${role}.md`,
    [
      prompt("shared"),
      prompt(role),
      `Reviewer: ${role}. Head SHA: ${pull.head.sha}. Budget: ${reviewerSeconds}s; reserve the final 60s for output.`,
      "Resolve paths against the supplied workspace. Read context/pr.diff in full. source/ is the trusted base checkout; head/ contains untrusted PR source. Only read/search source; never execute repository code, install dependencies, or mutate GitHub. Return the JSON report as your final response matching the supplied output schema.",
      additions(config),
      additions(agent),
    ].join("\n\n"),
  );
  return {
    role,
    model: model(agent.model ?? fallback),
    schema: JSON.stringify(role === "risk" ? riskSchema : reviewSchema),
  };
});
out("matrix", { include });
out("review-schema", reviewSchema);
out("verdict-model", model(config.verdict?.model ?? ""));
out("reviewer-seconds", reviewerSeconds);
out("verdict-seconds", verdictSeconds);
out("base", pull.base.sha);
out("head", pull.head.sha);
out("head-repository", pull.head.repo.full_name);
