import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaults, reviewers } from "./config.mts";
import { decide, parseReview, parseVerdict, renderIncomplete, renderReview } from "./gate.mts";
import type { Finding, Metadata, ReviewResult, Reviewer } from "./types.mts";

const head = "a".repeat(40);
const metadata: Metadata = {
  repository: "thebytefarm/ciderpress",
  number: 1,
  url: "https://example.invalid/pr/1",
  head_sha: head,
  base_sha: "b".repeat(40),
  head_repository: "thebytefarm/ciderpress",
  files: ["src/example.ts"],
  policy_paths: ["AGENTS.md"],
  config: defaults,
};
const finding = (role: Reviewer = "bugs"): Finding => ({
  id: `${role}-1`,
  path: "src/example.ts",
  line: 2,
  title: "Concrete issue",
  evidence: "A concrete failure scenario",
  severity: "high",
  blocking: role !== "design",
  standard: role === "standards" ? "AGENTS.md#Rules" : "",
});
const report = (role: Reviewer, findings: Finding[] = []): ReviewResult => ({
  reviewer: role,
  head_sha: head,
  status: "complete",
  findings,
  limitations: [],
});
const reports = (): ReviewResult[] => reviewers.map((role) => report(role));

describe("review validation", () => {
  it("accepts a complete result with a concrete finding", () => {
    assert.equal(
      parseReview({ value: report("bugs", [finding()]), role: "bugs", metadata }).findings.length,
      1,
    );
  });

  it("rejects an invented commit or reviewer identity", () => {
    assert.throws(
      () =>
        parseReview({
          value: { ...report("bugs"), head_sha: "c".repeat(40) },
          role: "bugs",
          metadata,
        }),
      /Wrong reviewer or commit/,
    );
    assert.throws(
      () => parseReview({ value: report("security"), role: "bugs", metadata }),
      /Wrong reviewer or commit/,
    );
  });

  it("rejects duplicate or mismatched finding IDs", () => {
    assert.throws(
      () => parseReview({ value: report("bugs", [finding(), finding()]), role: "bugs", metadata }),
      /duplicate/,
    );
    assert.throws(
      () => parseReview({ value: report("bugs", [finding("security")]), role: "bugs", metadata }),
      /Out-of-scope/,
    );
  });

  it("rejects findings outside changed files and invalid lines", () => {
    assert.throws(
      () =>
        parseReview({
          value: report("bugs", [{ ...finding(), path: "other.ts" }]),
          role: "bugs",
          metadata,
        }),
      /Out-of-scope/,
    );
    assert.throws(
      () =>
        parseReview({ value: report("bugs", [{ ...finding(), line: 0 }]), role: "bugs", metadata }),
      /integer/,
    );
  });

  it("requires standards citations and advisory-only design findings", () => {
    assert.throws(
      () =>
        parseReview({
          value: report("standards", [{ ...finding("standards"), standard: "" }]),
          role: "standards",
          metadata,
        }),
      /cite/,
    );
    assert.throws(
      () =>
        parseReview({
          value: report("design", [{ ...finding("design"), blocking: true }]),
          role: "design",
          metadata,
        }),
      /advisory/,
    );
  });

  it("rejects standards citations to documents not loaded from the base branch", () => {
    assert.throws(
      () =>
        parseReview({
          value: report("standards", [{ ...finding("standards"), standard: "invented.md#Rule" }]),
          role: "standards",
          metadata,
        }),
      /loaded policy/,
    );
  });

  it("rejects complete results containing coverage limitations", () => {
    assert.throws(
      () =>
        parseReview({
          value: { ...report("bugs"), limitations: ["Unread code"] },
          role: "bugs",
          metadata,
        }),
      /limitations/,
    );
  });

  it("rejects additional fields and malformed results", () => {
    assert.throws(
      () => parseReview({ value: { ...report("bugs"), approved: true }, role: "bugs", metadata }),
      /unknown key/,
    );
    assert.throws(() => parseReview({ value: {}, role: "bugs", metadata }), /missing/);
    assert.throws(
      () =>
        parseReview({
          value: report("bugs", [{ ...finding(), blocking: "false" } as unknown as Finding]),
          role: "bugs",
          metadata,
        }),
      /boolean/,
    );
  });
});

describe("deterministic verdict", () => {
  it("approves only when every required reviewer completes without blockers", () => {
    assert.equal(decide(reports()), "APPROVE");
    assert.equal(
      decide(
        reports().map((item) =>
          item.reviewer === "design" ? report("design", [finding("design")]) : item,
        ),
      ),
      "APPROVE",
    );
  });

  it("requests changes for one blocker regardless of other reviewer votes", () => {
    assert.equal(
      decide(
        reports().map((item) => (item.reviewer === "bugs" ? report("bugs", [finding()]) : item)),
      ),
      "REQUEST_CHANGES",
    );
  });

  it("never approves partial, missing, duplicate or limited reviews", () => {
    assert.equal(decide(reports().slice(1)), "INCOMPLETE");
    assert.equal(decide([...reports().slice(1), report("security")]), "INCOMPLETE");
    assert.equal(decide(reports().map((item) => ({ ...item, status: "partial" }))), "INCOMPLETE");
    assert.equal(
      decide(reports().map((item) => ({ ...item, limitations: ["Could not inspect"] }))),
      "INCOMPLETE",
    );
  });
});

describe("synthesis", () => {
  const input = [report("bugs", [finding()]), report("security", [finding("security")])];
  const valid = {
    head_sha: head,
    summary: "Two reports agree.",
    groups: [{ title: "Same root cause", finding_ids: ["bugs-1", "security-1"] }],
  };

  it("accepts grouping the same issue without losing provenance", () => {
    assert.deepEqual(parseVerdict({ value: valid, reports: input, headSha: head }), valid);
  });

  it("rejects omitted, invented, or duplicated IDs", () => {
    for (const ids of [["bugs-1"], ["bugs-1", "made-up"], ["bugs-1", "security-1", "bugs-1"]]) {
      assert.throws(
        () =>
          parseVerdict({
            value: { ...valid, groups: [{ title: "Group", finding_ids: ids }] },
            reports: input,
            headSha: head,
          }),
        /every finding/,
      );
    }
  });

  it("rejects stale synthesis and model-supplied approval decisions", () => {
    assert.throws(
      () =>
        parseVerdict({
          value: { ...valid, head_sha: "b".repeat(40) },
          reports: input,
          headSha: head,
        }),
      /different commit/,
    );
    assert.throws(
      () => parseVerdict({ value: { ...valid, approved: true }, reports: input, headSha: head }),
      /unknown key/,
    );
  });

  it("retains original evidence even if the summary claims everything is fine", () => {
    const complete = reports().map((item) =>
      item.reviewer === "bugs" ? report("bugs", [finding()]) : item,
    );
    const verdict = {
      head_sha: head,
      summary: "Everything is fine",
      groups: [{ title: "Issue", finding_ids: ["bugs-1"] }],
    };
    const body = renderReview({ reports: complete, verdict });
    assert.match(body, /Changes requested/);
    assert.match(body, /concrete failure scenario/);
    assert.match(body, /bugs-1/);
    assert.match(body, /Tests were not executed/);
  });

  it("preserves available blockers when another stage is incomplete", () => {
    const body = renderIncomplete({
      reports: [report("bugs", [finding()])],
      errors: ["Security timed out"],
    });
    assert.match(body, /Review incomplete/);
    assert.match(body, /bugs-1/);
    assert.match(body, /Security timed out/);
    assert.doesNotMatch(body, /## Approved/);
  });
});
