import { open, readFile, stat } from "node:fs/promises";

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
 * Byte cap for a single transcript read — aligned with metrics' SIZE_CAP
 * (60 MB; fsScan stops line-counting at 50 MB). This was the last corpus
 * reader with no cap, and the largest real transcript is ~248 MB: reading it
 * whole shipped a multi-hundred-MB JSON payload to the session view.
 */
export const TRANSCRIPT_SIZE_CAP = 60 * 1024 * 1024;

/**
 * Event cap for one `/api/session` payload. Deliberately no offset /
 * continuation: sessions past this size are read via search, not end-to-end
 * scrolling, and the views state the truncation explicitly.
 */
export const TRANSCRIPT_EVENT_CAP = 5000;

/** A capped transcript read. Mirrored client-side as `Session` (src/types.ts). */
export interface TranscriptRead {
  events: TimelineEvent[];
  /** Events parsed from the bytes read. When `readBytes < sizeBytes` the
   *  file's true total is unknown and ≥ this. */
  totalEvents: number;
  /** True whenever `events` omits anything (byte cap or event cap bit). */
  truncated: boolean;
  /** Transcript size on disk. */
  sizeBytes: number;
  /** Bytes actually read; < sizeBytes when the byte cap bit. */
  readBytes: number;
}

/**
 * Read + parse one `.jsonl` transcript into a normalized timeline, holding at
 * most `sizeCap` bytes in memory and returning at most `eventCap` events.
 * Malformed lines are skipped silently so a single bad line never breaks the
 * view, and an unreadable file yields an empty read rather than a throw (the
 * view renders "no readable events", not a 500).
 */
export async function readTranscriptCapped(
  file: string,
  sizeCap = TRANSCRIPT_SIZE_CAP,
  eventCap = TRANSCRIPT_EVENT_CAP,
): Promise<TranscriptRead> {
  let sizeBytes: number;
  try {
    sizeBytes = (await stat(file)).size;
  } catch {
    return { events: [], totalEvents: 0, truncated: false, sizeBytes: 0, readBytes: 0 };
  }

  let raw: string;
  let readBytes: number;
  try {
    if (sizeBytes > sizeCap) {
      // Head-only read: never hold more than the cap in memory.
      const fh = await open(file, "r");
      try {
        const buf = Buffer.alloc(sizeCap);
        ({ bytesRead: readBytes } = await fh.read(buf, 0, sizeCap, 0));
        const head = buf.subarray(0, readBytes).toString("utf8");
        // Drop the trailing partial line: it's a cut JSON object (possibly
        // ending mid-multibyte-char), noise rather than a real malformed line.
        const nl = head.lastIndexOf("\n");
        raw = nl >= 0 ? head.slice(0, nl) : "";
      } finally {
        await fh.close();
      }
    } else {
      raw = await readFile(file, "utf8");
      readBytes = sizeBytes;
    }
  } catch {
    return { events: [], totalEvents: 0, truncated: false, sizeBytes, readBytes: 0 };
  }

  const all = parseTranscriptText(raw);
  const events = all.length > eventCap ? all.slice(0, eventCap) : all;
  return {
    events,
    totalEvents: all.length,
    truncated: readBytes < sizeBytes || events.length < all.length,
    sizeBytes,
    readBytes,
  };
}

/**
 * The parsing half of {@link readTranscriptCapped}, split out so callers that
 * have already read the file (search reads it to pre-filter) don't read it
 * twice — and so the parser can be exercised without touching a filesystem.
 */
export function parseTranscriptText(raw: string): TimelineEvent[] {
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

/** Preview length for a session's opening prompt — mirrors MissionStat.opening in metrics.ts. */
const PREVIEW_CHARS = 90;

/**
 * Human prompt text from a user message's `content`, or "" when the line
 * carries no text. A user line whose content array holds a tool_result is the
 * harness returning tool output, not the human typing — the same demotion
 * rule metrics.ts applies — so it yields "" outright.
 */
function promptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "tool_result") return "";
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join(" ");
}

/**
 * The one counting implementation — the only one — plus
 * the session's opening human prompt, in one pass. scanLogProjects already
 * reads a transcript's full bytes just to count lines, so the preview rides
 * along at zero extra I/O. Every non-empty line counts; only a well-formed
 * user line with substantive text can contribute the preview — malformed JSON,
 * tool_result carriers, and blank/whitespace prompts are passed over, and
 * the first hit wins.
 */
export function countLinesAndPreview(raw: string): { count: number; preview: string } {
  let count = 0;
  let preview = "";
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    count++;
    if (preview) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue; // malformed line: still counted, never previewed
    }
    if (!obj || typeof obj !== "object") continue;
    const message = (obj as Record<string, unknown>).message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object" || message.role !== "user") continue;
    const text = promptText(message.content).replace(/\s+/g, " ").trim();
    if (text) preview = text.slice(0, PREVIEW_CHARS);
  }
  return { count, preview };
}
