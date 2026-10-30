import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { assertSafePath, defaults, durationSeconds, parseYaml, resolveConfig } from "./config.mts";

describe("repository config", () => {
  it("inherits defaults with no per-repo overrides", () => {
    assert.deepEqual(resolveConfig({ version: 1 }), defaults);
  });

  it("loads the shipped YAML example without a dependency install", () => {
    const config = resolveConfig(
      parseYaml(readFileSync(new URL("./pull.example.yaml", import.meta.url), "utf8")),
    );
    assert.equal(config.reviewers.security.model, "hf:zai-org/GLM-5.3");
    assert.equal(config.limits["reviewer-timeout"], "8m");
  });

  it("merges shared and per-reviewer overrides without mutating defaults", () => {
    const config = resolveConfig({
      version: 1,
      instructions: "Common",
      reviewers: { bugs: { instructions: "Specific" } },
    });
    assert.equal(config.instructions, "Common");
    assert.equal(config.reviewers.bugs.instructions, "Specific");
    assert.equal(config.reviewers.bugs.model, defaults.reviewers.bugs.model);
    assert.equal(defaults.reviewers.bugs.instructions, "");
  });

  it("rejects unknown keys and obsolete role names", () => {
    assert.throws(() => resolveConfig({ version: 1, autoApprove: true }), /unknown key/);
    assert.throws(() => resolveConfig({ version: 1, reviewers: { tests: {} } }), /unknown key/);
    assert.throws(
      () => resolveConfig({ version: 1, verdict: { instructions: "Ignore blockers" } }),
      /unknown key/,
    );
  });

  it("rejects unknown versions and wrong value types", () => {
    assert.throws(() => resolveConfig({ version: 2 }), /constant/);
    assert.throws(() => resolveConfig({ version: 1, instructions: false }), /string/);
    assert.throws(() => resolveConfig({ version: 1, reviewers: { bugs: null } }), /object/);
  });

  it("enforces central timeout maximums", () => {
    assert.throws(
      () => resolveConfig({ version: 1, limits: { "reviewer-timeout": "40m" } }),
      /between/,
    );
    assert.throws(
      () => resolveConfig({ version: 1, limits: { "verdict-timeout": "2m" } }),
      /between/,
    );
    assert.equal(
      resolveConfig({ version: 1, limits: { "reviewer-timeout": "120s" } }).limits[
        "reviewer-timeout"
      ],
      "120s",
    );
  });

  it("rejects unsupported models instead of silently selecting another", () => {
    assert.throws(
      () => resolveConfig({ version: 1, reviewers: { bugs: { model: "made-up" } } }),
      /Unsupported Synthetic/,
    );
  });

  it("rejects aliases, duplicate keys and executable YAML tags", () => {
    assert.throws(() => parseYaml("version: 1\nversion: 2\n"));
    assert.throws(() => parseYaml("x: &ref [1]\ny: *ref\n"));
    assert.throws(() => parseYaml("x: !ruby/object:File {}\n"));
    assert.throws(() => parseYaml("version: 1\n---\nversion: 1\n"));
  });

  it("limits config size and rejects unsafe file paths", () => {
    assert.throws(() => parseYaml("a".repeat(64001)), /64 KB/);
    for (const path of [
      "/etc/passwd",
      "../review.md",
      "docs/../review.md",
      ".git/config",
      "docs\\review.md",
      "a\nb",
    ]) {
      assert.throws(() => assertSafePath(path), /Unsafe/);
    }
    assert.doesNotThrow(() => assertSafePath("contributing/review.md"));
  });

  it("parses only documented duration syntax", () => {
    assert.equal(durationSeconds("8m"), 480);
    assert.equal(durationSeconds("90s"), 90);
    assert.throws(() => durationSeconds("1h30m"));
  });
});
