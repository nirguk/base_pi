# Bug Analysis — provider.ts

## Still present — high severity

| # | Issue | Recommendation |
|---|-------|----------------|
| **#4** | `findMeasurementForMessage` returns wrong match when `slug` is falsy — returns first incomplete measurement for **any** model instead of `undefined` | Return `undefined` when `slug` is missing; don't match across models |
| **#50** | `unsubscribeBenchmarkUpdates` is a local variable in `setupProvider` — leaked on re-entry, causing stale callbacks and wrong `currentProviderStatus` | Store the unsubscribe function at module level and call it before assigning a new one |

## Still present — medium severity

| # | Issue |
|---|-------|
| #24 | `generationCache` entries only pruned on read (TTL), no proactive cleanup |
| #36 | `getGenerationUrl` doesn't validate the generation ID |
| #37/#38 | `fetchGenerationRecord` doesn't verify response is JSON before `res.json()` |
| #41 | `observedProviders` uses `Date.now()` (wall-clock) instead of monotonic time |
| #42 | `recordProviderTPS` accepts any slug without verifying it matches the current model |
| #48 | `registerFlag` try/catch swallows all errors, not just "method missing" |
