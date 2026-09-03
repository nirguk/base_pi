# Notes on Pi ↔ OpenRouter robustness & streaming cancellation

Purpose: capture verified learnings about pi's configurable resilience knobs, retry/timeout semantics, and stream-abort mechanisms so a future session does not have to re-derive them. All findings below were checked against the installed package sources; package root is `P=/usr/local/share/nvm/versions/node/v26.7.0/lib/node_modules/@earendil-works/pi-coding-agent`.

TL;DR: for a robust pi/OpenRouter setup, the three settings that matter are `retry.enabled` (agent-level retry, default on), `httpIdleTimeoutMs` (undici idle timeouts on the global dispatcher, default 300 000 ms = 5 min), and `retry.provider.timeoutMs` (SDK timeout that bounds time-to-first-response-headers, defaults to the value of `httpIdleTimeoutMs`). `transport` does NOT affect OpenRouter (SSE only — see below). Nothing in pi applies a total-request deadline to an in-flight streaming response; mid-stream cancellation comes from Escape, the abort signal chain, or idle times outs.

## Configurable resilience knobs (settings.json: `~/.pi/agent/settings.json` global, `.pi/settings.json` project)

| Setting | Default | Effect |
|---------|---------|--------|
| `retry.enabled` | `true` | Agent-level retry of a failed assistant turn on transient errors |
| `retry.maxRetries` | `3` | Max agent-level retry attempts (exponential backoff `baseDelayMs * 2^(n-1)`: 2s, 4s, 8s) |
| `retry.baseDelayMs` | `2000` | Base delay for agent-level backoff |
| `retry.provider.timeoutMs` | SDK default (10 min via openai SDK, but pi defaults it to `httpIdleTimeoutMs`) | Provider/SDK request timeout; bounds time until response HEADERS arrive, not the whole stream |
| `retry.provider.maxRetries` | `0` | Provider/SDK-level retry attempts (docs warn: above 0 can hide quota errors from pi) |
| `retry.provider.maxRetryDelayMs` | `60000` | Cap on server-requested retry delay (`retry-after-*`); fail fast beyond it; `0` disables the cap |
| `httpIdleTimeoutMs` | `300000` (5 min; choices 30s/1m/2m/5m/disabled) | Undici `headersTimeout` + `bodyTimeout` on the global dispatcher; idle gap between consecutive body chunks while streaming |
| `websocketConnectTimeoutMs` | `15000` | WebSocket connect/open timeout — **Codex/OpenAI WS only, does not apply to OpenRouter** |
| `transport` | `"auto"` | `sse` / `websocket` / `websocket-cached` / `auto` — **only used by providers with multiple transports (OpenAI Codex path); OpenRouter is OpenAI Chat Completions → SSE only** |

Only `transport` and `httpIdleTimeoutMs` appear in the interactive `/settings` TUI (settings-selector.js). `retry.*` is JSON-only; edit settings.json directly.

## How the timeout knobs actually behave in code

- `core/sdk.js` (~L186-200, `createAgentSession` streamFn): `effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs`; then `timeoutMs = options?.timeoutMs ?? retry.provider.timeoutMs ?? effectiveTimeoutMs`. So the SDK timeout DEFAULTS to the HTTP idle timeout; set `retry.provider.timeoutMs` to override independently.
- `pi-ai/dist/api/openai-completions.js` (OpenRouter's API, `openrouterProvider()` uses `openAICompletionsApi()`): builds `requestOptions = { signal, timeout: timeoutMs, maxRetries: 0 }` and calls `client.chat.completions.create(params, requestOptions)`, wrapped in `retryProviderRequest(...)`.
- OpenAI SDK semantics (verified in `openai/src/client.ts`): `DEFAULT_TIMEOUT = 600000`. In `fetchWithTimeout`: `const timeout = setTimeout(abort, ms)` then `finally { clearTimeout(timeout) }` — the timer is cleared as soon as `fetch` resolves, i.e. when response HEADERS arrive. **The SDK timeout is therefore a time-to-headers / TTFT-ish bound, NOT a total-stream deadline.** Once streaming starts the SDK timer is gone.
- Mid-stream protection is the undici dispatcher: `core/http-dispatcher.js` `configureHttpDispatcher(httpIdleTimeoutMs)` sets `bodyTimeout` and `headersTimeout` to the same value on a global `EnvHttpProxyAgent`. Per undici docs: `bodyTimeout` = time between CONSECUTIVE body chunks (idle gap); `headersTimeout` = time waiting for headers after request sent; `0` disables. Cannot be set per-request through pi, only as this global.

Practical reading: the effective TTFT bound for a pi→OpenRouter request is `min(retry.provider.timeoutMs ?? httpIdleTimeoutMs, httpIdleTimeoutMs as undici headersTimeout)`; the mid-stream bound is `httpIdleTimeoutMs` as undici bodyTimeout. Slow-reasoning OpenRouter models that pause >5 min between chunks will trip bodyTimeout → request fails with an error → agent-level retry kicks in.

## Cancellation / abort mechanisms (user-initiated vs system)

User-initiated:
1. **Escape key** — force abort of in-flight LLM response; queued messages restored to editor.
2. **pi-client dispose** (`pi-client/dist/client.js`) — session/client teardown: `PiClient.dispose()` rejects all pending requests with `PiClientDisposedError`, disconnects the connection; `connection.disconnect(reason)` rejects pending + transports close.

System / automatic:
3. **Per-run AbortController** in `pi-agent-core/dist/agent.js` `runWithLifecycle`; `agent.abort()` aborts the active run. The abort signal is threaded through `agent-loop.js` `streamAssistantResponse(config, signal, ...)` into `streamFunction(model, ctx, { signal })` → provider call.
4. **Aborts are NEVER retried**: `pi-ai/dist/utils/retry.js` `retryAssistantCall` — `stopReason === "aborted"` returns immediately even if a retry was already scheduled; abort during backoff sleep normalizes to an aborted AssistantMessage. So Escape is terminal by design.
5. **Agent-level retry** (`retryAssistantCall` + `core/agent-session.js` `_willRetryAfterAgentEnd`): on `stopReason === "error"` with retryable message, sleep `baseDelayMs * 2^(n-1)`, retry up to `maxRetries`. Telemetry events `retry_scheduled` / `retry_start` / `retry_end` exist in `pi-agent-core/dist/harness/telemetry.js`.
6. **Compaction & branch summary** retries (`pi-agent-core/dist/harness/compaction/`) via `completeSimpleWithRetries` / `retryAssistantCall` too, using the same `settings.retry` budget.
7. **`modelRefreshTimeoutMs`** — bounds model-catalog network refresh (`core/model-runtime.js` refresh path L92-93, AbortController + setTimeout). Not a user settings.json knob; it's an SDK option (`ModelRuntime.create({ allowModelNetwork: true, modelRefreshTimeoutMs: 15000 })`).
8. **Bash tool** honors the abort signal (`core/bash-executor.js` checks `options?.signal` aborted) — mid-command Escape kills the child process.

## Retry classification (what is / isn't retried)

`pi-ai/dist/utils/retry.js` `isRetryableAssistantError(errorMessage)` — regex against the error message:
- **Retryable** (subset most relevant to OpenRouter): `overloaded`, `rate.?limit`, `too many requests`, `429`, `500/502/503/504/524`, `service.?unavailable`, `server.?error`, `internal.?error`, `provider.?returned.?error` (OpenRouter #2264), `exceeded request buffer limit while retrying upstream`, `network.?error`, `connection.?error/refused/lost`, `other side closed`, `fetch failed`, `getaddrinfo`, `ENOTFOUND`, `EAI_AGAIN`, `upstream.?connect`, `reset before headers`, `socket hang up`, `socket connection was closed`, `timed? out`/`timeout`, `terminated`, `websocket.?closed/error`", `stream ended before message_stop`, `stream ended without`, `http2 request did not get a response`, `retry delay`, `you can retry your request`, `try your request again`, `please retry your request`, `ResourceExhausted`.
- **NOT retryable** (quota/billing): `GoUsageLimitError`, `FreeUsageLimitError`, `Monthly usage limit reached`, `available balance`, `insufficient_quota`, `out of budget`, `quota exceeded`, `billing`.

Provider-level retry (`pi-ai/dist/utils/provider-retry.js`, used because the SDK is called with `maxRetries: 0` to avoid double-retry):
- Honors **`x-should-retry`** response header (true/false, OpenRouter supports this), else retryable statuses 408 / 409 / 429 / 5xx.
- Backoff: `retry-after-ms` header, else `retry-after` header, else exponential `0.5 * 2^n` capped at 8s with up to 25% jitter.
- Server-requested delay above `retry.provider.maxRetryDelayMs` (default 60s) fails immediately with an informative error (`RetryDelayExceededError`); set `0` to remove the cap. Abortable sleep integrates with the request signal.

## Transport matrix

- `transport` / `websocketConnectTimeoutMs` / `websocket-cached` are consumed only by `pi-ai/dist/api/openai-codex-responses.js` (Codex + WS caching, `useCachedContext` when `transport === "websocket-cached" || "auto"`, idle timeout on WS parse).
- **OpenRouter** (`pi-ai/dist/providers/openrouter.js`) = `openAICompletionsApi()` → OpenAI Chat Completions over SSE. Setting `transport: "websocket"` has no effect for OpenRouter. `stream_options.include_usage` is sent, and OpenRouter's `reasoning` field / `reasoning_details` deltas are parsed into thinking blocks.
- Retry header support (`x-should-retry`, `retry-after`, `retry-after-ms`) is the one OpenRouter-specific lever that pi already honors automatically.

## Recommended config for a robust pi/OpenRouter experience

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  },
  "httpIdleTimeoutMs": 300000,
  "websocketConnectTimeoutMs": 15000
}
```
Rationale: keep agent-level retry on (it is the main recovery from OpenRouter transient errors like "provider returned error" / connection drops — those are in the retryable pattern list). Leave `retry.provider.maxRetries: 0` as documented (avoid hiding quota errors; `x-should-retry` + 429/5xx are still handled at the provider wrapper only if maxRetries>0 — note: agent-level retry still catches them since the same message text is retryable at that level). Raise `retry.provider.timeoutMs` only if you regularly exceed the default for time-to-first-headers (many OpenRouter reasoning models are slow to emit the first byte). Raise `httpIdleTimeoutMs` (up to disabled) if you hit mid-stream "idle timeout" failures with long-thinking/slow-streaming models.

Caveat checked in code: with `retry.provider.maxRetries: 0` the provider-level wrapper does not retry, but the agent-level `retryAssistantCall` still retries the whole failed turn because `isRetryableAssistantError` matches the same transient error text (429, timeout, connection lost, etc.). Aborts never retry at either level.

## Key source files to revisit

- `dist/utils/abort.js` — `raceWithAbortSignal`, `operationSignal`.
- `dist/core/settings-manager.js` — `getRetrySettings`, `getProviderRetrySettings`, `getHttpIdleTimeoutMs`, `getWebSocketConnectTimeoutMs`, `getTransport` (~L541-620).
- `dist/core/http-dispatcher.js` — `configureHttpDispatcher`, `DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000`, `HTTP_IDLE_TIMEOUT_CHOICES`.
- `dist/core/sdk.js` — streamFn wiring of timeoutMs/maxRetries/maxRetryDelayMs into `modelRuntime.streamSimple` (~L180-240).
- `dist/core/agent-session.js` — `_willRetryAfterAgentEnd`, `_isRetryableError`, summarization/compaction retries.
- `dist/core/model-runtime.js` — `streamSimple`, `modelRefreshTimeoutMs` (refresh path).
- `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js` — `streamAssistantResponse` (signal → streamFunction).
- `node_modules/@earendil-works/pi-agent-core/dist/agent.js` — per-run AbortController; `agent.abort()`.
- `node_modules/@earendil-works/pi-agent-core/dist/harness/compaction/compaction.js` — `completeSimpleWithRetries`, `generateSummaryWithUsage`.
- `node_modules/@earendil-works/pi-ai/dist/utils/retry.js` — `retryAssistantCall`, `isRetryableAssistantError` (full pattern lists).
- `node_modules/@earendil-works/pi-ai/dist/utils/provider-retry.js` — `retryProviderRequest`, `isRetryableProviderError`, `getRetryDelayMs`, `abortableSleep`.
- `node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js` — OpenRouter streaming impl (requestOptions, timeout, maxRetries: 0, reasoning_details).
- `node_modules/@earendil-works/pi-ai/dist/providers/openrouter.js` — provider def (baseUrl `https://openrouter.ai/api/v1`, env key `OPENROUTER_API_KEY`).
- `node_modules/@earendil-works/pi-client/dist/client.js`, `connection.js` — dispose/disconnect reject pending requests; `transport.js` is an empty stub in this version (transports moved into the main package).
- Docs: `docs/settings.md` (Retry table L143-148, Message Delivery L175-177), `docs/sdk.md` L370-390 (`modelRefreshTimeoutMs`), README (`/settings`, keybindings: Escape = abort).