import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import models from "./models.json" with { type: "json" };
import { configSchema, validate } from "./schemas.mts";
import type { AgentConfig, PullConfig, Reviewer } from "./types.mts";

/** Required specialist roles; none may be disabled by repository config. */
export const reviewers: readonly Reviewer[] = ["bugs", "security", "standards", "design"];
const defaultAgent = (model: string): AgentConfig => ({
  model,
  instructions: "",
  "instructions-path": "",
});

/** Central defaults; repository overrides cannot change verdict logic or permissions. */
export const defaults: PullConfig = {
  version: 1,
  instructions: "",
  "instructions-path": "",
  reviewers: {
    bugs: defaultAgent("hf:zai-org/GLM-5.3"),
    security: defaultAgent("hf:zai-org/GLM-5.3"),
    standards: defaultAgent("hf:deepseek-ai/DeepSeek-V4.1-Flash-1017"),
    design: defaultAgent("hf:zai-org/GLM-5.3-Flash"),
  },
  verdict: { model: "hf:openai/gpt-oss-120b" },
  limits: { "reviewer-timeout": "8m", "verdict-timeout": "90s" },
};

/** Parses a deliberately narrow duration format, in seconds. */
export function durationSeconds(value: string): number {
  if (!/^[1-9][0-9]*(s|m)$/.test(value)) throw new Error(`Invalid duration: ${value}`);
  return Number.parseInt(value, 10) * (value.endsWith("m") ? 60 : 1);
}

/** Limits prompt references to normal, repository-relative file paths. */
export function assertSafePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    [...path].some((char) => char.charCodeAt(0) < 32) ||
    path.split("/").some((part) => ["", ".", "..", ".git"].includes(part))
  ) {
    throw new Error(`Unsafe repository-relative path: ${JSON.stringify(path)}`);
  }
}

/** Returns catalog-backed token limits, rejecting unknown model IDs. */
export function modelLimits(model: string): { context: number; output: number } {
  if (!Object.hasOwn(models, model))
    throw new Error(`Unsupported Synthetic model: ${model}; update review/models.json centrally`);
  return models[model as keyof typeof models];
}

/** Parses safe YAML without installing a package; Ruby/Psych ships on the runner. */
export function parseYaml(source: string): unknown {
  if (source.length > 64000) throw new Error("Config exceeds 64 KB");
  return JSON.parse(
    execFileSync("ruby", [fileURLToPath(new URL("./yaml-to-json.rb", import.meta.url))], {
      input: source,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 128000,
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
}

/** Validates config, applies defaults, and enforces central runtime/model limits. */
export function resolveConfig(value: unknown): PullConfig {
  validate(configSchema, value);
  const raw = value as Partial<Omit<PullConfig, "reviewers" | "limits" | "verdict">> & {
    reviewers?: Partial<Record<Reviewer, Partial<AgentConfig>>>;
    verdict?: Partial<PullConfig["verdict"]>;
    limits?: Partial<PullConfig["limits"]>;
  };
  const config: PullConfig = {
    ...defaults,
    ...raw,
    reviewers: Object.fromEntries(
      reviewers.map((role) => [role, { ...defaults.reviewers[role], ...raw.reviewers?.[role] }]),
    ) as Record<Reviewer, AgentConfig>,
    verdict: { ...defaults.verdict, ...raw.verdict },
    limits: { ...defaults.limits, ...raw.limits },
  };
  for (const agent of [config, ...Object.values(config.reviewers)]) {
    if (agent["instructions-path"]) assertSafePath(agent["instructions-path"]);
  }
  for (const agent of [...Object.values(config.reviewers), config.verdict])
    modelLimits(agent.model);
  const seconds = durationSeconds(config.limits["reviewer-timeout"]);
  if (seconds < 60 || seconds > 480) throw new Error("Reviewer timeout must be between 60s and 8m");
  const verdictSeconds = durationSeconds(config.limits["verdict-timeout"]);
  if (verdictSeconds < 30 || verdictSeconds > 90)
    throw new Error("Verdict timeout must be between 30s and 90s");
  return config;
}
