# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities through GitHub's private vulnerability
reporting: **[Security → Report a vulnerability](https://github.com/jchigg2000-git/claude-code-log/security/advisories/new)**.

Please don't open a public issue for anything exploitable. There is no support
commitment here — this is a personal project — but reports will be read, and
anything that lets a page or process reach transcript content it shouldn't will
be treated as the highest priority.

## What the threat model actually is

This tool serves the full text of every Claude Code transcript on the machine
over an unauthenticated local HTTP API. There is no login, and there is no
attempt at one: the entire security posture is *nothing off this machine can
reach the API, and nothing on it can reach outside the allowed roots.* That
makes the following in scope, and serious:

- **Anything that makes `/api/*` reachable from another origin or another host.**
  CORS is pinned off and the host is pinned to loopback, with a DNS-rebinding
  gate on top. A regression in any of those three is a real finding.
- **Anything that reads outside the allowed roots** — path traversal, a symlink
  that escapes containment, a derived path that skips validation.
- **Anything that writes.** The server is read-only by design; a write reachable
  from a request is a bug regardless of what it writes.
- **Script injection into the rendered transcript view.** Transcript text is
  attacker-controlled if you ever open a corpus you didn't produce.

Out of scope: that the API has no authentication (by design — it is bound to
loopback), and that a local user with your file permissions can read your files
without this tool's help.

## Supported versions

The `main` branch only.
