import assert from "node:assert/strict";
import { it } from "node:test";
import { checkRisk, ciState, hasVersionBump, isRelease, mergeBlocker } from "./merge-policy.mts";

const eligible = () => ({
  pull: {
    state: "open",
    draft: false,
    title: "build(deps): update test dependency",
    head: { sha: "a".repeat(40), ref: "dependabot/npm_and_yarn/test-2" },
    base: { sha: "b".repeat(40) },
    labels: [] as { name: string }[],
  },
  files: ["package.json", "pnpm-lock.yaml"],
  reviewedHead: "a".repeat(40),
  reviewedBase: "b".repeat(40),
  decision: "APPROVE",
  risk: {
    level: "low",
    impact: "Tests only",
    likelihood: "Compatible usage",
    rationale: "Bounded and reversible",
    release: false,
  },
  ci: "passed" as const,
});

it("blocks model-identified releases even without release markers", () => {
  assert.match(
    mergeBlocker({ ...eligible(), risk: { ...eligible().risk, release: true } })!,
    /human/,
  );
});

it("excludes package version changes and uninspectable manifests, not dependency versions", () => {
  for (const filename of ["package.json", "crates/lib/Cargo.toml", "pyproject.toml"]) {
    const patch = filename.endsWith("package.json")
      ? '-"version": "1"\n+"version": "2"'
      : '-version = "1"\n+version = "2"';
    assert(hasVersionBump([{ filename, patch }]));
    assert(hasVersionBump([{ filename }]));
  }
  assert(
    hasVersionBump([{ filename: "package.json", patch: '-  "version": "1",\n+  "version": "2",' }]),
  );
  assert(
    hasVersionBump([{ filename: "package.json", patch: '+{"name":"fixture","version":"2"}' }]),
  );
  assert(hasVersionBump([{ filename: "Cargo.toml", patch: '+package.version = "2"' }]));
  assert(
    hasVersionBump([
      { filename: "old.json", previous_filename: "package.json", status: "renamed", patch: "" },
    ]),
  );
  assert(!hasVersionBump([{ filename: "package.json", patch: '-  "zod": "1",\n+  "zod": "2",' }]));
  assert(!hasVersionBump([{ filename: "Cargo.lock", patch: '-version = "1"\n+version = "2"' }]));
});

const check = (status = "completed", conclusion: string | null = "success", suite = 2) => ({
  name: "test",
  status,
  conclusion,
  check_suite: { id: suite },
  app: { id: 1 },
});

it("never counts the review itself or entirely skipped checks as passing CI", () => {
  assert.equal(
    ciState([check("in_progress", null, 1)], [{ context: "bytefarm/review", state: "success" }], 1),
    "missing",
  );
  assert.equal(ciState([check("completed", "skipped")], [], 1), "missing");
  assert.equal(ciState([check()], [], 1), "passed");
});

it("blocks queued, cancelled, timed-out, and failing CI", () => {
  assert.equal(ciState([check("queued", null)], [], 1), "pending");
  for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", null])
    assert.equal(ciState([check("completed", conclusion)], [], 1), "failed");
  assert.equal(ciState([check()], [{ context: "external", state: "failure" }], 1), "failed");
});

it("uses the newest commit status for each context", () => {
  assert.equal(
    ciState(
      [],
      [
        { context: "test", state: "success" },
        { context: "test", state: "failure" },
      ],
      1,
    ),
    "passed",
  );
  assert.equal(
    ciState(
      [],
      [
        { context: "test", state: "pending" },
        { context: "test", state: "success" },
      ],
      1,
    ),
    "pending",
  );
});

it("allows only approved low-risk changes with current passing CI", () => {
  assert.equal(mergeBlocker(eligible()), undefined);
});

it("blocks every elevated risk level without changing review approval", () => {
  for (const level of ["medium", "high", "critical"])
    assert.match(mergeBlocker({ ...eligible(), risk: { ...eligible().risk, level } })!, /low-risk/);
});

it("rejects absent, numeric, unknown, and unexplained risk", () => {
  for (const risk of [
    undefined,
    1,
    { ...eligible().risk, level: ["low"] },
    { ...eligible().risk, level: "safe" },
    { ...eligible().risk, impact: " " },
  ]) {
    assert.throws(() => checkRisk(risk));
    assert.match(mergeBlocker({ ...eligible(), risk })!, /invalid/);
  }
});

it("blocks pending, failed, and missing CI", () => {
  for (const ci of ["pending", "failed", "missing"] as const)
    assert.match(mergeBlocker({ ...eligible(), ci })!, /CI/);
});

it("blocks incomplete reviews and blocking findings", () => {
  for (const decision of ["INCOMPLETE", "REQUEST_CHANGES"])
    assert.match(mergeBlocker({ ...eligible(), decision })!, /Reviews/);
});

it("blocks stale head or base even when CI passes", () => {
  assert.match(mergeBlocker({ ...eligible(), reviewedHead: "c".repeat(40) })!, /changed/);
  assert.match(mergeBlocker({ ...eligible(), reviewedBase: "c".repeat(40) })!, /changed/);
});

it("blocks drafts and closed PRs", () => {
  const input = eligible();
  assert.match(mergeBlocker({ ...input, pull: { ...input.pull, draft: true } })!, /ready/);
  assert.match(mergeBlocker({ ...input, pull: { ...input.pull, state: "closed" } })!, /ready/);
});

it("excludes release titles, branches, labels, and changelogs even at low risk", () => {
  const input = eligible();
  const pulls = [
    ...["chore: release", "chore(repo): version packages (rc)", "Publish v2"].map((title) => ({
      ...input.pull,
      title,
    })),
    ...["changeset-release/main", "release-please--branches--main", "release/v2"].map((ref) => ({
      ...input.pull,
      head: { ...input.pull.head, ref },
    })),
    { ...input.pull, labels: [{ name: "autorelease: pending" }] },
  ];
  for (const pull of pulls) {
    assert(isRelease(pull, input.files));
    assert.match(mergeBlocker({ ...input, pull })!, /human/);
  }
  assert.match(mergeBlocker({ ...input, files: ["packages/sdk/CHANGELOG.md"] })!, /human/);
});
