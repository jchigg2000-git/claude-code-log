import { readFile } from "node:fs/promises";

export interface TimelineEvent {
  ts: string | null;
  kind: "user" | "assistant" | "tool_use" | "tool_result" | "summary" | "other";
  text: string;
  tool?: string;
}

/** Pull readable text out of an Anthropic-style message content field. */
function extractText(content: unknown): { text: string; tool?: string; kind?: TimelineEvent["kind"] } {
  if (typeof content === "string") return { text: content };
  if (!Array.isArray(content)) return { text: "" };

  const parts: string[] = [];
  let tool: string | undefined;
  let kind: TimelineEvent["kind"] | undefined;

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    } else if (b.type === "tool_use") {
      kind = "tool_use";
      tool = typeof b.name === "string" ? b.name : "tool";
      parts.push(`→ ${tool}`);
    } else if (b.type === "tool_result") {
      kind = "tool_result";
      const c = b.content;
      if (typeof c === "string") parts.push(c);
      else if (Array.isArray(c)) {
        for (const cb of c) {
          const x = cb as Record<string, unknown>;
          if (x && x.type === "text" && typeof x.text === "string") parts.push(x.text);
        }
      }
    } else if (b.type === "thinking" && typeof b.thinking === "string") {
      parts.push(b.thinking);
    }
  }
  return { text: parts.join("\n").trim(), tool, kind };
}

/**
 * Parse one `.jsonl` transcript into a normalized timeline. Malformed lines
 * are skipped silently so a single bad line never breaks the view.
 */
export async function parseTranscript(file: string): Promise<TimelineEvent[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }

  const events: TimelineEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;

    const ts = typeof obj.timestamp === "string" ? obj.timestamp : null;
    const type = obj.type;

    if (type === "summary" && typeof obj.summary === "string") {
      events.push({ ts, kind: "summary", text: obj.summary });
      continue;
    }

    const message = obj.message as Record<string, unknown> | undefined;
    if (message && typeof message === "object") {
      const role = message.role === "user" ? "user" : "assistant";
      const { text, tool, kind } = extractText(message.content);
      if (!text) continue;
      events.push({ ts, kind: kind ?? role, text, tool });
      continue;
    }

    if (typeof obj.content === "string") {
      events.push({ ts, kind: "other", text: obj.content });
    }
  }
  return events;
}

/** Cheap message count: number of non-empty lines. */
export function countLines(raw: string): number {
  let n = 0;
  for (const line of raw.split("\n")) if (line.trim()) n++;
  return n;
}
