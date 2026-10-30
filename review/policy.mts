import { execFileSync } from "node:child_process";
import { assertSafePath } from "./config.mts";
import type { AgentConfig, PullConfig } from "./types.mts";

/** Reads a regular tracked blob, never following a symlink from repository policy. */
export function readBlob({
  directory,
  ref,
  path,
}: {
  directory: string;
  ref: string;
  path: string;
}): string {
  assertSafePath(path);
  const entry = execFileSync("git", ["-C", directory, "ls-tree", ref, "--", path], {
    encoding: "utf8",
    timeout: 10000,
  });
  if (!/^100(644|755) blob /.test(entry))
    throw new Error(`Missing or non-regular policy file: ${path}`);
  const text = execFileSync("git", ["-C", directory, "show", `${ref}:${path}`], {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 128000,
  });
  if (!text.trim()) throw new Error(`Empty policy file: ${path}`);
  return text;
}

/** Finds root and ancestor AGENTS.md policies for changed files, plus referenced local Markdown. */
export function loadPolicy({
  directory,
  ref,
  files,
}: {
  directory: string;
  ref: string;
  files: string[];
}): string {
  const tracked = execFileSync(
    "git",
    ["-C", directory, "ls-tree", "-r", "--name-only", "-z", ref],
    { encoding: "utf8", timeout: 10000, maxBuffer: 10000000 },
  ).split("\0");
  const applicable = tracked.filter((path) => {
    if (path === "AGENTS.md") return true;
    if (!path.endsWith("/AGENTS.md")) return false;
    const scope = path.slice(0, -"AGENTS.md".length);
    return files.some((file) => file.startsWith(scope));
  });
  const documents = new Map<string, string>();
  const visit = (path: string): void => {
    if (documents.has(path)) return;
    if (documents.size >= 60) throw new Error("Policy reference graph exceeds 60 files");
    const text = readBlob({ directory, ref, path });
    documents.set(path, text);
    const references = [...text.matchAll(/`([^`\n]+\.md)`|\]\(([^)\s]+\.md(?:#[^)\s]*)?)\)/g)];
    for (const match of references) {
      const target = (match[1] ?? match[2]).split("#")[0];
      if (/^https?:\/\//.test(target)) continue;
      const relative = `${path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : ""}${target.replace(/^\.\//, "")}`;
      const resolved = tracked.includes(target) ? target : relative;
      if (!tracked.includes(resolved))
        throw new Error(`Policy ${path} references missing local Markdown: ${target}`);
      visit(resolved);
    }
  };
  applicable.forEach(visit);
  const bundle = [...documents]
    .map(([path, text]) => `## BASE POLICY: ${path}\n\n${text}`)
    .join("\n\n");
  if (bundle.length > 240000) throw new Error("Policy bundle exceeds 240 KB");
  return (
    bundle ||
    "No applicable AGENTS.md exists on the base branch. Do not invent repository standards."
  );
}

/** Resolves inline and file additions using only trusted base-branch blobs. */
export function additionalInstructions({
  directory,
  ref,
  config,
  agent,
}: {
  directory: string;
  ref: string;
  config: PullConfig;
  agent: AgentConfig;
}): string {
  return [config, agent]
    .map((item) =>
      [
        item.instructions,
        item["instructions-path"]
          ? readBlob({ directory, ref, path: item["instructions-path"] })
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    )
    .filter(Boolean)
    .join("\n\n");
}
