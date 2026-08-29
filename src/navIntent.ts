/**
 * Scroll-intent seam for the repo page's inline transcripts.
 *
 * The open session lives in the hash (routes.ts), so *every* repo render — a
 * row click, a deep link, Back/Forward, the 5-minute refresh — flows through
 * the same renderRepoDetail. This module is how that render learns *why* it is
 * happening, which decides the one thing the hash alone cannot: whether to
 * scroll.
 *
 * A user click and a deep link should land the reader on the transcript; a
 * periodic refresh of a session already on screen must never yank them back to
 * the row top mid-read. A row click records a one-shot intent here immediately
 * before navigating; the render consumes it and {@link classifySessionRender}
 * turns intent + what-is-already-shown into a scroll decision.
 *
 * HISTORY policy deliberately does NOT live here — `sessionToggleNav` in
 * routes.ts owns it, so the push/replace/back decision is a pure function of
 * the URL transition rather than of mutable state kept in step with the
 * router. This module keeps exactly one module-level variable, one-shot.
 */

/** A recorded user session-toggle: the session navigated to ("" for a close). */
export interface SessionNavIntent {
  sessionId: string;
  at: number;
}

/**
 * How long a recorded intent stays trustworthy. Consumption happens on the
 * very next route render (milliseconds later), so this is a guard against a
 * pathological stray — an intent that somehow outlives its navigation must not
 * claim a scroll minutes later — not a tuning knob.
 */
export const INTENT_TTL_MS = 10_000;

/** Why a repo render with (or without) an open session is happening. */
export type RenderCause =
  /** The user just clicked this session's row. */
  | "user-nav"
  /** First time this session shows this stay: deep link, reload, Forward. */
  | "mount"
  /** Same session already on screen — the periodic refresh, or a race. */
  | "refresh"
  /** No session in the URL. */
  | "closed";

/**
 * The scroll decision. A consumed matching intent scrolls (the user asked to
 * go there); a session that was not already on screen scrolls (a deep link or
 * history traversal arrived wanting it); a re-render of a session already
 * showing never scrolls — that is the 5-minute refresh, and yanking the
 * reader back to the row top mid-transcript is exactly the bug this exists
 * to prevent.
 */
export function classifySessionRender(args: {
  /** Session in the URL being rendered ("" when none). */
  sessionId: string;
  /** The consumed one-shot intent, if any. */
  intent: SessionNavIntent | null;
  /** Session already rendered on screen before this render, or null. */
  shownSessionId: string | null;
  now: number;
}): { scroll: boolean; cause: RenderCause } {
  const { sessionId, intent, shownSessionId, now } = args;
  if (!sessionId) return { scroll: false, cause: "closed" };
  if (intent && intent.sessionId === sessionId && now - intent.at <= INTENT_TTL_MS) {
    return { scroll: true, cause: "user-nav" };
  }
  if (sessionId !== shownSessionId) return { scroll: true, cause: "mount" };
  return { scroll: false, cause: "refresh" };
}

// ── One-shot intent ────────────────────────────────────────────────────────

let pending: SessionNavIntent | null = null;

/**
 * Record a user session toggle immediately BEFORE navigating. This is what
 * lets the resulting render distinguish a deliberate click from the periodic
 * refresh, which is the whole scroll decision. History policy is NOT recorded
 * here — routes.ts owns it (see `sessionToggleNav`).
 */
export function recordSessionNav(targetSessionId: string, now = Date.now()): void {
  pending = { sessionId: targetSessionId, at: now };
}

/** One-shot take of the recorded intent; a second call returns null. */
export function consumeSessionNav(): SessionNavIntent | null {
  const p = pending;
  pending = null;
  return p;
}
