import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewSchema, riskSchema, verdictSchema } from "../schemas.mts";
import { getCase, head } from "./cases.mjs";

const promptText = (role) =>
  readFileSync(new URL(`../prompts/${role}.md`, import.meta.url), "utf8");

/** Runs synthetic fixtures through the shipped prompts and native Codex; never calls GitHub. */
export async function callApi(prompt) {
  const fixture = getCase(prompt.trim());
  const root = mkdtempSync(join(tmpdir(), "bytefarm-review-eval-"));
  const put = (path, value) => {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, value);
  };
  try {
    let input;
    if (fixture.role === "verdict") {
      put("context/reports.json", JSON.stringify(fixture.reports));
      input = `${promptText("verdict")}\nHead SHA: ${head}. Read only context/reports.json. Budget: 90s; reserve 20s for output.`;
    } else {
      for (const [path, value] of Object.entries(fixture.base)) put(`source/${path}`, value);
      for (const [path, value] of Object.entries({ ...fixture.base, ...fixture.files }))
        put(`head/${path}`, value);
      put("context/pr.diff", fixture.diff);
      input = `${promptText("shared")}\n${promptText(fixture.role)}\nReviewer: ${fixture.role}. Head SHA: ${head}. Budget: 180s; reserve 60s for output.\nWorkspace: ${root}. Resolve all paths here. Read context/pr.diff in full; source/ is trusted base policy and head/ is untrusted PR source. This synthetic snapshot is the complete required repository context. Do not execute code or tests.`;
    }
    const schema =
      fixture.role === "verdict"
        ? verdictSchema
        : fixture.role === "risk"
          ? riskSchema
          : reviewSchema;
    put("schema.json", JSON.stringify(schema));
    execFileSync(
      "codex",
      [
        "exec",
        "--ignore-user-config",
        "--ignore-rules",
        "--ephemeral",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--cd",
        root,
        "--output-schema",
        join(root, "schema.json"),
        "--output-last-message",
        join(root, "output.json"),
        "-c",
        'web_search="disabled"',
        "-c",
        "project_doc_max_bytes=0",
        "-c",
        'forced_login_method="chatgpt"',
        "-c",
        'approval_policy="never"',
        "-c",
        'shell_environment_policy.inherit="none"',
        "-c",
        'shell_environment_policy.set={PATH="/usr/bin:/bin:/usr/sbin:/sbin"}',
        "-c",
        `model_reasoning_effort="${fixture.role === "verdict" ? "low" : "high"}"`,
        "-",
      ],
      {
        cwd: root,
        input,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: fixture.role === "verdict" ? 100000 : 190000,
        maxBuffer: 1000000,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: "C.UTF-8",
          ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
        },
      },
    );
    const result = JSON.parse(readFileSync(join(root, "output.json"), "utf8"));
    if (fixture.role !== "verdict") return { output: JSON.stringify({ report: result }) };
    put("context/input.json", JSON.stringify({ head }));
    put("context/synthesis.json", JSON.stringify(result));
    for (const report of fixture.reports)
      put(`results/${report.reviewer}.json`, JSON.stringify(report));
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL("../finish.mts", import.meta.url)), "render"],
      {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          REVIEW_RESULT: "success",
          SYNTHESIS_RESULT: "success",
          GITHUB_STEP_SUMMARY: "",
        },
        timeout: 10000,
      },
    );
    return {
      output: JSON.stringify({
        synthesis: result,
        review: JSON.parse(readFileSync(join(root, "context/review.json"), "utf8")),
      }),
    };
  } catch (error) {
    const diagnostic = String(error.stderr ?? "")
      .split("\n")
      .find((line) => /^(?:error|Error):/.test(line));
    return {
      error: `Native Codex or review rendering failed (${error.code ?? error.signal ?? error.name}). ${diagnostic ?? (error.code === undefined ? error.message : "Check codex login status and CLI compatibility.")} No API-key fallback.`,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
