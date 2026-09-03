# Session Handoff — OpenRouter mid-turn failures & resilience (2026-09-02)

**Goal (restart here tomorrow):** Make pi ↔ OpenRouter resilient against mid-turn failures (`TypeError: terminated`), using the real captured data, without killing reasoning quality or fallbacks. Next actions are at the bottom; everything below is verified against disk artifacts, package sources, and OpenRouter docs.

---

## 1. What we built (all working, all reproducible)

| Artifact | Path | Notes |
|---|---|---|
| Debug artifacts | `/workspaces/base_pi/pi_perf/pi-llm-debugging/` | 1.1 GB raw JSON, 62 sessions, ~10,800 files, written by the `pi-llm-debugging` extension on every LLM call |
| SQLite DB (analysis) | `pi_perf/llm-debug.sqlite` | 17.9 MB, 10,882 rows, built-in `node:sqlite` (no deps) |
| Loader | `pi_perf/scripts/load_llm_debug_db.mjs` | `rm -f pi_perf/llm-debug.sqlite* && node pi_perf/scripts/load_llm_debug_db.mjs` (~58 s) |
| Query script | `pi_perf/scripts/query_llm_debug.cjs` | `node pi_perf/scripts/query_llm_debug.cjs` (status/error-class summaries) |

**DB schema:** `artifacts(session_id, seq, kind ['req'|'res'|'error'|'meta'], file, mtime, url, method, ok, status, status_text, model, content_type, headers, body_chars, parsed_chars, sample[first 300], tail[last 250 of res], has_done, has_message_stop, finish_reason, n_messages, n_tools, err_name, err_message, err_cause, err_extra)`.

Design note: we deliberately store **lengths/samples/flags, not full bodies** (req bodies = 99% of the 1.1 GB and useless; res bodies only needed for completeness flags + first/last chars). Loader refuses to `JSON.parse` req files (regex/scans only).

---

## 2. Verified findings (trust these; don't re-derive)

### 2.1 Failure mix (2,243 error artifacts)
- **1,732× 404** `Generation gen-… not found` — **NOISE**: these are `or-live`'s post-stream `GET /api/v1/generation?id=` lookups (`/workspaces/base_pi/.pi/extensions/or-live/provider.ts`), racing OpenRouter's generation-record expiry. Not pi, not a real turn failure.
- **335× `TypeError: terminated`** (status 200) — **THE BANE.** Cause chain verified in stack: `TLSSocket.onHttpSocketClose -> errorRequest -> Fetch.terminate` — **the server closes the TCP socket mid-SSE**. A peer-initiated close, not a pi timeout (pi's `httpIdleTimeoutMs`=300 s, SDK timeout=600 s, both far from 30 s).
- **64× 429** upstream rate-limit (OpenRouter `"Provider returned error"`): ling-3.0-flash ×42, deepseek ×13, solar-pro4 ×3, laguna ×3.
- **30× `fetch failed`** (connect/DNS), **~35× AbortError** (user/system aborts).
- Real failure rate ≈ **16%** of LLM calls; terminated is ~75% of real failures.

### 2.2 The ~30 s wall (the big finding)
- Failure durations **quantize at 22/26/28/30 s; ALL ≤ 31 s. Successes max at 30 s (29 s true max). Nothing alive at 32 s+.**
- Verified with **two independent clocks**: (a) `x-generation-id` embedded server-start unix time, (b) HTTP `date` header — both agree (p50 26 s, failures 28–31 s; successes ≤ 30 s).
- Uniform across **4 different days and all 6 models** (deepseek/ling/poolside/solar/glm/luna) → a universal ~30 s generation budget on the OpenRouter/upstream pipeline. OpenRouter's own routing defaults use a **30 s** outage-health window — suspicious but not explicitly documented as a deadline.
- **Request→headers is fast:** median 1.4 s, p90 3 s. So the shape is: 200 + SSE headers quickly, then **~28 s of silence, then the server closes the socket.**

### 2.3 Captured-body caveat (important!)
`pi-llm-debugging` captures the body via `response.clone().text()` which **throws when the stream terminates** — the catch then writes headers+error with `body: ""` (source: `/workspaces/base_pi/.pi/git/github.com/nirguk/pi-llm-debugging/extensions/pi-llm-debugging.ts`, ~L246). → **Empty error bodies do NOT mean zero bytes arrived.** We cannot currently tell "died before first token" from "died mid-thinking". Fixing this = fork the extension to tee partial bytes (next-step candidate).

### 2.4 Where thinking tokens appear
- Reasoning models (deepseek/glm/luna…) stream **`delta.reasoning` first**, `content` empty, then `content` after thinking completes:
  ```json
  data: {"delta":{"content":"","role":"assistant","reasoning":"My","reasoning_details":{...}}}
  data: {"delta":{"content":"Let", ...}}   ← visible text only after reasoning
  ```
- Verified real success: **2,568 reasoning deltas over 26 s** before the first non-empty `content` char (seq 74 of session 01a04da1). `: OPENROUTER PROCESSING` comments are keepalives during thinking.
- **Your "cut while thinking" hypothesis is the dominant failure-mode shape**: for thinking models the first 20–30 s of a generation IS silent thinking; a slow/queued upstream exhausts the ~30 s budget in that silent window.

### 2.5 OpenRouter latency semantics (checked against their docs)
- Their latency metric = **TTFT = "Network transit + provider queue wait time + prompt prefill"** — it is **time to FIRST token (the first REASONING token for thinking models). NOT post-thinking time.** Thinking duration lives in the TPS/decode phase and is excluded.
- `preferred_max_latency {p90}` is a **TTFT bound** and is **explicitly their documented Recipe #1 for this exact signature**: peak-hours queue congestion on open-weight hosts → TTFT spikes → carve with `preferred_max_latency` (rolling 5-min percentiles, soft reordering, zero-404-risk: still executes on best available host if all are saturated).

### 2.6 Fallbacks / current routing — verified
- OpenRouter default `allow_fallbacks: true`; pi sends **NO `provider` block** (captured payload keys: `model, messages, reasoning, session_id, store, stream, stream_options, tools, max_completion_tokens`). Defaults = price-weighted load balancing; hosts with outages in the last 30 s deprioritized.
- **No latency/throughput criterion is active** (grep of `~/.pi` + settings = nothing). If the user set anything on the OpenRouter dashboard that's outside our visibility; a request-body `provider` block overrides it anyway.

### 2.7 Existing knobs & retry reality
- Agent-level retry (defaults `maxRetries: 3`, `baseDelayMs: 2000` → 2/4/8 s) **recovers ~56% of terminated failures completely within a few retries**; only 3/335 dead-end. It works; the window is just too tight for 429 resets (10–60 s typical).
- `httpIdleTimeoutMs` raising does **NOT** fix `terminated` (peer close). (Notes file previously speculated idle timeouts; correction pending.)
- **User's stated preference:** favor **slower `baseDelayMs`** over **more `maxRetries`** (more retries = more failed messages under sustained choke). Suggested: `baseDelayMs: 5000` (5/10/20 s), keep `maxRetries: 3`.

### 2.8 The sanctioned injection point (for the fix)
`/usr/local/share/nvm/versions/node/v26.7.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js` L208: `onPayload` forwards to the **`before_provider_request` extension hook** — the same hook pi-llm-debugging uses for capture. An extension can mutate the request body before send: add OpenRouter `provider` block (`sort`, `preferred_max_latency`, `allow_fallbacks`). This is the supported way to inject OpenRouter-specific params pi otherwise never sends.

---

## 3. Proposed fixes (NOT yet applied — decide tomorrow)

1. **Extension** (`/workspaces/base_pi/.pi/extensions/`) registering `before_provider_request` that adds:
   ```js
   payload.provider = {
     sort: "throughput",
     preferred_max_latency: { p50: 8, p90: 20 },   // TTFT thresholds, attack the queue-congestion class
     allow_fallbacks: true                          // explicit (already default)
   };
   ```
   Throughput-first + latency carve keeps the fastest hosts that also stream quickly. Verify by re-capturing a req payload and seeing `provider` appear (pi-llm-debugging writes req bodies — quick sanity loop).
2. **Retry change** in `/workspaces/base_pi/.pi/settings.json`:
   ```json
   { "retry": { "baseDelayMs": 5000 } }  // keep maxRetries 3; merged over defaults
   ```
3. **Optional: reasoning effort** — pi currently sends `reasoning: {effort: "high"}` on deepseek (verified in payload). Dropping per-model effort shortens the silent thinking window directly. **User values reasoning quality** → treat as separate, deliberate decision; the latency-routing fix is the primary lever.
4. **Better capture (diagnostic upgrade):** fork `pi-llm-debugging` to stream-partial body to disk (or flush `res` on abort) so future failures reveal whether thinking tokens streamed before the cut — settles pre-first-token vs mid-thinking definitively. Repo already cloned at `/workspaces/base_pi/.pi/git/github.com/nirguk/pi-llm-debugging/`.
5. **Update `pi_perf/notes_on_pi_perf.md`** with the verified corrections: (a) mid-stream `terminated` = peer `SocketError: other side closed`, NOT idle timeout — `httpIdleTimeoutMs` doesn't fix it; (b) ~30 s OpenRouter generation wall (two-clock verified); (c) `before_provider_request`/`onPayload` injection point; (d) reasoning deltas parsed from `delta.reasoning`.

---

## 4. Re-run / verification commands (tomorrow)

```bash
# Reload DB after more sessions accumulate
cd /workspaces/base_pi && rm -f pi_perf/llm-debug.sqlite* && node pi_perf/scripts/load_llm_debug_db.mjs

# Summary queries
node pi_perf/scripts/query_llm_debug.cjs

# Verify the 30 s wall on fresh data (error.mtime - HTTP 'date' header)
#   -> failures should cluster 28-31s, successes <=30s
# Verify extension injection (after fix #1): capture a req, jq '.provider' a fresh -req.json
# Verify reasoning-effort: jq '.reasoning' a fresh -req.json
```

Useful one-liners:
```bash
jq '.model, .reasoning, (.provider // "NO PROVIDER")' pi_perf/pi-llm-debugging/<latest session>/*-req.json
```

---

## 5. Open questions for tomorrow
- Does OpenRouter explicitly enforce a ~30 s TTFT deadline? (Their default routing health window is 30 s; no doc statement found. If failures persist after threshold routing, consider a support ticket.) 
- Which failure class dominates after the latency fix — pre-first-token (fixed by routing) vs mid-thinking (needs reasoning-effort or accept+retry)?
- Extend to subagent models: worker/researcher/scout are ling-3.0-flash (the most-rate-limited model); consider fallback models in `subagents.agentOverrides`.