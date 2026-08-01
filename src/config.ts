import type { AppConfig } from "./types.ts";

const STORAGE_KEY = "claude-code-log.config";

/**
 * Seeded defaults: resolved Claude Code log location + the repo base root.
 *
 * `VITE_LOG_DIR` / `VITE_REPO_ROOT` override the seed at build/dev time, which
 * is how `npm run demo` points a fresh browser at the generated sample corpus
 * instead of your real transcripts. They are only a SEED — anything saved in
 * Settings still wins, since that's the user's explicit choice.
 */
export const DEFAULT_CONFIG: AppConfig = {
  logDir: import.meta.env.VITE_LOG_DIR || "~/.claude/projects",
  repoRoot: import.meta.env.VITE_REPO_ROOT || "~/Projects",
};

export function loadConfig(): AppConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return {
      logDir: parsed.logDir?.trim() || DEFAULT_CONFIG.logDir,
      repoRoot: parsed.repoRoot?.trim() || DEFAULT_CONFIG.repoRoot,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: AppConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}
