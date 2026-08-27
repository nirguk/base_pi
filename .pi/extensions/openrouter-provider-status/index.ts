/**
 * openrouter-provider-status — Pi extension (TypeScript)
 *
 * Shows the actual upstream provider that served an OpenRouter request
 * in the terminal footer status line (e.g. "Provider:DigitalOcean ;").
 *
 * Mechanism:
 *  1. before_provider_headers  → inject X-OpenRouter-Metadata: enabled
 *     so the response body includes the provider info (opt-in header).
 *  2. after_provider_response   → read X-Generation-Id from headers and queue
 *     a lookup for turn_end, then display the provider via setStatus().
 *
 * The generation-record lookup runs after the response stream is consumed,
 * with retries (overall abort at 8s so it can't stall the UI). X-Provider-Name is listed
 * in access-control-expose-headers but never actually sent, so the
 * body/generation-record is the only source.
 *
 * Caching: generation records are cached in-memory for 5 minutes
 * (TTL). Repeated requests for the same generation ID skip the
 * network round-trip.
 *
 * "/or-provider" command: manually query a generation ID and display
 * the upstream provider. Usage: /or-provider [generation-id]
 *   - With a generation ID: fetches and displays the provider.
 *   - Without a generation ID: shows the last cached provider.
 *
 * "/or-provider loud on|off" toggles verbose logging so you can see
 * every decision point the extension makes in the TUI footer and
 * the console. Useful for debugging why provider info isn't showing.
 *
 * "preferred_min_throughput" is a soft performance hint, not a hard
 * guarantee — OpenRouter may still route to a different provider.
 * Hard pinning uses "only" / "order" / "ignore" with allow_fallbacks: false.
 * e.g. { only: ["digitalocean"], allow_fallbacks: false }.
 * See pi-openrouter-pin (npm:@xamfoo/pi-openrouter-pin) for a full pin
 * workflow that validates providers via /models/<id>/endpoints.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ─── Constants ──────────────────────────────────────────────────────────

const OR_METADATA_HEADER = "X-OpenRouter-Metadata";
const OR_METADATA_VALUE = "enabled";
const GENERATION_ID_HEADER = "X-Generation-Id";
const GENERATION_ENDPOINT = "https://openrouter.ai/api/v1/generation";
const GENERATION_FETCH_TIMEOUT_MS = 30000;
// Generation records can lag the completion response, especially for streamed
// requests. In practice they may take several seconds to become queryable, so
// poll for about 21 seconds after the stream has finished.
const GENERATION_RETRY_DELAYS_MS = [1000, 2000, 3000, 4000, 5000, 6000] as const;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Loud logging mode ──────────────────────────────────────────────────

// When true, emits verbose console + TUI notifications at every decision
// point. Toggled via:
//   - env var OPENROUTER_PROVIDER_STATUS_LOUD=1 (always-on)
//   - /or-provider loud on|off (runtime toggle)
const LOUD_VAR = "OPENROUTER_PROVIDER_STATUS_LOUD";
export let loud: boolean = process.env[LOUD_VAR] === "1";

/** Emit a verbose log line when loud mode is active.
 *  Appears in console output with a prefix. TUI-side notifications are
 *  added explicitly at each call site (since log() has no ctx access).
 */
export function log(...args: unknown[]): void {
  if (loud) {
    console.log("[openrouter-provider-status]", ...args);
  }
}

/** Like log(), but also sends a TUI notification via ctx.ui.notify()
 *  when loud mode is active. Use this in event handlers where ctx is
 *  available so the user sees decisions in the footer/status line.
 */
export function logWithCtx(ctx: any, ...args: unknown[]): void {
  if (loud) {
    console.log("[openrouter-provider-status]", ...args);
    ctx.ui.notify(
      `[openrouter-provider-status] ${args.map(String).join(" ")}`,
      "info",
    );
  }
}

// ─── Types ──────────────────────────────────────────────────────────────

interface GenerationRecord {
  data?: {
    provider_name?: string | null;
  };
  /** Legacy response shape retained for compatibility with older API responses. */
  provider?: {
    provider_name?: string | null;
  };
}

interface CacheEntry {
  providerName: string;
  fetchedAt: number;
}

// ─── In-memory cache ────────────────────────────────────────────────────

const generationCache = new Map<string, CacheEntry>();

interface PendingGenerationLookup {
  generationId: string;
  sequence: number;
}

// `after_provider_response` runs before a streaming response is consumed. Keep
// generation IDs until `turn_end`, when OpenRouter has had a chance to persist
// the generation record.
const pendingGenerationLookups: PendingGenerationLookup[] = [];
let nextGenerationSequence = 0;
let latestGenerationSequence = 0;

export function getCachedProvider(generationId: string): string | null {
  const entry = generationCache.get(generationId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    generationCache.delete(generationId);
    return null;
  }
  return entry.providerName;
}

/** Format the provider status so it is self-describing in the footer.
 *
 * Pi joins extension statuses with spaces, so the trailing semicolon acts as
 * a clear separator before the next extension's status (for example, the
 * model metrics extension).
 */
export function formatProviderStatus(providerName: string): string {
  return `Provider:${providerName} ;`;
}

export function setCachedProvider(generationId: string, providerName: string): void {
  generationCache.set(generationId, { providerName, fetchedAt: Date.now() });
}

export function clearCache(): void {
  generationCache.clear();
}

export function clearPendingGenerationLookups(): void {
  pendingGenerationLookups.length = 0;
  nextGenerationSequence = 0;
  latestGenerationSequence = 0;
}

function advanceGenerationSequence(): number {
  latestGenerationSequence = ++nextGenerationSequence;
  return latestGenerationSequence;
}

function queueGenerationLookup(
  generationId: string,
  sequence = advanceGenerationSequence(),
): number {
  latestGenerationSequence = Math.max(latestGenerationSequence, sequence);

  // A provider retry or duplicate hook should not cause duplicate lookups.
  if (!pendingGenerationLookups.some((entry) => entry.generationId === generationId)) {
    pendingGenerationLookups.push({ generationId, sequence });
  }
  return sequence;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Look up a header without relying on the casing used by the provider.
 * Pi builds response header records from Headers.entries(), whose keys are
 * normalized to lowercase by the Fetch Headers implementation.
 */
export function getHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const key = Object.keys(headers).find(
    (key) => key.toLowerCase() === name.toLowerCase(),
  );
  return key ? headers[key] : undefined;
}

/** Extract the provider name from the current or legacy API response shape. */
export function getProviderName(data: GenerationRecord): string | undefined {
  const providerName = data.data?.provider_name ?? data.provider?.provider_name;
  return typeof providerName === "string" && providerName.length > 0
    ? providerName
    : undefined;
}

/** Build the documented generation lookup URL. */
export function getGenerationUrl(generationId: string): URL {
  const url = new URL(GENERATION_ENDPOINT);
  url.searchParams.set("id", generationId);
  return url;
}

/** Generation records may be briefly unavailable or temporarily rate-limited. */
export function isRetryableGenerationStatus(status: number): boolean {
  return [404, 408, 425, 429, 500, 502, 503, 504, 524, 529].includes(status);
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Fetch a generation record, retrying transient failures while the caller's
 * overall timeout remains active. The callback is used for loud diagnostics.
 */
export async function fetchGenerationRecord(
  generationId: string,
  apiKey: string,
  signal: AbortSignal,
  onRetry?: (attempt: number, delayMs: number, status: number) => void,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(getGenerationUrl(generationId), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });

    if (
      response.ok ||
      !isRetryableGenerationStatus(response.status) ||
      attempt >= GENERATION_RETRY_DELAYS_MS.length
    ) {
      return response;
    }

    const delayMs = GENERATION_RETRY_DELAYS_MS[attempt];
    onRetry?.(attempt + 1, delayMs, response.status);
    await waitForRetry(delayMs, signal);
  }
}

/** Guard: true only when the request is going to OpenRouter. */
export function isOpenRouterRequest(ctx: any): boolean {
  const model = ctx.model;
  if (!model) return false;
  return model.provider === "openrouter";
}

/** Resolve OpenRouter API key: modelRegistry first, then env fallback. */
export async function resolveApiKey(ctx: any): Promise<string | undefined> {
  if (ctx.modelRegistry) {
    try {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider("openrouter");
      // A registry without configured auth returns undefined rather than
      // throwing. Still allow the documented environment fallback in that case.
      if (apiKey) return apiKey;
    } catch {
      // fall through to env fallback
    }
  }
  return process.env.OPENROUTER_API_KEY;
}

/**
 * Fetch and display a provider for a generation captured by the response hook.
 *
 * This deliberately runs after turn_end, rather than directly from
 * after_provider_response. Pi fires the latter before consuming the response
 * stream, and OpenRouter may not have persisted the generation record yet.
 */
async function lookupAndDisplayProvider(
  generationId: string,
  ctx: any,
  sequence: number,
): Promise<void> {
  const apiKey = await resolveApiKey(ctx);
  logWithCtx(ctx, "  -> API key resolved:", apiKey ? "yes" : "no");
  if (!apiKey) {
    if (sequence === latestGenerationSequence) {
      ctx.ui.notify(
        "openrouter-provider-status: no OpenRouter API key -- set OPENROUTER_API_KEY",
        "warning",
      );
      ctx.ui.setStatus("openrouter-provider", undefined);
    }
    return;
  }

  logWithCtx(ctx, "  -> fetching generation record for", generationId);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GENERATION_FETCH_TIMEOUT_MS);
    try {
      const res = await fetchGenerationRecord(
        generationId,
        apiKey,
        controller.signal,
        (attempt, delayMs, status) =>
          logWithCtx(
            ctx,
            `  -> generation record unavailable (${status}); retrying in ${delayMs}ms (retry ${attempt}/${GENERATION_RETRY_DELAYS_MS.length})`,
          ),
      );

      logWithCtx(ctx, "  -> fetch response status:", res.status, res.statusText);
      if (!res.ok) {
        if (sequence === latestGenerationSequence) {
          ctx.ui.setStatus("openrouter-provider", undefined);
          ctx.ui.notify(
            `openrouter-provider-status: generation record fetch failed (${res.status}${res.statusText ? ` ${res.statusText}` : ""})`,
            "warning",
          );
        }
        return;
      }

      const data = (await res.json()) as GenerationRecord;
      logWithCtx(
        ctx,
        "  -> generation record parsed, provider shape:",
        (data?.data?.provider_name ?? data?.provider?.provider_name)
          ? "present"
          : "missing",
      );

      const providerName = getProviderName(data);
      if (!providerName) {
        console.warn(
          "openrouter-provider-status: unexpected generation record shape",
          data,
        );
        if (sequence === latestGenerationSequence) {
          ctx.ui.notify(
            "openrouter-provider-status: unexpected record shape -- OpenRouter API may have changed",
            "warning",
          );
        }
        return;
      }

      logWithCtx(ctx, "  -> provider name from record:", providerName);
      setCachedProvider(generationId, providerName);

      // An older lookup must not overwrite the status for a newer request.
      if (sequence === latestGenerationSequence) {
        logWithCtx(ctx, "  -> setting status to", providerName);
        ctx.ui.setStatus("openrouter-provider", formatProviderStatus(providerName));
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    if (e?.name === "AbortError") {
      logWithCtx(ctx, "  -> fetch timed out");
      return;
    }
    logWithCtx(ctx, "  -> fetch error:", e);
    if (sequence === latestGenerationSequence) {
      ctx.ui.notify(
        "openrouter-provider-status: failed to fetch generation record",
        "warning",
      );
    }
    console.warn("openrouter-provider-status: fetch error", e);
  }
}

async function flushPendingGenerationLookups(ctx: any): Promise<void> {
  const pending = pendingGenerationLookups.splice(0);
  if (pending.length === 0) return;

  logWithCtx(
    ctx,
    "  -> response stream finished; looking up",
    pending.length,
    "generation record(s)",
  );
  await Promise.all(
    pending.map(({ generationId, sequence }) =>
      lookupAndDisplayProvider(generationId, ctx, sequence),
    ),
  );
}

// ─── Extension Entry Point ──────────────────────────────────────────────

export default function openrouterProviderStatus(pi: ExtensionAPI) {
  // ── before_provider_headers ──────────────────────────────────────────
  pi.on("before_provider_headers", (event, ctx) => {
    const model = ctx.model;
    const isOr = model && model.provider === "openrouter";
    logWithCtx(ctx, "before_provider_headers:", {
      isOpenRouter: isOr,
      modelId: model?.id,
      modelProvider: model?.provider,
    });
    if (!isOr) {
      logWithCtx(ctx, "  -> not an OpenRouter request, skipping header injection");
      return;
    }
    const headers = event.headers;
    logWithCtx(ctx, "  -> injecting", OR_METADATA_HEADER, "=", OR_METADATA_VALUE);
    if (headers) {
      headers[OR_METADATA_HEADER] = OR_METADATA_VALUE;
      logWithCtx(ctx, "  ->", OR_METADATA_HEADER, "injected successfully");
    }
  });

  // ── after_provider_response ──────────────────────────────────────────
  pi.on("after_provider_response", (event, ctx) => {
    // This hook runs before the provider stream is consumed. Capture the ID
    // here, but defer the lookup until turn_end.
    void (async () => {
      logWithCtx(ctx, "after_provider_response fired");

    // Clear any previously displayed provider when the request is not
    // OpenRouter (prevents a stale "DigitalOcean" from lingering after a
    // Claude/local request).
    if (!isOpenRouterRequest(ctx)) {
      logWithCtx(ctx, "  -> not an OpenRouter request, clearing status");
      advanceGenerationSequence();
      ctx.ui.setStatus("openrouter-provider", undefined);
      return;
    }

    const headers = event.headers;
    logWithCtx(ctx, "  -> headers available:", !!headers);
    if (!headers) {
      logWithCtx(ctx, "  -> no headers, clearing status");
      advanceGenerationSequence();
      ctx.ui.setStatus("openrouter-provider", undefined);
      return;
    }

    const generationId = getHeader(headers, GENERATION_ID_HEADER);
    logWithCtx(ctx, "  -> generation ID header:", generationId ? "present" : "missing");
    if (!generationId) {
      // Metadata header wasn't opted in, or this is a cache hit with no gen id.
      logWithCtx(ctx, "  -> no generation ID, bailing out (metadata header may not have been sent or provider didn't include it)");
      advanceGenerationSequence();
      return;
    }

    // Allocate a sequence for every OpenRouter response so an older
    // background lookup cannot overwrite a newer cached result.
    const sequence = advanceGenerationSequence();

    // Check cache before scheduling a network lookup.
    const cached = getCachedProvider(generationId);
    logWithCtx(ctx, "  -> cache hit:", cached ? cached : "miss");
    if (cached) {
      ctx.ui.setStatus("openrouter-provider", formatProviderStatus(cached));
      return;
    }

    // The record is often not available until the streaming response has
    // been fully consumed. Defer the lookup to turn_end rather than racing
    // OpenRouter's generation-record persistence from this hook.
    queueGenerationLookup(generationId, sequence);
    logWithCtx(
      ctx,
      "  -> queued generation lookup until response stream finishes (sequence",
      sequence,
      ")",
    );
    })().catch((error) => {
      console.warn("openrouter-provider-status: background handler error", error);
    });
  });

  // Pi emits turn_end after the provider stream and any tool results for the
  // turn have been consumed. This is the first reliable point to query the
  // generation endpoint.
  pi.on("turn_end", (_event, ctx) => {
    void flushPendingGenerationLookups(ctx).catch((error) => {
      console.warn("openrouter-provider-status: generation lookup flush failed", error);
    });
  });

  // ── Command: /or-provider ──────────────────────────────────────────
  pi.registerCommand("or-provider", {
    description:
      "Show the upstream provider for an OpenRouter generation. Usage: /or-provider [generation-id|loud on|off]",
    getArgumentCompletions: (prefix: string) => {
      // Offer loud subcommands when the user starts typing "loud".
      if (prefix.startsWith("loud")) {
        return [
          { value: "loud on", label: "loud on" },
          { value: "loud off", label: "loud off" },
        ];
      }
      // Offer cached generation IDs as completions.
      const cached = Array.from(generationCache.entries())
        .filter(([, entry]) => Date.now() - entry.fetchedAt <= CACHE_TTL_MS)
        .map(([id]) => id);
      if (prefix && cached.length > 0) {
        const matches = cached.filter((id) => id.startsWith(prefix));
        if (matches.length > 0) {
          return matches.map((id) => ({ value: id, label: id }));
        }
      }
      return null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      // Handle loud mode toggle subcommand.
      if (trimmed.startsWith("loud")) {
        const sub = trimmed.slice(4).trim().toLowerCase();
        if (sub === "on") {
          loud = true;
          ctx.ui.notify("openrouter-provider-status: loud logging ON", "info");
          log("loud mode enabled via /or-provider loud on");
          return;
        }
        if (sub === "off") {
          loud = false;
          ctx.ui.notify("openrouter-provider-status: loud logging OFF", "info");
          return;
        }
        ctx.ui.notify(
          "Usage: /or-provider loud on|off",
          "info",
        );
        return;
      }

      // If no argument, show the last cached provider.
      if (!trimmed) {
        const entries = Array.from(generationCache.entries()).filter(
          ([, entry]) => Date.now() - entry.fetchedAt <= CACHE_TTL_MS,
        );
        if (entries.length === 0) {
          ctx.ui.notify(
            "No cached provider info yet. Make an OpenRouter request first, or provide a generation ID.",
            "info",
          );
          return;
        }
        const lines = entries
          .map(([id, entry]) => `  ${id} -> ${entry.providerName}`)
          .join("\n");
        ctx.ui.notify(`Cached providers:\n${lines}`, "info");
        return;
      }

      // Fetch provider for the given generation ID.
      const apiKey = await resolveApiKey(ctx);
      if (!apiKey) {
        ctx.ui.notify(
          "No OpenRouter API key -- set OPENROUTER_API_KEY",
          "warning",
        );
        return;
      }

      ctx.ui.setStatus("openrouter-provider", "fetching...");
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), GENERATION_FETCH_TIMEOUT_MS);
        try {
          const res = await fetchGenerationRecord(
            trimmed,
            apiKey,
            controller.signal,
            (attempt, delayMs, status) =>
              logWithCtx(
                ctx,
                `  -> generation record unavailable (${status}); retrying in ${delayMs}ms (retry ${attempt}/${GENERATION_RETRY_DELAYS_MS.length})`,
              ),
          );

          if (!res.ok) {
            ctx.ui.notify(
              `openrouter-provider: generation record fetch failed (${res.status}${res.statusText ? ` ${res.statusText}` : ""})`,
              "warning",
            );
            return;
          }

          const data = (await res.json()) as GenerationRecord;
          const providerName = getProviderName(data);
          if (!providerName) {
            console.warn(
              "openrouter-provider: unexpected generation record shape",
              data,
            );
            ctx.ui.setStatus("openrouter-provider", undefined);
            ctx.ui.notify(
              "openrouter-provider: unexpected record shape -- OpenRouter API may have changed",
              "warning",
            );
            return;
          }

          setCachedProvider(trimmed, providerName);
          ctx.ui.setStatus("openrouter-provider", formatProviderStatus(providerName));
          ctx.ui.notify(`Provider: ${providerName}`, "info");
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        if (e?.name === "AbortError") {
          ctx.ui.setStatus("openrouter-provider", undefined);
          return;
        }
        ctx.ui.setStatus("openrouter-provider", undefined);
        ctx.ui.notify(
          "openrouter-provider: failed to fetch generation record",
          "warning",
        );
        console.warn("openrouter-provider: fetch error", e);
      }
    },
  });
}
