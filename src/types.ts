export interface RepoSummary {
  name: string;
  path: string;
  hasGit: boolean;
  sessionCount: number;
  messageCount: number;
  lastActivity: string | null;
}

export interface OrphanLog {
  approxPath: string;
  dirName: string;
  sessionCount: number;
  messageCount: number;
  lastActivity: string | null;
}

export interface Overview {
  repos: RepoSummary[];
  orphanLogs: OrphanLog[];
}

export interface SpecDoc {
  name: string;
  kind: "markdown" | "json" | "text";
  content: string;
}

export interface SessionMeta {
  id: string;
  file: string;
  mtime: string;
  sizeBytes: number;
  messageCount: number;
}

export interface RepoDetail extends RepoSummary {
  specs: SpecDoc[];
  stack: string[];
  sessions: SessionMeta[];
}

export interface TimelineEvent {
  ts: string | null;
  kind: "user" | "assistant" | "tool_use" | "tool_result" | "summary" | "other";
  text: string;
  tool?: string;
}

export interface Session {
  file: string;
  events: TimelineEvent[];
}

export interface AppConfig {
  logDir: string;
  repoRoot: string;
}

export interface ProjectMetric {
  name: string;
  dirName: string;
  sessions: number;
  userPrompts: number;
  assistant: number;
  tokensTotal: number;
  cacheRead: number;
  cost: number;
  first: string | null;
  last: string | null;
}

export interface DayMetric {
  date: string;
  events: number;
  cost: number;
}

export interface Metrics {
  span: { first: string | null; last: string | null; days: number; activeDays: number };
  totals: {
    sessions: number;
    lines: number;
    userPrompts: number;
    assistant: number;
    toolCalls: number;
    humanProjects: number;
    scaffoldProjects: number;
    tokIn: number;
    tokOut: number;
    tokCacheWrite: number;
    tokCacheRead: number;
    cost: number;
    promptChars: number;
    maxPrompt: number;
  };
  byDay: DayMetric[];
  models: { model: string; tokens: number }[];
  tools: { name: string; count: number }[];
  topByCost: ProjectMetric[];
  harvest: ProjectMetric[];
  self: ProjectMetric | null;
}
