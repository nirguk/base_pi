/** Shared OpenRouter throughput helpers used by the metrics and provider-status extensions. */

export type ThroughputStats = {
  p90: number | null;
  p50: number | null;
  mean: number | null;
};

/**
 * Average the provider endpoint measurements for one model slug.
 * OpenRouter exposes one endpoint entry per upstream provider.  A model-level
 * benchmark is therefore the arithmetic mean of the available provider p90s,
 * rather than whichever endpoint happens to be first in the response.
 */
export function averageEndpointThroughput(endpoints: any[]): ThroughputStats | null {
  if (!Array.isArray(endpoints) || endpoints.length === 0) return null;

  const average = (field: keyof ThroughputStats): number | null => {
    const values = endpoints
      .map((endpoint) => endpoint?.throughput_last_30m?.[field])
      .map((value) => {
        if (typeof value === "number") return value;
        if (typeof value === "string" && value.trim() !== "") return Number(value);
        return NaN;
      })
      .filter((value) => Number.isFinite(value) && value >= 0);
    return values.length > 0
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
  };

  const stats = { p90: average("p90"), p50: average("p50"), mean: average("mean") };
  return stats.p90 == null && stats.p50 == null && stats.mean == null ? null : stats;
}

// This is intentionally process-global so the two independently loaded
// extensions can share the metrics fetched by or-metrics without another HTTP
// request.  If no benchmark has been fetched yet, the footer renders the
// model-average side as unavailable until or-metrics supplies it.
const modelBenchmarkTPS = new Map<string, number>();
const benchmarkListeners = new Set<(slug: string, value: number | null) => void>();

export function subscribeModelBenchmarkTPS(
  listener: (slug: string, value: number | null) => void,
): () => void {
  benchmarkListeners.add(listener);
  return () => benchmarkListeners.delete(listener);
}

export function getModelBenchmarkTPS(slug: string): number | null {
  const value = modelBenchmarkTPS.get(slug);
  return value != null && Number.isFinite(value) ? value : null;
}

export function setModelBenchmarkTPS(slug: string, value: number | null): void {
  const previous = getModelBenchmarkTPS(slug);
  if (value == null || !Number.isFinite(value) || value < 0) {
    modelBenchmarkTPS.delete(slug);
  } else {
    modelBenchmarkTPS.set(slug, value);
  }
  const next = getModelBenchmarkTPS(slug);
  if (previous !== next) {
    for (const listener of benchmarkListeners) {
      try { listener(slug, next); } catch { /* status updates are best-effort */ }
    }
  }
}

export function setModelBenchmarkTPSMap(data: Record<string, number | null>): void {
  for (const [slug, value] of Object.entries(data)) setModelBenchmarkTPS(slug, value);
}

export function clearModelBenchmarkTPS(): void {
  modelBenchmarkTPS.clear();
}

export function formatTPS(value: number | null, decimals = 1): string {
  return value == null ? "—" : value.toFixed(decimals);
}
