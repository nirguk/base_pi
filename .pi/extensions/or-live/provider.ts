/**
 * openrouter-provider-status — Pi extension (TypeScript)
 *
 * Shows the actual upstream provider that served an OpenRouter request
 * in the terminal footer status line. Once a response completes, the footer
 * also shows the provider's rolling 30-minute TPS beside the model-slug
 * provider-average benchmark (e.g. "Provider:DigitalOcean · TPS30m:42.1 / OR30m:55.0 ↓ ;").
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
 * network round-trip. Completed responses are retained in a rolling
 * 30-minute per-model/per-provider TPS window.
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
import {
  formatTPS,
  getModelBenchmarkTPS,
  subscribeModelBenchmarkTPS,
} from "./throughput";

// ─── Monotonic clock ──────────────────────────────────────────────────────

/** Base offset so monotonicNow() is comparable to Date.now() at module load. */
const monotonicBase = Date.now() - performance.now();
/** Monotonic time in ms (immune to system clock adjustments). */
function monotonicNow(): number {
  return performance.now() + monotonicBase;
}

// ─── Constants ──────────────────────────────────────────────────────────

/** Header name used to opt in to provider metadata in the response body. */
const OR_METADATA_HEADER = "X-OpenRouter-Metadata";
/** Header value that enables provider metadata inclusion in the response. */
const OR_METADATA_VALUE = "enabled";
/** Header name carrying the generation ID for post-response provider lookups. */
const GENERATION_ID_HEADER = "X-Generation-Id";
/** OpenRouter generation-record endpoint URL. */
const GENERATION_ENDPOINT = "https://openrouter.ai/api/v1/generation";
/** Overall timeout (ms) for a single generation-record fetch attempt. */
const GENERATION_FETCH_TIMEOUT_MS = 30000;
/** Retry delays (ms) for transient generation-record failures (404, 429, 502, etc.). */
const GENERATION_RETRY_DELAYS_MS = [1000, 2000, 3000, 4000, 5000, 6000] as const;
/** TTL (ms) for the in-memory generation-record cache. */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** Default rolling window (ms) for provider history display (1 hour). */
const DEFAULT_HISTORY_WINDOW_MS = 60 * 60 * 1000;
/** Default cap on how many prior providers are shown in the right zone. */
const DEFAULT_PRIOR_LIMIT = 8;

/** Live history window (ms). Override via `--or-provider-history-window`. */
let historyWindowMs = DEFAULT_HISTORY_WINDOW_MS;
/** Live cap on displayed prior providers. Override via `--or-provider-prior-limit`. */
let priorLimit = DEFAULT_PRIOR_LIMIT;

/** Override the history window. Called by the registered CLI flag. */
export function setHistoryWindowMs(value: number | null): void {
  historyWindowMs = Number.isFinite(value) && value > 0 ? value : DEFAULT_HISTORY_WINDOW_MS;
}
/** Override the prior-provider display cap. Called by the registered CLI flag. */
export function setPriorLimit(value: number | null): void {
  priorLimit = Number.isFinite(value) && value > 0 ? value : DEFAULT_PRIOR_LIMIT;
}
export function getHistoryWindowMs(): number { return historyWindowMs; }
export function getPriorLimit(): number { return priorLimit; }

/** Rolling window (ms) for per-provider TPS observations before they are pruned. */
const ROLLING_TPS_WINDOW_MS = 30 * 60 * 1000;
/** Maximum number of response measurements retained in the in-memory map. */
const MAX_RESPONSE_MEASUREMENTS = 100;
/** Maximum number of generation records cached in-memory. */
const MAX_CACHE_SIZE = 500;
/** Batch size for background TPS fetches. */
const TPS_FETCH_BATCH_SIZE = 20;
/** Minimum interval (ms) between TPS fetch progress notifications. */
const TPS_FETCH_PROGRESS_INTERVAL = 1000;

// ─── Loud logging mode ──────────────────────────────────────────────────

// When true, emits verbose console + TUI notifications at every decision
// point. Toggled via:
//   - env var OPENROUTER_PROVIDER_STATUS_LOUD=1 (always-on)
//   - /or-provider loud on|off (runtime toggle)
const LOUD_VAR = "OPENROUTER_PROVIDER_STATUS_LOUD";
let loud = process.env[LOUD_VAR] === "1";

/** Return whether loud (verbose) logging is currently enabled. */
export function isLoud(): boolean {
  return loud;
}

/** Enable or disable loud (verbose) logging at runtime. */
export function setLoud(value: boolean): void {
  loud = value;
}

/** Emit a verbose log line when loud mode is active.
 *  Appears in console output with a prefix. TUI-side notifications are
 *  added explicitly at each call site (since log() has no ctx access).
 */
export function log(...args: unknown[]): void {
  if (isLoud()) {
    console.log("[openrouter-provider-status]", ...args);
  }
}

/** Like log(), but also sends a TUI notification via ctx.ui.notify()
 *  when loud mode is active. Use this in event handlers where ctx is
 *  available so the user sees decisions in the footer/status line.
 */
export function logWithCtx(ctx: ProviderHandlerCtx, ...args: unknown[]): void {
  if (isLoud()) {
    console.log("[openrouter-provider-status]", ...args);
    try {
      ctx.ui.notify(
        `[openrouter-provider-status] ${args.map(String).join(" ")}`,
        "info",
      );
    } catch {
      // ctx.ui may be stale or unavailable in edge cases
    }
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

export interface TPSObservation {
  completedAt: number;
  outputTokens: number;
  durationMs: number;
}

interface ResponseMeasurement {
  generationId: string;
  slug: string;
  requestStartedAt: number;
  streamStartedAt?: number;
  completedAt?: number;
  outputTokens?: number;
  providerName?: string;
  sampleRecorded?: boolean;
}

/** Minimal reference for updating the provider status in the footer.
 *  Stores only what the formatting and display helpers need, avoiding
 *  a reference to the full (potentially large) ctx object.
 */
export interface ProviderStatusRef {
  setStatus: (key: string, text: string | undefined) => void;
  theme: { fg: (color: string, text: string) => string };
  slug: string;
  providerName: string;
}

/** Event payload for `before_provider_headers` and `after_provider_response` hooks.
 *  `headers` is key-normalised to lowercase by the Fetch Headers implementation.
 */
interface ProviderHeadersEvent {
  headers?: Record<string, string>;
}

/** Event payload for `message_start` and `message_end` hooks. */
interface ProviderMessageEvent {
  message?: {
    role?: string;
    usage?: { output?: number };
  };
}

/** Context object passed to provider event handlers and command handlers.
 *  Captures the subset of the Pi extension API surface used by this module.
 */
interface ProviderHandlerCtx {
  model?: {
    id?: string;
    provider?: string;
  };
  modelRegistry?: {
    getApiKeyForProvider(provider: string): Promise<string | undefined>;
  };
  ui: {
    setStatus(key: string, text: string | undefined): void;
    notify(message: string, level: string): void;
    theme: { fg(color: string, text: string): string };
  };
  hasUI?: boolean;
  scopedModels?: unknown[];
}

/** Parameters for the `/or-provider` command handler. */
interface OrProviderCommandParams {
  args: string;
  ctx: ProviderHandlerCtx;
}

/** Last known non-blank provider status text, retained so the footer never
 *  disappears while a deferred generation lookup is pending or failing.
 *  Updated whenever `setProviderStatus` writes a concrete provider string. */
let lastKnownProviderText: string | null = null;
export function getLastKnownProviderText(): string | null {
  return lastKnownProviderText;
}
export function clearLastKnownProviderText(): void {
  lastKnownProviderText = null;
}

/** Update the provider status footer: show TPS-enhanced text when it adds information, otherwise the plain provider name. */
function setProviderStatus(
  providerName: string,
  slug: string,
  ref: ProviderStatusRef | undefined,
  ctx: ProviderHandlerCtx,
): void {
  const baseText = ref
    ? formatProviderStatusWithRef(providerName, slug, ref)
    : formatProviderStatus(providerName);
  const enhanced = ref
    ? formatProviderTPSStatusWithRef(providerName, slug, ref)
    : formatProviderTPSStatus(providerName, slug);
  const text = enhanced !== baseText ? enhanced : baseText;
  // Skip redundant UI updates — the footer already shows this text.
  if (text === lastKnownProviderText) return;
  ctx.ui.setStatus("openrouter-provider", text);
  // Remember so the footer can fall back to a dimmed last-known value
  // instead of vanishing during the next deferred lookup.
  lastKnownProviderText = text;
}

// ─── In-memory cache ────────────────────────────────────────────────────

const generationCache = new Map<string, CacheEntry>();
const providerTPSObservations = new Map<string, TPSObservation[]>();
const responseMeasurements = new Map<string, ResponseMeasurement>();

// ─── Observed providers registry ─────────────────────────────────────

// slug -> Map<providerName, lastCompletedAt>
const observedProviders = new Map<string, Map<string, number>>();

export function recordObservedProvider(slug: string, providerName: string, completedAt: number): void {
  if (!slug || !providerName) return;
  if (!observedProviders.has(slug)) {
    observedProviders.set(slug, new Map());
  }
  observedProviders.get(slug)!.set(providerName, completedAt);
  pruneObservedProvidersIfNeeded(slug);
}

export function pruneObservedProviders(slug: string, now = monotonicNow(), windowMs = historyWindowMs): void {
  const cutoff = now - windowMs;
  const providers = observedProviders.get(slug);
  if (!providers) return;
  for (const [name, ts] of providers) {
    if (ts < cutoff) providers.delete(name);
  }
  if (providers.size === 0) observedProviders.delete(slug);
}

export function clearObservedProviders(): void {
  observedProviders.clear();
}

function providerTPSKey(slug: string, providerName: string): string {
  return `${slug}\u0000${providerName}`;
}

function pruneTPSObservations(now = monotonicNow()): void {
  const cutoff = now - ROLLING_TPS_WINDOW_MS;
  for (const [key, observations] of providerTPSObservations) {
    const recent = observations.filter((sample) => sample.completedAt >= cutoff);
    if (recent.length === 0) providerTPSObservations.delete(key);
    else providerTPSObservations.set(key, recent);
  }
}

/** Maximum number of TPS observation entries per (slug, provider) key
 *  before proactive pruning removes the oldest samples. */
const MAX_TPS_OBSERVATIONS_PER_KEY = 200;
/** Maximum number of entries per slug in observedProviders before
 *  proactive pruning removes the oldest entries. */
const MAX_OBSERVED_PROVIDERS_PER_SLUG = 50;

function pruneTPSObservationsIfNeeded(): void {
  for (const [key, observations] of providerTPSObservations) {
    if (observations.length > MAX_TPS_OBSERVATIONS_PER_KEY) {
      const sorted = observations.sort((a, b) => b.completedAt - a.completedAt);
      providerTPSObservations.set(key, sorted.slice(0, MAX_TPS_OBSERVATIONS_PER_KEY));
    }
  }
}

function pruneObservedProvidersIfNeeded(slug: string): void {
  const providers = observedProviders.get(slug);
  if (!providers || providers.size <= MAX_OBSERVED_PROVIDERS_PER_SLUG) return;
  const entries = Array.from(providers.entries()).sort((a, b) => b[1] - a[1]);
  for (const [name] of entries.slice(MAX_OBSERVED_PROVIDERS_PER_SLUG)) {
    providers.delete(name);
  }
  if (providers.size === 0) observedProviders.delete(slug);
}

/** Add one completed response to the rolling provider throughput window. */
export function recordProviderTPS(
  slug: string,
  providerName: string,
  outputTokens: number,
  durationMs: number,
  completedAt = monotonicNow(),
): boolean {
  if (!slug || typeof slug !== "string" || slug.trim().length === 0) {
    log("recordProviderTPS skipped: invalid slug", { slug });
    return false;
  }
  if (!providerName || !Number.isFinite(outputTokens) || outputTokens <= 0 ||
      !Number.isFinite(durationMs) || durationMs <= 0) {
    log("recordProviderTPS skipped: invalid input", { slug, providerName, outputTokens, durationMs });
    return false;
  }
  pruneTPSObservations(completedAt);
  pruneTPSObservationsIfNeeded();
  const key = providerTPSKey(slug, providerName);
  const observations = providerTPSObservations.get(key) ?? [];
  observations.push({ completedAt, outputTokens, durationMs });
  providerTPSObservations.set(key, observations);
  return true;
}

/**
 * Return a duration-weighted rolling average. Weighting by elapsed time keeps
 * a tiny fast response from dominating a long response with many tokens.
 */
export function getProviderRollingTPS(
  slug: string,
  providerName: string,
  now = monotonicNow(),
): number | null {
  pruneTPSObservations(now);
  const observations = providerTPSObservations.get(providerTPSKey(slug, providerName));
  if (!observations || observations.length === 0) return null;
  const tokens = observations.reduce((sum, sample) => sum + sample.outputTokens, 0);
  const durationMs = observations.reduce((sum, sample) => sum + sample.durationMs, 0);
  return durationMs > 0 ? tokens / (durationMs / 1000) : null;
}

export function clearTPSObservations(): void {
  providerTPSObservations.clear();
  responseMeasurements.clear();
  observedProviders.clear();
}

export function formatProviderTPSStatus(
  providerName: string,
  slug: string,
): string {
  const observed = getProviderRollingTPS(slug, providerName);
  const benchmark = getModelBenchmarkTPS(slug);
  if (observed == null && benchmark == null) {
    return `Provider:${providerName} ;`;
  }
  const parts: string[] = [];
  if (observed != null) {
    parts.push(`TPS30m:${formatTPS(observed)}`);
  }
  if (benchmark != null) {
    parts.push(`OR30m:${formatTPS(benchmark)}`);
  }
  if (parts.length === 0) {
    return `Provider:${providerName} ;`;
  }
  const arrow = observed != null && benchmark != null
    ? (observed > benchmark ? " ↑" : observed < benchmark ? " ↓" : " →")
    : "";
  const tps = `${parts.join(" / ")}${arrow}`;
  return `Provider:${providerName} · ${tps} ;`;
}

/** Format provider+TPS status using a ProviderStatusRef for theme-aware
 *  styling. Previous providers observed in the 30m rolling window are
 *  appended to the right, grayed out via ref.theme.fg("dim", ...).
 *  Callers should prune stale providers before calling this function.
 */
export function formatProviderTPSStatusWithRef(
  providerName: string,
  slug: string,
  ref: ProviderStatusRef,
): string {
  const base = formatProviderTPSStatus(providerName, slug);
  const providers = observedProviders.get(slug);
  if (!providers) return base;

  const others = Array.from(providers.entries())
    .filter(([name]) => name !== providerName)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => ref.theme.fg("dim", name))
    .join(" ");

  if (others.length === 0) return base;
  return `${base} ${others}`;
}

/** @deprecated Use formatProviderTPSStatusWithRef instead when a ref is available. */
export function formatProviderTPSStatusWithCtx(
  providerName: string,
  slug: string,
  _ctx: ProviderHandlerCtx,
): string {
  return formatProviderTPSStatus(providerName, slug);
}

function startResponseMeasurement(generationId: string, ctx: ProviderHandlerCtx, orSlug?: string | null): void {
  const slug = orSlug ?? ctx.model?.id;
  if (!slug) return;
  responseMeasurements.set(generationId, { generationId, slug, requestStartedAt: monotonicNow() });
  // Proactively prune stale entries on every insertion so the map
  // doesn't grow unboundedly across a long-running session.
  const cutoff = monotonicNow() - ROLLING_TPS_WINDOW_MS;
  for (const [key, measurement] of responseMeasurements) {
    if (measurement.requestStartedAt < cutoff) responseMeasurements.delete(key);
  }
  // Keep this bounded as a secondary safeguard if a provider fails
  // before emitting message_end and entries accumulate faster than
  // the time-based pruning can catch up.
  while (responseMeasurements.size > MAX_RESPONSE_MEASUREMENTS) {
    const oldestKey = responseMeasurements.keys().next().value;
    if (oldestKey && responseMeasurements.get(oldestKey)!.requestStartedAt < cutoff) {
      responseMeasurements.delete(oldestKey);
    } else {
      break;
    }
  }
  // Also sweep stale entries from the TPS observations store so it
  // doesn't grow unboundedly across a long-running session.
  pruneTPSObservations();
}

function findMeasurementForMessage(ctx: ProviderHandlerCtx, generationId?: string): ResponseMeasurement | undefined {
  const slug = ctx.model?.id;
  if (!slug) return undefined;
  for (const measurement of responseMeasurements.values()) {
    if (measurement.completedAt) continue;
    if (generationId) {
      if (measurement.generationId === generationId) return measurement;
      continue;
    }
    if (measurement.slug === slug) return measurement;
  }
  return undefined;
}

function recordCompletedMeasurement(measurement: ResponseMeasurement): void {
  if (measurement.sampleRecorded || !measurement.providerName ||
      measurement.completedAt == null || measurement.outputTokens == null) return;
  const startedAt = measurement.streamStartedAt ?? measurement.requestStartedAt;
  if (recordProviderTPS(
    measurement.slug,
    measurement.providerName,
    measurement.outputTokens,
    Math.max(1, measurement.completedAt - startedAt),
    measurement.completedAt,
  )) measurement.sampleRecorded = true;
  recordObservedProvider(measurement.slug, measurement.providerName, measurement.completedAt);
}

function attachProviderToMeasurement(generationId: string, providerName: string): ResponseMeasurement | undefined {
  const measurement = responseMeasurements.get(generationId);
  if (measurement) {
    measurement.providerName = providerName;
    recordCompletedMeasurement(measurement);
  }
  return measurement;
}

// ─── Pending generation lookups ─────────────────────────────────────────

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

/** Track which model slug each pending lookup belongs to so turn_end
 *  only flushes lookups for the current model, not lookups queued for
 *  a different model that would record TPS against the wrong slug. */
const pendingLookupSlugs = new Map<number, string>();

export function getCachedProvider(generationId: string): string | null {
  const entry = generationCache.get(generationId);
  if (!entry) return null;
  if (monotonicNow() - entry.fetchedAt > CACHE_TTL_MS) {
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

/** Format the provider status using a ProviderStatusRef for theme-aware
 *  styling. Previous providers observed in the 30m rolling window are
 *  appended to the right, grayed out via ref.theme.fg("dim", ...).
 *  Callers should prune stale providers before calling this function.
 */
export function formatProviderStatusWithRef(
  providerName: string,
  slug: string,
  ref: ProviderStatusRef,
): string {
  const base = formatProviderStatus(providerName);
  const providers = observedProviders.get(slug);
  if (!providers) return base;

  const others = Array.from(providers.entries())
    .filter(([name]) => name !== providerName)
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => ref.theme.fg("dim", name))
    .join(" ");

  if (others.length === 0) return base;
  return `${base} ${others}`;
}

/** @deprecated Use formatProviderStatusWithRef instead when a ref is available. */
export function formatProviderStatusWithCtx(
  providerName: string,
  slug: string,
  _ctx: ProviderHandlerCtx,
): string {
  return formatProviderStatus(providerName);
}

export function setCachedProvider(generationId: string, providerName: string): void {
  // Proactively remove stale entries before inserting so the cache
  // does not grow unboundedly across a long-running session.
  const cutoff = monotonicNow() - CACHE_TTL_MS;
  for (const [key, entry] of generationCache) {
    if (entry.fetchedAt < cutoff) generationCache.delete(key);
  }
  // FIFO eviction when cache exceeds MAX_CACHE_SIZE.
  if (generationCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = generationCache.keys().next().value;
    if (oldestKey !== undefined) generationCache.delete(oldestKey);
  }
  generationCache.set(generationId, { providerName, fetchedAt: monotonicNow() });
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
  slug: string,
  sequence = advanceGenerationSequence(),
): number {
  latestGenerationSequence = Math.max(latestGenerationSequence, sequence);

  // A provider retry or duplicate hook should not cause duplicate lookups.
  if (!pendingGenerationLookups.some((entry) => entry.generationId === generationId)) {
    pendingGenerationLookups.push({ generationId, sequence });
    pendingLookupSlugs.set(sequence, slug);
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
  if (!generationId || typeof generationId !== "string" || !generationId.trim()) {
    throw new TypeError(`Invalid generation ID: ${String(generationId)}`);
  }
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

/** Check whether a response contains JSON content. */
function isJsonResponse(response: Response): boolean {
  const contentType = typeof response.headers?.get === "function"
    ? (response.headers.get("content-type") ?? "")
    : "";
  // If no content-type is set, assume JSON for backward compatibility.
  // Only reject responses that explicitly declare a non-JSON type.
  if (!contentType) return true;
  return contentType.includes("application/json");
}

/** Guard: true only when the request is going to OpenRouter. */
export function isOpenRouterRequest(ctx: ProviderHandlerCtx): boolean {
  const model = ctx.model;
  if (!model) return false;
  return model.provider === "openrouter";
}

/** Resolve OpenRouter API key: modelRegistry first, then env fallback. */
export async function resolveApiKey(ctx: ProviderHandlerCtx): Promise<string | undefined> {
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
  ctx: ProviderHandlerCtx,
  sequence: number,
  onProviderResolved?: (providerName: string, slug: string) => void,
  ref?: ProviderStatusRef,
): Promise<void> {
  const apiKey = await resolveApiKey(ctx);
  logWithCtx(ctx, "  -> API key resolved:", apiKey ? "yes" : "no");
  if (!apiKey) {
    if (sequence === latestGenerationSequence) {
      ctx.ui.notify(
        "openrouter-provider-status: no OpenRouter API key -- set OPENROUTER_API_KEY",
        "warning",
      );
      // Keep the last-known provider so the footer doesn't vanish on a
      // transient auth/config problem.
      ctx.ui.setStatus("openrouter-provider", lastKnownProviderText ?? undefined);
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
          ctx.ui.setStatus("openrouter-provider", lastKnownProviderText ?? undefined);
          ctx.ui.notify(
            `openrouter-provider-status: generation record fetch failed (${res.status}${res.statusText ? ` ${res.statusText}` : ""})`,
            "warning",
          );
        }
        return;
      }

      if (!isJsonResponse(res)) {
        if (sequence === latestGenerationSequence) {
          ctx.ui.setStatus("openrouter-provider", lastKnownProviderText ?? undefined);
          ctx.ui.notify(
            `openrouter-provider-status: generation record fetch returned non-JSON response (content-type: ${res.headers.get("content-type") ?? "unknown"})`,
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
      const measurement = attachProviderToMeasurement(generationId, providerName);

      // An older lookup must not overwrite the status for a newer request.
      if (sequence === latestGenerationSequence) {
        onProviderResolved?.(
          providerName,
          measurement?.slug || ctx.model?.id || "",
        );
        logWithCtx(ctx, "  -> setting status to", providerName);
        const slug = measurement?.slug || ctx.model?.id || "";
        pruneObservedProviders(slug);
        setProviderStatus(providerName, slug, ref, ctx);
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    if (e?.name === "AbortError") {
      logWithCtx(ctx, "  -> fetch timed out");
      log("fetch timed out (generation record lookup skipped this turn)");
      return;
    }
    logWithCtx(ctx, "  -> fetch error:", e);
    // Absorb quietly: this is a cosmetic background lookup, the footer still
    // shows the last-known provider, and the model response is unaffected.
    // Loud mode surfaces the details; the user gets no failure toast.
    log("fetch error (generation record lookup skipped this turn):", e);
  }
}

async function flushPendingGenerationLookups(
  ctx: ProviderHandlerCtx,
  onProviderResolved?: (providerName: string, slug: string) => void,
  ref?: ProviderStatusRef,
): Promise<void> {
  const currentSlug = ctx.model?.id ?? "";
  // Only flush lookups that belong to the current model. Lookups queued
  // for a different model would record TPS against the wrong slug.
  const pending = pendingGenerationLookups.splice(0);
  const ownLookups: PendingGenerationLookup[] = [];
  const otherLookups: PendingGenerationLookup[] = [];
  for (const lookup of pending) {
    const lookupSlug = pendingLookupSlugs.get(lookup.sequence);
    if (lookupSlug === currentSlug) {
      // Own model: consume the mapping and process the lookup.
      pendingLookupSlugs.delete(lookup.sequence);
      ownLookups.push(lookup);
    } else {
      // Other model: keep the slug mapping intact so it can be
      // matched again when that model's turn_end fires.
      otherLookups.push(lookup);
    }
  }
  if (ownLookups.length === 0) return;

  logWithCtx(
    ctx,
    "  -> response stream finished; looking up",
    ownLookups.length,
    "generation record(s)",
  );
  await Promise.all(
    ownLookups.map(({ generationId, sequence }) =>
      lookupAndDisplayProvider(generationId, ctx, sequence, onProviderResolved, ref),
    ),
  );
}

// ─── Extension Entry Point ──────────────────────────────────────────────

let unsubscribeBenchmarkUpdates: (() => void) | undefined;
/** Shared across setupProvider re-entries so stale callbacks from a
 *  previous session don't update the wrong footer state. */
let currentProviderStatus: ProviderStatusRef | null = null;

export function setupProvider(pi: ExtensionAPI) {
  // Reset provider status on re-entry so the new session starts clean.
  currentProviderStatus = null;

  // Register configurable history window / prior-limit as CLI flags.
  try { pi.registerFlag?.("or-provider-history-window", { description: "History window (ms) for prior providers shown dimmed in the footer", type: "number", default: DEFAULT_HISTORY_WINDOW_MS }); }
  catch (e) { if (!(e instanceof TypeError)) throw e; }
  try { pi.registerFlag?.("or-provider-prior-limit", { description: "Max prior providers shown dimmed in the footer", type: "number", default: DEFAULT_PRIOR_LIMIT }); }
  catch (e) { if (!(e instanceof TypeError)) throw e; }
  try { setHistoryWindowMs(pi.getFlag?.("or-provider-history-window") ?? DEFAULT_HISTORY_WINDOW_MS); }
  catch (e) { if (!(e instanceof TypeError)) throw e; }
  try { setPriorLimit(pi.getFlag?.("or-provider-prior-limit") ?? DEFAULT_PRIOR_LIMIT); }
  catch (e) { if (!(e instanceof TypeError)) throw e; }

  // If OR-metrics finishes its background endpoint fetch after a response,
  // refresh the same footer immediately instead of waiting for another turn.
  // Unsubscribe any previous subscription to prevent leaks on re-entry.
  unsubscribeBenchmarkUpdates?.();
  unsubscribeBenchmarkUpdates = subscribeModelBenchmarkTPS((slug) => {
    if (currentProviderStatus?.slug !== slug) return;
    pruneObservedProviders(slug);
    currentProviderStatus.setStatus(
      "openrouter-provider",
      formatProviderTPSStatusWithRef(
        currentProviderStatus.providerName,
        slug,
        currentProviderStatus,
      ),
    );
  });

  function rememberProviderStatus(ctx: ProviderHandlerCtx, providerName: string, slug: string): void {
    if (!slug) return;
    currentProviderStatus = {
      setStatus: ctx.ui.setStatus,
      theme: ctx.ui.theme,
      slug,
      providerName,
    };
  }

  // ── before_provider_headers ──────────────────────────────────────────
  pi.on("before_provider_headers", (event: ProviderHeadersEvent, ctx: ProviderHandlerCtx) => {
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
  pi.on("after_provider_response", (event: ProviderHeadersEvent, ctx: ProviderHandlerCtx) => {
    // This hook runs before the provider stream is consumed. Capture the ID
    // here, but defer the lookup until turn_end.
    //
    // CRITICAL: ctx.model may change if another request starts before the
    // async body runs (fire-and-forget). Capture the slug early so all
    // downstream logic uses the correct model.
    const orSlug = ctx.model?.id ?? null;
    const isOr = isOpenRouterRequest(ctx);
    void (async () => {
      logWithCtx(ctx, "after_provider_response fired");

    // Clear any previously displayed provider when the request is not
    // OpenRouter (prevents a stale "DigitalOcean" from lingering after a
    // Claude/local request).
    if (!isOr) {
      logWithCtx(ctx, "  -> not an OpenRouter request, clearing status");
      currentProviderStatus = null;
      lastKnownProviderText = null;
      ctx.ui.setStatus("openrouter-provider", undefined);
      return;
    }

    // A new request supersedes the provider/TPS pair from the previous one.
    // IMPORTANT: do not blank the footer — keep the last-known provider text
    // so the user doesn't see it vanish while the deferred generation lookup
    // is in flight. A failed lookup now falls back to this value instead of
    // leaving the footer empty.
    if (lastKnownProviderText) {
      ctx.ui.setStatus("openrouter-provider", lastKnownProviderText);
    } else {
      ctx.ui.setStatus("openrouter-provider", undefined);
    }

    const headers = event.headers;
    logWithCtx(ctx, "  -> headers available:", !!headers);
    if (!headers) {
      logWithCtx(ctx, "  -> no headers, clearing status");
      lastKnownProviderText = null;
      ctx.ui.setStatus("openrouter-provider", undefined);
      return;
    }

    const generationId = getHeader(headers, GENERATION_ID_HEADER);
    logWithCtx(ctx, "  -> generation ID header:", generationId ? "present" : "missing");
    if (!generationId) {
      // Metadata header wasn't opted in, or this is a cache hit with no gen id.
      logWithCtx(ctx, "  -> no generation ID, bailing out (metadata header may not have been sent or provider didn't include it)");
      lastKnownProviderText = null;
      ctx.ui.setStatus("openrouter-provider", undefined);
      return;
    }

    // Allocate a sequence for every OpenRouter response so an older
    // background lookup cannot overwrite a newer cached result.
    const sequence = advanceGenerationSequence();
    startResponseMeasurement(generationId, ctx, orSlug);

    // Check cache before scheduling a network lookup.
    const cached = getCachedProvider(generationId);
    logWithCtx(ctx, "  -> cache hit:", cached ? cached : "miss");
    if (cached) {
      const measurement = attachProviderToMeasurement(generationId, cached);
      const slug = measurement?.slug || ctx.model?.id || "";
      rememberProviderStatus(ctx, cached, slug);
      const ref = currentProviderStatus;
      setProviderStatus(cached, slug, ref, ctx);
      return;
    }

    // The record is often not available until the streaming response has
    // been fully consumed. Defer the lookup to turn_end rather than racing
    // OpenRouter's generation-record persistence from this hook.
    queueGenerationLookup(generationId, orSlug ?? "", sequence);
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

  // Measure from the first assistant message event rather than from the HTTP
  // request. This excludes connection/queue latency and approximates the
  // throughput represented by OpenRouter's endpoint metric.
  pi.on("message_start", (event: ProviderMessageEvent, ctx: ProviderHandlerCtx) => {
    if (event.message?.role !== "assistant" || !isOpenRouterRequest(ctx)) return;
    // message_start does not have access to the generationId, so we
    // match by slug only. See findMeasurementForMessage for caveats
    // about concurrent streams for the same model.
    const measurement = findMeasurementForMessage(ctx);
    if (measurement && measurement.streamStartedAt == null) {
      measurement.streamStartedAt = monotonicNow();
    }
  });

  pi.on("message_end", (event: ProviderMessageEvent, ctx: ProviderHandlerCtx) => {
    if (event.message?.role !== "assistant" || !isOpenRouterRequest(ctx)) return;
    const measurement = findMeasurementForMessage(ctx);
    if (!measurement) return;
    measurement.completedAt = monotonicNow();
    const output = event.message.usage?.output;
    measurement.outputTokens = typeof output === "number" ? output : undefined;
    recordCompletedMeasurement(measurement);

    if (measurement.providerName) {
      rememberProviderStatus(ctx, measurement.providerName, measurement.slug);
      const ref = currentProviderStatus;
      if (ref) {
        pruneObservedProviders(measurement.slug);
      }
      ctx.ui.setStatus(
        "openrouter-provider",
        ref
          ? formatProviderTPSStatusWithRef(measurement.providerName, measurement.slug, ref)
          : formatProviderTPSStatus(measurement.providerName, measurement.slug),
      );
    }
  });

  // Pi emits turn_end after the provider stream and any tool results for the
  // turn have been consumed. This is the first reliable point to query the
  // generation endpoint.
  pi.on("turn_end", (_event: unknown, ctx: ProviderHandlerCtx) => {
    // Only flush pending lookups for OpenRouter turns. Non-OR turns
    // (e.g. Claude/local models) should not consume OR lookups meant
    // for a different model, which would record TPS against the wrong slug.
    if (!isOpenRouterRequest(ctx)) return;
    void flushPendingGenerationLookups(
      ctx,
      (providerName, slug) => rememberProviderStatus(ctx, providerName, slug),
      currentProviderStatus ?? undefined,
    ).catch((error) => {
      console.warn("openrouter-provider-status: generation lookup flush failed", error);
    });
  });

  pi.on("session_shutdown", () => {
    unsubscribeBenchmarkUpdates?.();
    currentProviderStatus = null;
    lastKnownProviderText = null;
    clearTPSObservations();
    clearObservedProviders();
    clearCache();
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
        .filter(([, entry]) => monotonicNow() - entry.fetchedAt <= CACHE_TTL_MS)
        .map(([id]) => id);
      if (prefix && cached.length > 0) {
        const matches = cached.filter((id) => id.startsWith(prefix));
        if (matches.length > 0) {
          return matches.map((id) => ({ value: id, label: id }));
        }
      }
      return null;
    },
    handler: async (args: string, ctx: ProviderHandlerCtx) => {
      const trimmed = args.trim();

      // Handle loud mode toggle subcommand.
      if (trimmed.startsWith("loud")) {
        const sub = trimmed.slice(4).trim().toLowerCase();
        if (sub === "on") {
          setLoud(true);
          ctx.ui.notify("openrouter-provider-status: loud logging ON", "info");
          log("loud mode enabled via /or-provider loud on");
          return;
        }
        if (sub === "off") {
          setLoud(false);
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
          ([, entry]) => monotonicNow() - entry.fetchedAt <= CACHE_TTL_MS,
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

          if (!isJsonResponse(res)) {
            ctx.ui.setStatus("openrouter-provider", undefined);
            ctx.ui.notify(
              `openrouter-provider: generation record fetch returned non-JSON response (content-type: ${res.headers.get("content-type") ?? "unknown"})`,
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
          const slug = ctx.model?.id || "";
          rememberProviderStatus(ctx, providerName, slug);
          const ref = currentProviderStatus;
          pruneObservedProviders(slug);
          setProviderStatus(providerName, slug, ref, ctx);
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
