import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { defaults, reviewers } from "./config.mts";

const cli = fileURLToPath(new URL("./cli.mts", import.meta.url));
const sha = "a".repeat(40);
const fixture = (run: (directory: string) => void): void => {
  const directory = mkdtempSync(join(tmpdir(), "bytefarm-cli-"));
  try {
    mkdirSync(join(directory, "context"));
    mkdirSync(join(directory, "results"));
    writeFileSync(
      join(directory, "context/metadata.json"),
      JSON.stringify({
        repository: "thebytefarm/ciderpress",
        number: 1,
        url: "https://example.invalid/1",
        head_sha: sha,
        base_sha: "b".repeat(40),
        head_repository: "thebytefarm/ciderpress",
        files: ["src/example.ts"],
        policy_paths: ["AGENTS.md"],
        config: defaults,
      }),
    );
    for (const role of reviewers)
      writeFileSync(
        join(directory, `results/${role}.json`),
        JSON.stringify({
          head_sha: sha,
          reviewer: role,
          status: "complete",
          findings: [],
          limitations: [],
        }),
      );
    writeFileSync(
      join(directory, "results/verdict.json"),
      JSON.stringify({ head_sha: sha, summary: "No findings.", groups: [] }),
    );
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

it("generates an approval artifact without credentials or publishing", () => {
  fixture((directory) => {
    const result = spawnSync(process.execPath, [cli, "finalize"], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PUBLISH: "false",
        GH_TOKEN: "",
        GITHUB_STEP_SUMMARY: "",
        GITHUB_OUTPUT: "",
        NEEDS_JSON: "{}",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(join(directory, "context/review.md"), "utf8"), /## Approved/);
  });
});

it("fails closed when a worker job failed despite valid-looking result files", () => {
  fixture((directory) => {
    const result = spawnSync(process.execPath, [cli, "finalize"], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PUBLISH: "false",
        GH_TOKEN: "",
        GITHUB_STEP_SUMMARY: "",
        GITHUB_OUTPUT: "",
        NEEDS_JSON: JSON.stringify({ review: { result: "failure" } }),
      },
    });
    assert.equal(result.status, 1);
    const body = readFileSync(join(directory, "context/review.md"), "utf8");
    assert.match(body, /Review incomplete/);
    assert.match(body, /Failed or incomplete jobs/);
    assert.doesNotMatch(body, /## Approved/);
  });
});

it("fails closed and writes a diagnostic artifact for a missing reviewer", () => {
  fixture((directory) => {
    rmSync(join(directory, "results/security.json"));
    const result = spawnSync(process.execPath, [cli, "finalize"], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PUBLISH: "false",
        GH_TOKEN: "",
        GITHUB_STEP_SUMMARY: "",
        GITHUB_OUTPUT: "",
        NEEDS_JSON: "{}",
      },
    });
    assert.equal(result.status, 1);
    assert.match(readFileSync(join(directory, "context/review.md"), "utf8"), /Review incomplete/);
  });
});
