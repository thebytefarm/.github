import assert from "node:assert/strict";
import { it } from "node:test";
import grade from "./grade.mjs";
import { cases, finding, head } from "./cases.mjs";
import { checkVerdict } from "../schemas.mts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("rejects false positives and missed defects rather than grading only word count", () => {
  const report = {
    reviewer: "bugs",
    head_sha: head,
    status: "complete",
    limitations: [],
    findings: [],
  };
  assert.equal(grade(JSON.stringify({ report }), { vars: { case: cases[0].name } }).pass, false);
  assert.equal(grade(JSON.stringify({ report }), { vars: { case: cases[1].name } }).pass, true);
  assert.equal(
    grade(JSON.stringify({ report: { ...report, findings: [finding("bugs")] } }), {
      vars: { case: cases[1].name },
    }).pass,
    false,
  );
});

it("rejects severity inflation on a bounded frozen-install failure", () => {
  const report = {
    reviewer: "bugs",
    head_sha: head,
    status: "complete",
    limitations: [],
    findings: [finding("bugs")],
  };
  assert.equal(grade(JSON.stringify({ report }), { vars: { case: cases[0].name } }).pass, true);
  const inflated = { ...report, findings: [finding("bugs", { severity: "high" })] };
  assert.equal(
    grade(JSON.stringify({ report: inflated }), { vars: { case: cases[0].name } }).pass,
    false,
  );
});

it("rejects verbose or machinery-filled comments instead of truncating evidence", () => {
  const verdict = (comment) => ({
    head_sha: head,
    summary: "Defect",
    groups: [{ title: "Defect", comment, finding_ids: ["bugs-1"] }],
  });
  checkVerdict(
    verdict(
      "The dependency pin and lockfile disagree, so frozen installs fail. Regenerate the lockfile.",
    ),
  );
  for (const comment of [
    "word ".repeat(76),
    "x".repeat(601),
    "### Defect\nFix this.",
    "Findings: bugs-1",
    "<details>More evidence</details>",
  ]) {
    assert.throws(() => checkVerdict(verdict(comment)));
  }
});

it("closes Codex stdin, hides tool logs, withholds API credentials, and removes fixture data", (test) => {
  const root = mkdtempSync(join(tmpdir(), "review-eval-transport-"));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "bin"));
  const report = {
    reviewer: "bugs",
    head_sha: head,
    status: "complete",
    limitations: [],
    findings: [finding("bugs")],
  };
  writeFileSync(
    join(root, "bin/codex"),
    `#!${process.execPath}\n
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    if (args.at(-1) !== '-') throw new Error('Expected stdin prompt');
    const prompt = fs.readFileSync(0, 'utf8');
    if (!prompt.includes('Reviewer: bugs')) throw new Error('Missing shipped prompt');
    if (process.env.OPENAI_API_KEY || process.env.GH_TOKEN) throw new Error('Leaked credentials');
    if (!args.includes('--ignore-user-config') || args[args.indexOf('--sandbox') + 1] !== 'read-only') throw new Error('Unsafe invocation');
    fs.writeFileSync(${JSON.stringify(join(root, "workspace"))}, process.cwd());
    fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], ${JSON.stringify(JSON.stringify(report))});
    console.error('Fixture tool chatter must not reach the user');
  `,
    { mode: 0o755 },
  );
  const provider = new URL("./provider.mjs", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {callApi} from ${JSON.stringify(provider)}; console.log(JSON.stringify(await callApi(${JSON.stringify(cases[0].name)})));`,
    ],
    {
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        PATH: `${join(root, "bin")}:${process.env.PATH}`,
        OPENAI_API_KEY: "must-not-forward",
        GH_TOKEN: "must-not-forward",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(JSON.parse(result.stdout).output), { report });
  assert.doesNotMatch(result.stderr, /Fixture tool chatter/);
  assert(!existsSync(readFileSync(join(root, "workspace"), "utf8")));
});
