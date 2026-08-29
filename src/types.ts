/**
 * Client-side view of every /api/* payload. These are TYPE-ONLY re-exports of
 * the server's own interfaces — `export type` is erased by the bundler, so no
 * server code ever reaches the browser — which makes adding a field to an
 * endpoint single-sited: change the server interface and every view sees it.
 * (The previous hand-maintained mirror had already drifted twice.)
 */
export type { RepoSummary, SpecDoc, SessionMeta, RepoDetail, Overview } from "../server/fsScan.ts";
export type { TimelineEvent, TranscriptRead } from "../server/jsonl.ts";
export type { SearchMatch, SearchResults } from "../server/search.ts";
export type {
  ProjectMetric,
  DayMetric,
  AgentTypeStat,
  AgentMission,
  AgentSummary,
  MissionStat,
  Metrics,
} from "../server/metrics.ts";
export type { Journey, JourneyNode, JourneyEdge, JourneyVisit } from "../server/journey.ts";
export type { WordCategory, WordConfidence, WordEntry, WordsResults } from "../server/words.ts";
export type { PricingSource } from "../server/pricing.ts";

import type { Overview } from "../server/fsScan.ts";
import type { TranscriptRead } from "../server/jsonl.ts";

/** One orphan row of {@link Overview} — the server declares it inline, so it is derived here. */
export type OrphanLog = Overview["orphanLogs"][number];

/** `/api/session` payload: the capped transcript read plus the resolved file path. */
export interface Session extends TranscriptRead {
  file: string;
}

/** Client-only: the two operator settings every fetcher threads through. */
export interface AppConfig {
  logDir: string;
  repoRoot: string;
}
