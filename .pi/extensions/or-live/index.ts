/**
 * or-live — combined OpenRouter live provider and model-metrics extension.
 *
 * This is the new unified entry point. The implementation remains split into
 * two focused modules so provider observation and catalog analysis are easy to
 * understand and test independently, while sharing one throughput module.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupMetrics } from "./metrics";
import { setupProvider } from "./provider";

export { setupMetrics } from "./metrics";
export { setupProvider } from "./provider";
export * from "./throughput";

export default function orLive(pi: ExtensionAPI): void {
  setupMetrics(pi);
  setupProvider(pi);
}
