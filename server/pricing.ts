import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Model pricing used to turn transcript token counts into an estimated spend.
 * Anthropic doesn't expose rates via an API, so {@link DEFAULT_PRICING} below
 * is a point-in-time snapshot of public list pricing — bump
 * {@link PRICING_EFFECTIVE} whenever that table is edited.
 *
 * Rates are OVERRIDABLE without touching source, two ways (checked in order):
 *   1. `CLAUDE_CODE_LOG_PRICING` env var — path to an override JSON file.
 *   2. `pricing.json` at the repo root.
 * Either file may set `effective` and/or `rates`; every field is optional,
 * and a family missing or invalid in `rates` just keeps the built-in rate for
 * that family. Missing or malformed files degrade silently to the built-in
 * table — this app never throws on a filesystem read, and pricing is no
 * exception.
 */

export type ModelFamily = "fable" | "opus" | "opus-legacy" | "sonnet" | "haiku";
/** USD per 1M tokens: [input, output, cacheWrite, cacheRead]. */
export type RateTuple = [number, number, number, number];
export type PricingTable = Record<ModelFamily, RateTuple>;

export const PRICING_FAMILIES = ["fable", "opus", "opus-legacy", "sonnet", "haiku"] as const;

/**
 * Built-in public list pricing, USD per 1M tokens: [input, output, cacheWrite, cacheRead].
 * Effective as of {@link PRICING_EFFECTIVE} — bump that constant whenever this table changes.
 *
 * Cache-write is the 5-minute-TTL rate (1.25× input); cache-read is 0.1× input.
 * `opus` covers Opus 4.5 and later (incl. Opus 5) at $5/$25; `opus-legacy`
 * keeps the pre-4.5 rate ($15/$75 — Opus 4.0/4.1, Claude 3 Opus) so old
 * transcripts still price at what those models actually cost. `fable` covers
 * Fable 5 and Mythos 5 ($10/$50). Sonnet 5 list rate is $3/$15 (the 2026
 * introductory $2/$10 is ignored — this app prices at list).
 */
export const DEFAULT_PRICING: PricingTable = {
  fable: [10, 50, 12.5, 1],
  opus: [5, 25, 6.25, 0.5],
  "opus-legacy": [15, 75, 18.75, 1.5],
  sonnet: [3, 15, 3.75, 0.3],
  haiku: [1, 5, 1.25, 0.1],
};

/** The date {@link DEFAULT_PRICING} reflects. MUST be bumped whenever that table is edited. */
export const PRICING_EFFECTIVE = "2026-08-11";

/** Model ids on the modern ($5/$25) opus rate: Opus 4.5–4.8 and Opus 5+. */
const MODERN_OPUS = /opus-(4-[5-9]|[5-9])/;

/** Classify a model id string into a pricing family, or null if unrecognized. */
export function family(model: unknown): ModelFamily | null {
  const m = typeof model === "string" ? model.toLowerCase() : "";
  if (m.includes("fable") || m.includes("mythos")) return "fable";
  if (m.includes("opus")) return MODERN_OPUS.test(m) ? "opus" : "opus-legacy";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return null;
}

export type PricingSource = "built-in" | "pricing.json" | "env";

export interface LoadedPricing {
  rates: PricingTable;
  source: PricingSource;
  effective: string;
}

// Resolved relative to this module, never the process cwd — the API can be
// invoked from any working directory.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_PRICING_FILE = path.join(REPO_ROOT, "pricing.json");

function isRateTuple(v: unknown): v is RateTuple {
  return (
    Array.isArray(v) &&
    v.length === 4 &&
    v.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)
  );
}

interface OverrideFile {
  effective?: string;
  rates: Partial<PricingTable>;
}

/** Read + validate one override file. Returns null on any read/parse failure or if it has nothing usable. */
async function readOverrideFile(file: string): Promise<OverrideFile | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null; // missing/unreadable — not an error, just "no override here"
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const rawRates = (parsed.rates ?? {}) as Record<string, unknown>;
    const rates: Partial<PricingTable> = {};
    for (const fam of PRICING_FAMILIES) {
      const v = rawRates[fam];
      if (isRateTuple(v)) rates[fam] = v; // invalid family arrays are dropped, not fatal
    }
    const effective =
      typeof parsed.effective === "string" && parsed.effective.trim() ? parsed.effective : undefined;
    if (!effective && Object.keys(rates).length === 0) return null; // nothing usable in the file
    return { effective, rates };
  } catch {
    return null; // malformed JSON
  }
}

let cached: LoadedPricing | null = null;

/**
 * Resolve the active pricing table. Checked in order: `CLAUDE_CODE_LOG_PRICING`
 * env path, then repo-root `pricing.json`, then the built-in defaults — the
 * first candidate with a valid, non-empty override wins outright (no partial
 * merging across candidates).
 *
 * Memoized for the process lifetime: `buildMetrics` calls this on every scan,
 * and rates change on the order of months, not minutes. The tradeoff is that
 * editing an override file needs a server restart to take effect.
 */
export async function loadPricing(): Promise<LoadedPricing> {
  if (cached) return cached;

  const envPath = process.env.CLAUDE_CODE_LOG_PRICING?.trim();
  const candidates: { file: string; source: PricingSource }[] = [];
  if (envPath) candidates.push({ file: path.resolve(envPath), source: "env" });
  candidates.push({ file: REPO_PRICING_FILE, source: "pricing.json" });

  for (const { file, source } of candidates) {
    const override = await readOverrideFile(file);
    if (!override) continue;
    cached = {
      rates: { ...DEFAULT_PRICING, ...override.rates },
      source,
      effective: override.effective ?? PRICING_EFFECTIVE,
    };
    return cached;
  }

  cached = { rates: DEFAULT_PRICING, source: "built-in", effective: PRICING_EFFECTIVE };
  return cached;
}
