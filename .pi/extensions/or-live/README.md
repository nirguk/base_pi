# or-live

Unified OpenRouter extension combining:

- live upstream-provider identification and provider TPS tracking
- OpenRouter model catalog metrics, ability-per-price calculations, and benchmark TPS
- `/or-provider` and `/or-metrics` commands
- the `or_metrics_query` tool

The implementation is intentionally split into three focused TypeScript modules:

- `index.ts` — composition entry point
- `provider.ts` — response observation, generation lookup, provider status, and provider TPS
- `metrics.ts` — model catalog analysis, snapshots, daily benchmark cache, and metrics display
- `throughput.ts` — shared benchmark/provider throughput state

The existing command names and `~/.pi/or-metrics` storage paths are retained for
compatibility during the migration. The project settings enable `or-live` and
disable the two legacy extension entries; the legacy source remains temporarily
for rollback and comparison.

Run tests from this directory:

```sh
npm test
```

## Retirement checklist for the legacy implementations

1. Use `or-live` in normal sessions and monitor provider/metrics behavior.
2. Resolve any compatibility issues found during the transition.
3. Remove the legacy settings entries and source directories once rollback is no longer needed.
4. Keep the existing snapshot/cache paths unless a deliberate storage migration is planned.
