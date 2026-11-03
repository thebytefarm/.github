import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { permissionConfig, restrictedArgs, subscriptionAuth } from "./agent.mts";
import { checkReport, checkVerdict } from "./schemas.mts";

it("uses only ChatGPT subscription login and rejects API-key fallbacks", () => {
  const tokens = {
    id_token: "fixture-id",
    access_token: "fixture-access",
    refresh_token: "fixture-refresh",
  };
  assert.equal(JSON.parse(subscriptionAuth(JSON.stringify({ tokens }))).auth_mode, "chatgpt");
  for (const auth of [
    "",
    "not-json-fixture-secret",
    "null",
    JSON.stringify({ OPENAI_API_KEY: "fixture-api-key", tokens }),
    JSON.stringify({ auth_mode: "apiKey", tokens }),
    JSON.stringify({ tokens: {} }),
  ])
    assert.throws(
      () => subscriptionAuth(auth),
      (error: Error) =>
        !error.message.includes("fixture-secret") && !error.message.includes("fixture-api-key"),
    );
});

it("denies tool writes, network, credentials, and Git metadata through a named Codex profile", (test) => {
  const root = mkdtempSync(join(tmpdir(), "read-only-review-"));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  for (const tree of ["source", "head", "context"]) mkdirSync(join(root, tree));
  writeFileSync(join(root, "context/pr.diff"), "public diff");
  writeFileSync(join(root, "context/reports.json"), "[]");
  const home = join(root, "private-auth");
  const config = permissionConfig(root, home, false);
  assert.match(config, /default_permissions = "review"/);
  assert.match(config, /approval_policy = "never"/);
  assert.match(config, /\[permissions.review.network\]\nenabled = false/);
  assert.match(config, /inherit = "none"/);
  assert.match(config, /private-auth" = "deny"/);
  assert.match(config, /source\/\.git" = "deny"/);
  assert.doesNotMatch(config, /"write"|":root"|workspace_roots/);
  const synthesis = permissionConfig(root, home, true);
  assert.match(synthesis, /context\/reports.json" = "read"/);
  assert.doesNotMatch(synthesis, /source" = "read"|head" = "read"|pr.diff" = "read"/);
});

it("rejects top-level review-data symlinks outside the workspace", (test) => {
  const root = mkdtempSync(join(tmpdir(), "codex-profile-"));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  symlinkSync(tmpdir(), join(root, "source"));
  assert.throws(() => permissionConfig(root, join(root, "auth"), false), /escaped/);
});

it("rejects malformed report and synthesis shapes before approval", () => {
  for (const value of [null, {}, { head_sha: "a".repeat(40), groups: [] }]) {
    assert.throws(() => checkReport(value));
    assert.throws(() => checkVerdict(value));
  }
  checkVerdict({ head_sha: "a".repeat(40), summary: "No findings", groups: [] });
});

it("launches native Codex with sanitized environment, time limit, and schema, then removes auth", (test) => {
  const root = mkdtempSync(join(tmpdir(), "agent-transport-"));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "context"));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "context/reports.json"), "[]");
  writeFileSync(join(root, "context/prompt.md"), "Summarize");
  writeFileSync(join(root, "bin/codex"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const result = { head_sha: "a".repeat(40), summary: "No findings", groups: [] };
  writeFileSync(
    join(root, "bin/sudo"),
    `#!${process.execPath}\n` +
      `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const home = process.env.CODEX_HOME;
    const output = args[args.indexOf('--output-last-message') + 1];
    const observed = { args, config: fs.readFileSync(home + '/config.toml', 'utf8'),
      env: Object.keys(process.env), authMode: JSON.parse(fs.readFileSync(home + '/auth.json', 'utf8')).auth_mode,
      authModeBits: fs.statSync(home + '/auth.json').mode & 511, home };
    fs.readFileSync(0, 'utf8');
    fs.writeFileSync(${JSON.stringify(join(root, "observed.json"))}, JSON.stringify(observed));
    fs.writeFileSync(output, ${JSON.stringify(JSON.stringify(result))});
  `,
    { mode: 0o755 },
  );
  execFileSync(process.execPath, [new URL("./agent.mts", import.meta.url).pathname], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      RUNNER_TEMP: root,
      CODEX_AUTH_JSON: JSON.stringify({
        tokens: {
          id_token: "fixture-id",
          access_token: "fixture-access",
          refresh_token: "fixture-refresh",
        },
      }),
      GH_TOKEN: "must-not-reach-codex",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "must-not-reach-codex",
      PROMPT_PATH: "context/prompt.md",
      OUTPUT_SCHEMA: "{}",
      MODEL: "",
      SECONDS: "30",
      ROLE: "verdict",
      RESULT_PATH: "context/result.json",
    },
  });
  assert.deepEqual(JSON.parse(readFileSync(join(root, "context/result.json"), "utf8")), result);
  const observed = JSON.parse(readFileSync(join(root, "observed.json"), "utf8"));
  for (const flag of [
    "--no-new-privs",
    "--clear-groups",
    "--strict-config",
    "--ephemeral",
    "--ignore-rules",
    "--signal=KILL",
    "30s",
    "--output-schema",
  ])
    assert(observed.args.includes(flag));
  assert(!observed.args.includes("--model"));
  assert.equal(observed.authMode, "chatgpt");
  assert.equal(observed.authModeBits, 0o600);
  assert(!observed.env.some((key: string) => /TOKEN|KEY|AUTH/.test(key)));
  assert.throws(() => readFileSync(join(observed.home, "auth.json")));
  writeFileSync(
    join(root, "bin/sudo"),
    "#!/bin/sh\necho credential-must-not-be-logged >&2\nexit 1\n",
    { mode: 0o755 },
  );
  const failed = spawnSync(process.execPath, [new URL("./agent.mts", import.meta.url).pathname], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      RUNNER_TEMP: root,
      CODEX_AUTH_JSON: JSON.stringify({
        tokens: {
          id_token: "fixture-id",
          access_token: "fixture-access",
          refresh_token: "fixture-refresh",
        },
      }),
      PROMPT_PATH: "context/prompt.md",
      OUTPUT_SCHEMA: "{}",
      MODEL: "",
      SECONDS: "30",
      ROLE: "verdict",
      RESULT_PATH: "context/failed.json",
    },
    encoding: "utf8",
  });
  assert.notEqual(failed.status, 0);
  assert.doesNotMatch(failed.stderr, /credential-must-not-be-logged/);
  assert.throws(() => readFileSync(join(root, "context/failed.json")));
});

it("withholds write credentials and OIDC from preparation, specialists, and synthesis", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/pull-review.yml", import.meta.url),
    "utf8",
  );
  const workers = workflow.split("\n  publish:")[0];
  assert.doesNotMatch(
    workers,
    /id-token: write|GH_TOKEN:.*identity|pullfrog\/pullfrog@|get-installation-token/,
  );
  assert.match(workers, /GH_TOKEN: \$\{\{ github.token \}\}/);
  const publisher = workflow.split("\n  publish:")[1];
  assert.match(publisher, /get-installation-token/);
  assert.doesNotMatch(publisher, /agent\.mts|CODEX_AUTH_JSON/);
  assert.doesNotMatch(workers, /SYNTHETIC|OPENAI_API_KEY/);
});

it(
  "enforces read, write, credential, symlink, and network denials in the native Codex sandbox",
  { skip: process.env.CODEX_SANDBOX_TESTS !== "true" },
  async (test) => {
    const root = mkdtempSync(join(tmpdir(), "codex-native-sandbox-"));
    test.after(() => rmSync(root, { recursive: true, force: true }));
    for (const tree of ["source", "head", "context", "home", "work"]) mkdirSync(join(root, tree));
    writeFileSync(join(root, "context/pr.diff"), "diff");
    writeFileSync(join(root, "context/reports.json"), "[]");
    writeFileSync(join(root, "source/read.txt"), "public-source");
    writeFileSync(join(root, "home/private.txt"), "private-credential-fixture");
    symlinkSync(join(root, "home/private.txt"), join(root, "source/escape"));
    const home = join(root, "home");
    const env = { PATH: process.env.PATH!, HOME: home, CODEX_HOME: home, LANG: "C.UTF-8" };
    const binary = execFileSync("which", ["codex"], { encoding: "utf8" }).trim();
    const command = (args: string[]) => {
      const cliArgs = [
        "sandbox",
        "--permission-profile",
        "review",
        "--cd",
        join(root, "work"),
        "--",
        ...args,
      ];
      return process.platform === "linux"
        ? { file: "sudo", args: restrictedArgs(binary, env, 10, cliArgs) }
        : { file: binary, args: cliArgs };
    };
    const invoke = (args: string[]) => {
      const cmd = command(args);
      return spawnSync(cmd.file, cmd.args, { env, encoding: "utf8", timeout: 15000 });
    };
    writeFileSync(join(home, "config.toml"), permissionConfig(root, home, false));
    const allowed = invoke(["/bin/cat", join(root, "source/read.txt")]);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(allowed.stdout.trim(), "public-source");
    for (const path of [join(home, "private.txt"), join(root, "source/escape")]) {
      const denied = invoke(["/bin/cat", path]);
      assert.notEqual(denied.status, 0);
      assert(!denied.stdout.includes("private-credential-fixture"));
    }
    assert.notEqual(
      invoke(["/bin/sh", "-c", 'echo bad > "$1"', "sh", join(root, "source/new.txt")]).status,
      0,
    );
    assert.throws(() => readFileSync(join(root, "source/new.txt")));
    const server = createServer((_request, response) => response.end("network-must-be-denied"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    test.after(() => server.close());
    const address = server.address();
    assert(address && typeof address === "object");
    const network = command([
      "/usr/bin/curl",
      "--fail",
      "--max-time",
      "2",
      `http://127.0.0.1:${address.port}`,
    ]);
    await assert.rejects(promisify(execFile)(network.file, network.args, { env, timeout: 15000 }));
    writeFileSync(join(home, "config.toml"), permissionConfig(root, home, true));
    assert.equal(invoke(["/bin/cat", join(root, "context/reports.json")]).status, 0);
    assert.notEqual(invoke(["/bin/cat", join(root, "source/read.txt")]).status, 0);
  },
);
