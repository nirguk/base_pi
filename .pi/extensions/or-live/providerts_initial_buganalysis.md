# Bug Analysis — provider.ts

## Fixed

| # | Issue | Fix |
|---|-------|-----|
| **#4** | `findMeasurementForMessage` returned wrong match when `slug` was falsy — matched across models instead of returning `undefined` | Added early `if (!slug) return undefined` guard; removed the `slug &&` short-circuit that allowed cross-model matching |
| **#50** | `unsubscribeBenchmarkUpdates` and `currentProviderStatus` were local to `setupProvider`, leaked on re-entry causing stale callbacks and wrong footer state | Moved both to module level; `setupProvider` now resets `currentProviderStatus = null` on re-entry; `session_shutdown` already resets it |

## Still present — medium severity

| # | Issue |
|---|-------|
| #24 | `generationCache` entries only pruned on read (TTL), no proactive cleanup |
| #36 | `getGenerationUrl` doesn't validate the generation ID |
| #37/#38 | `fetchGenerationRecord` doesn't verify response is JSON before `res.json()` |
| #41 | `observedProviders` uses `Date.now()` (wall-clock) instead of monotonic time |
| #42 | `recordProviderTPS` accepts any slug without verifying it matches the current model |
| #48 | `registerFlag` try/catch swallows all errors, not just "method missing" |
