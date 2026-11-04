import { cases } from "./cases.mjs";
import { callApi } from "./provider.mjs";
import grade from "./grade.mjs";

export default {
  description: "Grounded PR reviews and concise inline publication through native Codex",
  prompts: ["{{case}}"],
  providers: [callApi],
  tests: cases.map((fixture) => ({
    description: fixture.name,
    vars: { case: fixture.name },
    assert: [{ type: "javascript", value: grade }],
  })),
};
