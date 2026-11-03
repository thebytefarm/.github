import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Accepts only Codex's ChatGPT login format, never an API-key fallback. */
export function subscriptionAuth(json: string): string {
  assert(json, "CODEX_AUTH_JSON must contain a dedicated Codex ChatGPT login");
  let auth;
  try {
    auth = JSON.parse(json);
  } catch {
    throw new Error("CODEX_AUTH_JSON is not valid Codex login JSON");
  }
  assert(
    auth && !auth.OPENAI_API_KEY && (!auth.auth_mode || auth.auth_mode === "chatgpt"),
    "ChatGPT subscription authentication is required",
  );
  for (const key of ["id_token", "access_token", "refresh_token"])
    assert(
      typeof auth.tokens?.[key] === "string" && auth.tokens[key].length > 0,
      "Incomplete Codex ChatGPT login",
    );
  return JSON.stringify({ ...auth, auth_mode: "chatgpt", OPENAI_API_KEY: null });
}

/** Grants tools read access to review data and minimal system binaries, not the runner or auth home. */
export function permissionConfig(workspace: string, home: string, synthesis: boolean): string {
  const root = realpathSync(workspace);
  const paths = synthesis ? ["context/reports.json"] : ["source", "head", "context/pr.diff"];
  const allowed = paths.map((path) => {
    const absolute = realpathSync(resolve(root, path));
    assert(absolute.startsWith(`${root}/`), "Review data escaped the workspace");
    return `${JSON.stringify(absolute)} = "read"`;
  });
  return [
    'default_permissions = "review"',
    'approval_policy = "never"',
    'forced_login_method = "chatgpt"',
    'cli_auth_credentials_store = "file"',
    'web_search = "disabled"',
    "project_doc_max_bytes = 0",
    "[shell_environment_policy]",
    'inherit = "none"',
    "[permissions.review.network]",
    "enabled = false",
    "[permissions.review.filesystem]",
    '":minimal" = "read"',
    ...allowed,
    ...[
      home,
      "/proc",
      "/run",
      "/var/run",
      ...(!synthesis ? [join(root, "source/.git"), join(root, "head/.git")] : []),
    ].map((path) => `${JSON.stringify(path)} = "deny"`),
  ].join("\n");
}

/** Applies the same Linux privilege reduction and process-group deadline to Codex and sandbox probes. */
export function restrictedArgs(
  binary: string,
  env: Record<string, string>,
  seconds: number,
  args: string[],
): string[] {
  return [
    "-n",
    "setpriv",
    "--reuid",
    String(process.getuid!()),
    "--regid",
    String(process.getgid!()),
    "--clear-groups",
    "--no-new-privs",
    "--bounding-set=-all",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "env",
    "-i",
    ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
    "/usr/bin/timeout",
    "--signal=KILL",
    `${seconds}s`,
    binary,
    ...args,
  ];
}

/** Runs native Codex with a private subscription login and an enforced read-only permission profile. */
export function runAgent(options: {
  workspace: string;
  prompt: string;
  schema: unknown;
  model: string;
  seconds: number;
  authJson: string;
  temporary: string;
  synthesis: boolean;
}): unknown {
  const auth = subscriptionAuth(options.authJson);
  assert(Number.isSafeInteger(options.seconds) && options.seconds > 0 && options.seconds <= 480);
  assert(
    typeof options.model === "string" && /^[\w.-]*$/.test(options.model),
    "Use a Codex model name, not a provider URL",
  );
  const directory = mkdtempSync(join(options.temporary, "codex-review-"));
  const home = join(directory, "home");
  const cwd = join(directory, "work");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(cwd, { mode: 0o700 });
  try {
    writeFileSync(join(home, "auth.json"), auth, { mode: 0o600 });
    writeFileSync(
      join(home, "config.toml"),
      permissionConfig(options.workspace, home, options.synthesis),
    );
    const schema = join(directory, "schema.json");
    const output = join(directory, "result.json");
    writeFileSync(schema, JSON.stringify(options.schema));
    const binary = execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
    const env = { PATH: process.env.PATH!, HOME: home, CODEX_HOME: home, LANG: "C.UTF-8" };
    const args = restrictedArgs(binary, env, options.seconds, [
      "exec",
      "--strict-config",
      "--ephemeral",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--cd",
      cwd,
      "--output-schema",
      schema,
      "--output-last-message",
      output,
      "-c",
      `model_reasoning_effort="${options.synthesis ? "low" : "high"}"`,
      ...(options.model ? ["--model", options.model] : []),
      "-",
    ]);
    try {
      execFileSync("sudo", args, {
        cwd,
        env,
        input: `Workspace: ${realpathSync(options.workspace)}. Resolve all review paths against that workspace, not your empty working directory.\n\n${options.prompt}`,
        encoding: "utf8",
        timeout: options.seconds * 1000 + 5000,
        killSignal: "SIGKILL",
        maxBuffer: 1000000,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      throw new Error(
        "Codex failed or timed out; no approval. No unsandboxed or API-key fallback.",
      );
    }
    return JSON.parse(readFileSync(output, "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = runAgent({
    workspace: process.cwd(),
    prompt: readFileSync(process.env.PROMPT_PATH!, "utf8"),
    schema: JSON.parse(process.env.OUTPUT_SCHEMA!),
    model: process.env.MODEL!,
    seconds: Number(process.env.SECONDS),
    authJson: process.env.CODEX_AUTH_JSON!,
    temporary: process.env.RUNNER_TEMP!,
    synthesis: process.env.ROLE === "verdict",
  });
  writeFileSync(process.env.RESULT_PATH!, JSON.stringify(result));
}
