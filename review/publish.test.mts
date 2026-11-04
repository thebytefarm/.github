import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

const head = "a".repeat(40);
const base = "b".repeat(40);
const endpoint = "repos/thebytefarm/fixture/pulls/7";
const pull = () => ({
  state: "open",
  draft: false,
  title: "fix: isolated change",
  labels: [],
  head: { sha: head, ref: "fix/isolated" },
  base: { sha: base },
  changed_files: 1,
  mergeable: true,
  mergeable_state: "clean",
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "publish-transport-"));
  mkdirSync(join(root, "context"));
  mkdirSync(join(root, "bin"));
  const decision = {
    repository: "thebytefarm/fixture",
    number: 7,
    head,
    base,
    event: "APPROVE",
    risk: {
      level: "low",
      impact: "Isolated",
      likelihood: "Covered",
      rationale: "Reversible",
      release: false,
    },
  };
  writeFileSync(join(root, "context/decision.json"), JSON.stringify(decision));
  writeFileSync(join(root, "context/review.md"), "Fixture review");
  writeFileSync(
    join(root, "context/review.json"),
    JSON.stringify({ body: "Fixture review", comments: [] }),
  );
  const routes: Record<string, unknown> = {
    "repos/thebytefarm/fixture": { visibility: "public" },
    [endpoint]: pull(),
    [`${endpoint}/files?per_page=100`]: [
      [{ filename: "src/fix.ts", status: "modified", patch: "+fixed" }],
    ],
    "repos/thebytefarm/fixture/actions/runs/99": { check_suite_id: 1 },
    [`repos/thebytefarm/fixture/commits/${head}/check-runs?filter=latest&per_page=100`]: [
      {
        check_runs: [
          {
            name: "test",
            status: "completed",
            conclusion: "success",
            check_suite: { id: 2 },
            app: { id: 1 },
          },
          {
            name: "publish",
            status: "in_progress",
            conclusion: null,
            check_suite: { id: 1 },
            app: { id: 1 },
          },
        ],
      },
    ],
    [`repos/thebytefarm/fixture/commits/${head}/statuses?per_page=100`]: [
      [{ context: "bytefarm/review", state: "success" }],
    ],
    [`repos/thebytefarm/fixture/actions/runs?head_sha=${head}&per_page=100`]: [
      {
        workflow_runs: [
          {
            id: 100,
            workflow_id: 10,
            event: "pull_request",
            status: "completed",
            conclusion: "success",
          },
        ],
      },
    ],
  };
  // A recorded-shape gh transport, not a replacement for the merge policy or publisher.
  writeFileSync(
    join(root, "bin/gh"),
    `#!${process.execPath}\n` +
      `
    const fs = require('node:fs');
    const args = process.argv.slice(2), path = args[1];
    const method = args.includes('--method') ? args[args.indexOf('--method') + 1] : 'GET';
    const data = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : null;
    const expected = method === 'POST' && path.includes('/statuses/') ? 'fixture-status' : 'fixture';
    if (process.env.GH_TOKEN !== expected) throw new Error('Wrong credential for request: ' + path);
    fs.appendFileSync('requests.jsonl', JSON.stringify({ path, method, data }) + '\\n');
    if (method !== 'GET') console.log(JSON.stringify({ merged: true }));
    else {
      const routes = JSON.parse(fs.readFileSync('routes.json', 'utf8'));
      if (!(path in routes)) throw new Error('Unexpected transport request: ' + path);
      console.log(JSON.stringify(routes[path]));
    }
  `,
    { mode: 0o755 },
  );
  return {
    root,
    routes,
    run(autoMerge = false) {
      writeFileSync(join(root, "routes.json"), JSON.stringify(routes));
      return spawnSync(process.execPath, [new URL("./publish.mts", import.meta.url).pathname], {
        cwd: root,
        encoding: "utf8",
        timeout: 60000,
        env: {
          ...process.env,
          PATH: `${join(root, "bin")}:${process.env.PATH}`,
          GH_TOKEN: "fixture",
          STATUS_TOKEN: "fixture-status",
          GITHUB_REPOSITORY: "thebytefarm/fixture",
          GITHUB_RUN_ID: "99",
          PR_NUMBER: "7",
          AUTO_MERGE: String(autoMerge),
          REVIEW_HEAD: head,
          REVIEW_BASE: base,
          GITHUB_STEP_SUMMARY: "",
        },
      });
    },
    requests() {
      return readFileSync(join(root, "requests.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { path: string; method: string; data: unknown });
    },
  };
};

it("publishes the review but never merges unless explicitly enabled", (test) => {
  const transport = fixture();
  test.after(() => rmSync(transport.root, { recursive: true, force: true }));
  const result = transport.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    transport
      .requests()
      .filter((request) => request.method !== "GET")
      .map((request) => request.path),
    [`${endpoint}/reviews`, `repos/thebytefarm/fixture/statuses/${head}`],
  );
});

it("publishes findings as inline review threads, not a timeline roll-up", (test) => {
  const transport = fixture();
  test.after(() => rmSync(transport.root, { recursive: true, force: true }));
  transport.routes[`${endpoint}/files?per_page=100`] = [
    [
      {
        filename: "src/fix.ts",
        status: "modified",
        patch: "@@ -5,2 +5,3 @@\n old\n+fixed\n context",
      },
    ],
  ];
  const review = {
    body: "Request changes. Risk: medium.",
    comments: [
      {
        path: "src/fix.ts",
        line: 6,
        side: "RIGHT",
        body: "Fix the concrete defect (bugs-1, risk-1).",
      },
    ],
  };
  writeFileSync(join(transport.root, "context/review.json"), JSON.stringify(review));
  const result = transport.run();
  assert.equal(result.status, 0, result.stderr);
  const request = transport.requests().find((request) => request.path === `${endpoint}/reviews`)!;
  assert.deepEqual(request.data, { commit_id: head, event: "APPROVE", ...review });
});

it("refuses invalid inline anchors before any review, status, or merge write", (test) => {
  for (const anchor of [
    { path: "src/fix.ts", line: 99 },
    { path: "missing.ts", line: 6 },
  ]) {
    const transport = fixture();
    test.after(() => rmSync(transport.root, { recursive: true, force: true }));
    writeFileSync(
      join(transport.root, "context/review.json"),
      JSON.stringify({
        body: "Request changes",
        comments: [{ ...anchor, side: "RIGHT", body: "Concrete finding" }],
      }),
    );
    const result = transport.run(true);
    assert.notEqual(result.status, 0);
    assert(!transport.requests().some((request) => request.method !== "GET"));
  }
});

it("refuses stale or private PRs before making any GitHub writes", (test) => {
  for (const privateRepo of [false, true]) {
    const transport = fixture();
    test.after(() => rmSync(transport.root, { recursive: true, force: true }));
    if (privateRepo) transport.routes["repos/thebytefarm/fixture"] = { visibility: "private" };
    else transport.routes[endpoint] = { ...pull(), head: { sha: "c".repeat(40) } };
    assert.notEqual(transport.run(true).status, 0);
    assert(!transport.requests().some((request) => request.method !== "GET"));
  }
});

it("never attempts a merge for a release even when the model says low risk", (test) => {
  const transport = fixture();
  test.after(() => rmSync(transport.root, { recursive: true, force: true }));
  transport.routes[endpoint] = { ...pull(), title: "chore: version packages (rc)" };
  const result = transport.run(true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Release PRs require a human/);
  assert(!transport.requests().some((request) => request.method === "PUT"));
});

it(
  "merges only after current independent CI passes, using the reviewed head SHA",
  { timeout: 60000 },
  (test) => {
    const transport = fixture();
    test.after(() => rmSync(transport.root, { recursive: true, force: true }));
    const result = transport.run(true);
    assert.equal(result.status, 0, result.stderr);
    const writes = transport.requests().filter((request) => request.method === "PUT");
    assert.deepEqual(writes, [
      { path: `${endpoint}/merge`, method: "PUT", data: { sha: head, merge_method: "squash" } },
    ]);
  },
);
