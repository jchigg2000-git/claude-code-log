import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Server-Sent Events stream that pings the client whenever the log directory
 * changes on disk. Read-only: fs.watch only observes, it never writes. One
 * watcher per connection, torn down when the client disconnects.
 */
export async function streamWatch(
  req: IncomingMessage,
  res: ServerResponse,
  logDir: string,
): Promise<void> {
  let dirOk = false;
  try {
    dirOk = (await stat(logDir)).isDirectory();
  } catch {
    dirOk = false;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");
  // Tell any proxy not to buffer the stream so events arrive promptly.
  res.setHeader("X-Accel-Buffering", "no");
  // Hint the browser's reconnect interval if the connection drops.
  res.write("retry: 5000\n\n");

  if (!dirOk) {
    // Keep the stream open anyway; the browser will reconnect and re-stat once
    // the directory exists (e.g. after the user fixes the path in Settings).
    res.write(`event: error\ndata: ${JSON.stringify({ error: "log directory not found" })}\n\n`);
  }

  let watcher: FSWatcher | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  // Filesystem writes arrive in bursts (a single session append fires many
  // events); collapse them into one client notification.
  const notify = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      res.write(`event: change\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
    }, 400);
  };

  if (dirOk) {
    try {
      watcher = watch(logDir, { recursive: true }, notify);
    } catch {
      // Recursive watch isn't supported everywhere; degrade to the top level.
      try {
        watcher = watch(logDir, notify);
      } catch {
        watcher = null;
      }
    }
  }

  // Heartbeat comment keeps idle connections from being reaped by intermediaries.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);

  const cleanup = (): void => {
    clearInterval(heartbeat);
    if (debounce) clearTimeout(debounce);
    watcher?.close();
    watcher = null;
  };

  req.on("close", cleanup);
  res.on("close", cleanup);
}
