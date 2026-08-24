# OpenRouter Metrics — Ability-Per-Price Analysis

Uses OpenRouter's models API (Artificial Analysis indices embedded inline)
to compute ability-per-price for every scoped/available model.

## Data Source

OpenRouter embeds **Artificial Analysis indices** directly in every model's
`benchmarks.artificial_analysis` field (162+ models as of Aug 2026):

| Index | What it measures | Scale |
|-------|-----------------|-------|
| `intelligence_index` | General reasoning | 0–100 |
| `coding_index` | Coding / software engineering | 0–100 |
| `agentic_index` | Agentic / tool-use ability | 0–100 |

Pricing (`prompt`, `completion`, `input_cache_read`) is also inline.

## Ability-Per-Price (IPP) Metrics

| IPP Metric | Formula | What it means |
|-----------|---------|---------------|
| **Coding-IPP** | `coding_index ÷ blended_80/20 $/M` | Coding ability per dollar |
| **Agentic-IPP** | `agentic_index ÷ blended_80/20 $/M` | Agentic ability per dollar |
| **Blended-IPP** | `(coding×0.5 + agentic×0.5) ÷ blended` | Combined ability per dollar (primary ranking) |
| **Cached-IPP** | Same but input = `cache_rate×cache_read + (1−rate)×input` | Realistic with caching (70% default, tune via `OR_CACHE_RATE`) |

Blended cost = `0.8 × input_price + 0.2 × output_price` per million tokens.

## CLI (works everywhere)

```bash
# Full display (scoped + notable + top 30 + bottom 10)
node .pi/or-metrics/or-metrics.js

# Scoped models only
node .pi/or-metrics/or-metrics.js --scoped

# Notable / analytically interesting
node .pi/or-metrics/or-metrics.js --notable

# JSON output (programmatic use)
node .pi/or-metrics/or-metrics.js --json

# Daily snapshot + compare
node .pi/or-metrics/or-metrics.js --snapshot --diff

# Tune cache assumption (default 70%)
OR_CACHE_RATE=0.8 node .pi/or-metrics/or-metrics.js --notable
```

Requires `OPENROUTER_API_KEY` in your environment.

## Pi Extension

Installed at `~/.pi/agent/extensions/or-metrics.ts` (symlinked from `.pi/extensions/or-metrics.ts`).

**Auto-loaded on every pi session.** On session start it:
1. Fetches all models with AA indices from OpenRouter
2. Saves a snapshot to `~/.pi/or-metrics/snapshots/` (keeps only 2 files: current + previous)
3. Compares against the prior snapshot and **notifies you of changes** (new models, score shifts, price changes)

**Commands available in-chat:**

| Command | What it shows |
|---------|---------------|
| `/or-metrics` | Full display: scoped models + notable + top 20 + changes |
| `/or-metrics scoped` | Just our 4 scoped models |
| `/or-metrics notable` | Analytical highlights |
| `/or-metrics top` | Top 20 by blended IPP |
| `/or-metrics changes` | Diff vs prior snapshot |

**Tool available to the LLM:**

`or_metrics_query` — the LLM can call this with:
- `mode: "scoped"` — get our models' data
- `mode: "top 10"` — top 10 by blended IPP
- `mode: "find gpt-5.6"` — search by name
- `mode: "notable"` — analytical highlights

## Scoped Models (as of Aug 24, 2026)

| Model | Intel | Coding | Agentic | Base $/M | CodIPP | AgtIPP | BlnIPP | CchIPP |
|-------|-------|--------|---------|----------|--------|--------|--------|--------|
| Ling 3.0 Flash | 37.8 | 50.6 | 29.3 | $0.029 | 1721 | 997 | 1359 | 1998 |
| Ox Alpha | — | — | — | free | — | — | — | — |
| Mercury 2 | 21.9 | 31.1 | 9.5 | $0.35 | 89 | 27 | 58 | 91 |
| DeepSeek V4 Flash | 42.1 | 56.2 | 33.7 | $0.067 | 836 | 502 | 669 | 1067 |

## Snapshot & Change Detection

Only **2 files** are retained in `~/.pi/or-metrics/snapshots/`:

- `latest.json` — current fetch
- `previous.json` — prior fetch (rotated on each new fetch)

The extension notifies you on session start of:
- 🆕 New models appearing in OpenRouter's catalog
- 📊 Score changes ≥0.5pt in coding/agentic indices
- 💰 Price changes ≥5% in blended cost