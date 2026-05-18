import type { AppConfig } from "./types.ts";

const STORAGE_KEY = "claude-code-log.config";

/** Seeded defaults: resolved Claude Code log location + the repo base root. */
export const DEFAULT_CONFIG: AppConfig = {
  logDir: "~/.claude/projects",
  repoRoot: "~/Projects",
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
