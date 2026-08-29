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
  /** First substantive human prompt (≤90 chars) — what the session was about.
   *  "" when nothing qualifies (empty, oversized, or all-carrier transcripts). */
  preview: string;
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

/**
 * `/api/session` payload — mirrors server/jsonl.ts's TranscriptRead plus the
 * resolved file path. The server caps both bytes read (60 MB, aligned with
 * metrics) and events returned (5000); `truncated` is true whenever `events`
 * omits anything, and the views must say so — never silently drop events.
 */
export interface Session {
  file: string;
  events: TimelineEvent[];
  /** Events parsed from the bytes read. When `readBytes < sizeBytes` the
   *  file's true total is unknown and ≥ this. */
  totalEvents: number;
  truncated: boolean;
  /** Transcript size on disk. */
  sizeBytes: number;
  /** Bytes actually read; < sizeBytes when the byte cap bit. */
  readBytes: number;
}

export interface AppConfig {
  logDir: string;
  repoRoot: string;
}

export interface SearchMatch {
  file: string;
  sessionId: string;
  dirName: string;
  approxPath: string;
  mtime: string;
  kind: TimelineEvent["kind"];
  tool?: string;
  snippet: string;
  matchCount: number;
}

export interface SearchResults {
  query: string;
  sessionsSearched: number;
  matchedSessions: number;
  truncated: boolean;
  results: SearchMatch[];
}

export interface ProjectMetric {
  name: string;
  dirName: string;
  /** Real path of the crawled repo this project's log dir matched — the row's
   *  #/repo link target. null when nothing matched (orphan logs): no dead links. */
  repoPath: string | null;
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

/** One project as a node in the mental graph. */
export interface JourneyNode {
  id: string; // normalized absolute project path
  name: string; // friendly display name
  commands: number; // typed lines in the window
  sessions: number; // distinct Claude Code sessions
  first: string; // ISO of first activity in window
  last: string; // ISO of last activity in window
}

/** A directed project→project hop, aggregated over the window. */
export interface JourneyEdge {
  from: string;
  to: string;
  count: number;
  /** explicit = a typed line near the hop names the other project; inferred = a leap of faith. */
  confidence: "explicit" | "inferred";
  /** The representative typed line that plausibly led from `from` into `to`. */
  bridge: string;
  at: string; // ISO of that representative hop
}

/** One contiguous run of work in a single project — a "visit". */
export interface JourneyVisit {
  ts: string; // ISO start of the visit
  project: string; // node id
  name: string;
  opening: string; // first substantive typed line of the visit
  commands: number; // typed lines in this visit
}

export interface Journey {
  windowDays: number;
  first: string | null;
  last: string | null;
  totalCommands: number;
  totalSwitches: number;
  nodes: JourneyNode[];
  edges: JourneyEdge[];
  visits: JourneyVisit[];
  /** Where the server looked for `history.jsonl`, and whether it was readable.
   *  A missing file yields an empty journey rather than an error, so the view
   *  needs this to render an honest degraded state. */
  historyPath: string;
  historyFound: boolean;
}

export interface AgentTypeStat {
  type: string;
  count: number;
  seconds: number;
  maxSeconds: number;
}

export interface AgentMission {
  type: string;
  description: string;
  seconds: number;
  at: string;
}

export interface AgentSummary {
  total: number;
  withDuration: number;
  totalSeconds: number;
  byType: AgentTypeStat[];
  byDay: { date: string; count: number }[];
  longest: AgentMission[];
}

export interface MissionStat {
  seconds: number;
  opening: string;
  project: string;
  /** Absolute transcript path — the card's #/session link target. */
  file: string;
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
  self: ProjectMetric | null;
  agents: AgentSummary;
  engagement: { workingSeconds: number; gapCapSeconds: number };
  topMissions: MissionStat[];
  /** Which pricing table priced this scan's cost figures, and as-of when. Mirrors server/pricing.ts. */
  pricing: { source: string; effective: string };
}

/** Mirrors server/words.ts. */
export type WordCategory = "literal" | "missaid" | "pivot";

export interface WordEntry {
  file: string;
  sessionId: string;
  dirName: string;
  approxPath: string;
  ts: string | null;
  category: WordCategory;
  /** explicit = the correction names the miscommunication; inferred = pattern-guessed pairing. */
  confidence: "explicit" | "inferred";
  label: string;
  matched: string;
  original: string;
  correction: string;
  assistantTurns: number;
  toolCalls: number;
  firstAction: string;
}

export interface WordsResults {
  sessionsScanned: number;
  matchedSessions: number;
  totalMatches: number;
  truncated: boolean;
  entries: WordEntry[];
}
