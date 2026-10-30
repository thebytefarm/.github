export type Reviewer = "bugs" | "security" | "standards" | "design";

export interface Finding {
  id: string;
  path: string;
  line: number;
  title: string;
  evidence: string;
  severity: "critical" | "high" | "medium" | "low";
  blocking: boolean;
  standard: string;
}

export interface ReviewResult {
  head_sha: string;
  reviewer: Reviewer;
  status: "complete" | "partial";
  findings: Finding[];
  limitations: string[];
}

export interface VerdictResult {
  head_sha: string;
  summary: string;
  groups: { title: string; finding_ids: string[] }[];
}

export interface AgentConfig {
  model: string;
  instructions: string;
  "instructions-path": string;
}

export interface PullConfig {
  version: 1;
  instructions: string;
  "instructions-path": string;
  reviewers: Record<Reviewer, AgentConfig>;
  verdict: { model: string };
  limits: { "reviewer-timeout": string; "verdict-timeout": string };
}

export interface Metadata {
  repository: string;
  number: number;
  url: string;
  base_sha: string;
  head_sha: string;
  head_repository: string;
  files: string[];
  policy_paths: string[];
  config: PullConfig;
}
