import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type Args = { path?: string; offset?: number; query?: string; root?: string };
type Call = { id: string; function: { name: string; arguments: string } };
type Message = {
  role: string;
  content: string | null;
  tool_calls?: Call[];
  tool_call_id?: string;
  reasoning_content?: string;
};
const parameters = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

/** Exposes only bounded local reads; neither commands, environment, network, nor writes are tools. */
export function localTools(workspace: string, synthesis: boolean) {
  const root = realpathSync(workspace);
  const permitted = synthesis ? ["context/reports.json"] : ["source", "head", "context/pr.diff"];
  const checked = (path: string): string => {
    assert(typeof path === "string" && !path.includes("\\"), "Use a workspace-relative path");
    const absolute = realpathSync(resolve(root, path));
    const name = relative(root, absolute).split(sep).join("/");
    assert(!name.split("/").includes(".git"), "Git metadata is not review data");
    assert(
      permitted.some(
        (entry) =>
          name === entry || (!entry.startsWith("context/") && name.startsWith(`${entry}/`)),
      ),
      "Path outside review data",
    );
    return absolute;
  };
  const files = (tree: string): string[] => {
    assert(!synthesis && ["source", "head"].includes(tree), "Invalid source tree");
    return execFileSync("git", ["ls-files", "--cached", "-z"], {
      cwd: checked(tree),
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 2000000,
    })
      .split("\0")
      .filter(Boolean)
      .map((name) => `${tree}/${name}`);
  };
  const read = (path: string): string => {
    const absolute = checked(path);
    assert(
      statSync(absolute).isFile() && statSync(absolute).size <= 1000000,
      "File missing or too large",
    );
    const content = readFileSync(absolute, "utf8");
    assert(!content.includes("\0"), "Binary file");
    return content;
  };
  return (name: string, args: Args): unknown => {
    if (name === "read_file") {
      const offset = args.offset ?? 1;
      assert(Number.isSafeInteger(offset) && offset > 0, "Offset must be a positive line number");
      const lines = read(args.path!).split("\n");
      const page = lines.slice(offset - 1, offset + 199);
      return {
        total_lines: lines.length,
        next_offset: offset + page.length <= lines.length ? offset + page.length : null,
        text: page.map((line, index) => `${offset + index}: ${line}`).join("\n"),
      };
    }
    if (name === "list_files") {
      const found = files(args.root!).filter((path) => path.includes(args.query ?? ""));
      return { files: found.slice(0, 2000), truncated: found.length > 2000 };
    }
    if (name === "search_text") {
      assert(typeof args.query === "string" && args.query.length > 0, "Supply literal search text");
      const paths = files(args.root!).filter((path) => path.includes(args.path ?? ""));
      assert(paths.length <= 5000, "Search too broad; read individual files instead");
      const matches: { path: string; line: number; text: string }[] = [];
      for (const path of paths) {
        // Fail visibly on unreadable/symlink/binary files rather than silently claiming full coverage.
        const lines = read(path).split("\n");
        for (const [index, line] of lines.entries()) {
          if (line.includes(args.query))
            matches.push({ path, line: index + 1, text: line.slice(0, 1000) });
          if (matches.length >= 100) return { matches, truncated: true };
        }
      }
      return { matches, truncated: false };
    }
    throw new Error("Tool is not allowed");
  };
}

/** Runs a timeboxed tool loop against the fixed Synthetic endpoint, with no GitHub identity. */
export async function runAgent(options: {
  workspace: string;
  prompt: string;
  schema: unknown;
  model: string;
  seconds: number;
  context: number;
  output: number;
  key: string;
  synthesis: boolean;
}): Promise<unknown> {
  assert(options.key, "SYNTHETIC_API_KEY is required");
  const local = localTools(options.workspace, options.synthesis);
  const string = { type: "string" };
  const functions = [
    {
      name: "read_file",
      description: "Read up to 200 lines. Follow next_offset until null for full coverage.",
      parameters: parameters({ path: string, offset: { type: "integer", minimum: 1 } }, ["path"]),
    },
    ...(!options.synthesis
      ? [
          {
            name: "list_files",
            description: "List tracked source/head files, optionally filtered by a substring.",
            parameters: parameters({ root: { enum: ["source", "head"] }, query: string }, ["root"]),
          },
          {
            name: "search_text",
            description:
              "Search tracked source/head files for literal text. Optionally filter filenames by path substring. No regular expressions.",
            parameters: parameters(
              { root: { enum: ["source", "head"] }, query: string, path: string },
              ["root", "query"],
            ),
          },
        ]
      : []),
    {
      name: "set_output",
      description: "Return the final structured result. This ends the run.",
      parameters: options.schema,
    },
  ];
  const messages: Message[] = [{ role: "system", content: options.prompt }];
  const deadline = Date.now() + options.seconds * 1000;
  for (let turn = 0; turn < 60; turn++) {
    const remaining = deadline - Date.now();
    assert(remaining > 0, "Agent timed out without structured output");
    assert(
      JSON.stringify(messages).length < Math.min(options.context, 100000),
      "Context budget exhausted; no approval",
    );
    const response = await fetch("https://api.synthetic.new/openai/v1/chat/completions", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(remaining),
      headers: { Authorization: `Bearer ${options.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        messages,
        tools: functions.map((fn) => ({ type: "function", function: fn })),
        tool_choice: "required",
        parallel_tool_calls: false,
        max_tokens: Math.min(options.output, 8192),
        reasoning_effort: options.synthesis ? "low" : "high",
      }),
    });
    assert(response.ok, `Model request failed: HTTP ${response.status}`);
    const result = (await response.json()) as {
      choices: { message: Message; finish_reason: string }[];
    };
    const choice = result.choices?.[0];
    assert(
      choice && choice.finish_reason === "tool_calls" && choice.message.tool_calls?.length,
      "No complete tool call",
    );
    messages.push(choice.message);
    for (const call of choice.message.tool_calls) {
      const args = JSON.parse(call.function.arguments);
      if (call.function.name === "set_output") {
        assert(
          choice.message.tool_calls.length === 1,
          "Output cannot be mixed with other tool calls",
        );
        return args;
      }
      let content: string;
      try {
        content = JSON.stringify(local(call.function.name, args));
      } catch {
        content = JSON.stringify({
          error:
            "Read denied or failed. Narrow the request; report limitations if required context is unavailable.",
        });
      }
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
  throw new Error("Agent exhausted tool budget without structured output");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await runAgent({
    workspace: process.cwd(),
    prompt: readFileSync(process.env.PROMPT_PATH!, "utf8"),
    schema: JSON.parse(process.env.OUTPUT_SCHEMA!),
    model: process.env.MODEL!,
    seconds: Number(process.env.SECONDS),
    context: Number(process.env.CONTEXT),
    output: Number(process.env.MAX_OUTPUT),
    key: process.env.SYNTHETIC_API_KEY!,
    synthesis: process.env.ROLE === "verdict",
  });
  writeFileSync(process.env.RESULT_PATH!, JSON.stringify(result));
}
