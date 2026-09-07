/**
 * openrouter-session — injects a session_id into every OpenRouter request.
 *
 * Groups related requests in the OpenRouter console/dashboard under a
 * human-readable name you control.
 *
 * Naming options (in priority order):
 *   1. /name <name>          — set mid-session, picked up immediately
 *   2. .pi/session-name      — project-level default (create the file)
 *   3. "base_pi"             — fallback (the project directory name)
 *
 * A short UUID suffix is always appended for uniqueness.
 *
 * Examples of what OpenRouter sees:
 *   /name Refactor auth  →  session_id: "refactor-auth-01a07e06"
 *   (no name, no file)   →  session_id: "base_pi-01a07e06"
 *
 * Reload after changes:
 *   /reload
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PROJECT_NAME = "base_pi";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function shortId(sessionId: string): string {
  return sessionId.replace(/-/g, "").slice(0, 8);
}

/** Read an optional project-level default name from .pi/session-name */
function readSessionNameFile(piDir: string): string | null {
  try {
    const name = readFileSync(resolve(piDir, "session-name"), "utf8").trim();
    return name || null;
  } catch {
    return null;
  }
}

export default function (pi: ExtensionAPI) {
  let sessionId: string | null = null;
  let piDir: string | null = null;

  pi.on("session_start", async (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    piDir = ctx.sessionManager.getSessionDir?.() ?? null;
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "openrouter") return;
    if (!sessionId) return;

    const name = pi.getSessionName();
    const fallback = piDir
      ? readSessionNameFile(piDir)
      : null;
    const label = name ?? fallback ?? PROJECT_NAME;

    const payload = event.payload as Record<string, unknown>;
    return { ...payload, session_id: `${slugify(label)}-${shortId(sessionId)}` };
  });
}
