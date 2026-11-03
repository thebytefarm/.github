import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { localTools, runAgent } from "./agent.mts";
import { checkReport, checkVerdict } from "./schemas.mts";

it("allows local review data but denies symlink escapes, credentials, writes, and commands", (test) => {
  const root = mkdtempSync(join(tmpdir(), "read-only-review-"));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  for (const tree of ["source", "head", "context", "engine"]) mkdirSync(join(root, tree));
  execFileSync("git", ["init", "--quiet", join(root, "source")]);
  writeFileSync(join(root, "source/a.ts"), "const answer = 42;\n");
  execFileSync("git", ["-C", join(root, "source"), "add", "a.ts"]);
  writeFileSync(join(root, "engine/secret"), "must not be exposed");
  symlinkSync(join(root, "engine/secret"), join(root, "source/escape"));
  writeFileSync(join(root, "context/pr.diff"), "public diff");
  writeFileSync(join(root, "context/reports.json"), "[]");
  const tool = localTools(root, false);
  assert.deepEqual(tool("list_files", { root: "source" }), {
    files: ["source/a.ts"],
    truncated: false,
  });
  assert.match(JSON.stringify(tool("read_file", { path: "source/a.ts" })), /answer/);
  assert.match(JSON.stringify(tool("search_text", { root: "source", query: "42" })), /answer/);
  for (const path of [
    "source/escape",
    "engine/secret",
    "context/reports.json",
    "source/.git/config",
    "../secret",
  ])
    assert.throws(() => tool("read_file", { path }));
  for (const name of ["shell", "write_file", "merge", "create_pull_request_review", "fetch"])
    assert.throws(() => tool(name, { path: "source/a.ts", query: "overwrite" }));
  assert.equal(readFileSync(join(root, "source/a.ts"), "utf8"), "const answer = 42;\n");
  const synthesis = localTools(root, true);
  assert.match(JSON.stringify(synthesis("read_file", { path: "context/reports.json" })), /\[\]/);
  for (const path of ["source/a.ts", "context/pr.diff", "engine/secret"])
    assert.throws(() => synthesis("read_file", { path }));
  assert.throws(() => synthesis("list_files", { root: "source" }));
});

it("keeps all file lines readable without silently truncating long tool output", (test) => {
  const root = mkdtempSync(join(tmpdir(), "read-pages-"));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "context"));
  writeFileSync(
    join(root, "context/pr.diff"),
    Array.from({ length: 401 }, (_, i) => `line ${i + 1}`).join("\n"),
  );
  const tool = localTools(root, false);
  assert.equal(
    (tool("read_file", { path: "context/pr.diff" }) as { next_offset: number }).next_offset,
    201,
  );
  const last = tool("read_file", { path: "context/pr.diff", offset: 401 }) as {
    next_offset: null;
    text: string;
  };
  assert.equal(last.next_offset, null);
  assert.equal(last.text, "401: line 401");
});

it("rejects malformed report and synthesis shapes before approval", () => {
  for (const value of [null, {}, { head_sha: "a".repeat(40), groups: [] }]) {
    assert.throws(() => checkReport(value));
    assert.throws(() => checkVerdict(value));
  }
  checkVerdict({ head_sha: "a".repeat(40), summary: "No findings", groups: [] });
});

it("offers only read tools and structured output over the fixed model transport", async (test) => {
  const root = mkdtempSync(join(tmpdir(), "agent-transport-"));
  test.after(() => rmSync(root, { recursive: true, force: true }));
  const result = { head_sha: "a".repeat(40), summary: "No findings", groups: [] };
  // Transport fixture: no paid inference, credentials, or GitHub requests.
  test.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://api.synthetic.new/openai/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    assert.deepEqual(
      body.tools.map((tool: { function: { name: string } }) => tool.function.name),
      ["read_file", "set_output"],
    );
    assert(!JSON.stringify(body).includes("fixture-key"));
    return Response.json({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "output", function: { name: "set_output", arguments: JSON.stringify(result) } },
            ],
          },
        },
      ],
    });
  });
  assert.deepEqual(
    await runAgent({
      workspace: root,
      prompt: "Summarize",
      schema: {},
      model: "hf:test",
      seconds: 30,
      context: 10000,
      output: 1000,
      key: "fixture-key",
      synthesis: true,
    }),
    result,
  );
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
  assert.doesNotMatch(publisher, /agent\.mts|SYNTHETIC_API_KEY/);
});
