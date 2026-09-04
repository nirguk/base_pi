import { afterEach, describe, expect, it, vi } from "vitest";
import {
  averageEndpointThroughput,
  clearModelBenchmarkTPS,
  setModelBenchmarkTPS,
} from "../throughput";
import {
  setupProvider as openrouterProviderStatus,
  clearTPSObservations,
  formatProviderTPSStatus,
  getProviderRollingTPS,
  recordProviderTPS,
} from "../provider";

afterEach(() => {
  vi.restoreAllMocks();
  clearTPSObservations();
  clearModelBenchmarkTPS();
});

describe("provider-averaged OpenRouter throughput", () => {
  it("averages each metric across endpoint providers", () => {
    expect(averageEndpointThroughput([
      { throughput_last_30m: { p90: 20, p50: 10, mean: 14 } },
      { throughput_last_30m: { p90: 40, p50: 30, mean: 34 } },
      { throughput_last_30m: { p90: 60 } },
    ])).toEqual({ p90: 40, p50: 20, mean: 24 });
  });

  it("ignores endpoints without a metric", () => {
    expect(averageEndpointThroughput([
      { throughput_last_30m: { p90: 20 } },
      { throughput_last_30m: {} },
      {},
    ])).toEqual({ p90: 20, p50: null, mean: null });
  });
});

describe("rolling provider TPS", () => {
  it("uses a duration-weighted average and expires samples after 1 hour", () => {
    const now = 1_000_000;
    recordProviderTPS("acme/model", "Provider A", 100, 10_000, now - 1_000);
    recordProviderTPS("acme/model", "Provider A", 100, 20_000, now);

    expect(getProviderRollingTPS("acme/model", "Provider A", now)).toBeCloseTo(6.667, 2);
    expect(getProviderRollingTPS("acme/model", "Provider A", now + 60 * 60 * 1000 + 1)).toBeNull();
  });

  it("shows observed and model-average TPS with a performance arrow", () => {
    const now = Date.now();
    setModelBenchmarkTPS("acme/model", 20);
    recordProviderTPS("acme/model", "Provider A", 100, 10_000, now);

    // The exact arrow is based on the rolling provider result being below the
    // OpenRouter model-slug benchmark.
    expect(formatProviderTPSStatus("Provider A", "acme/model")).toContain(
      "Provider:Provider A · TPS30m:10.0 / OR30m:20.0 ↓ ;",
    );
  });

  it("updates the footer after provider lookup and response completion", async () => {
    let clock = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ data: { provider_name: "Provider A" } }),
    }));

    setModelBenchmarkTPS("acme/model", 20);
    const handlers = new Map<string, any>();
    const pi = {
      on(name: string, handler: any) { handlers.set(name, handler); },
      registerCommand() {},
    };
    openrouterProviderStatus(pi as any);
    const setStatus = vi.fn();
    const ctx = {
      model: { provider: "openrouter", id: "acme/model" },
      modelRegistry: { getApiKeyForProvider: vi.fn().mockResolvedValue("key") },
      ui: { setStatus, notify: vi.fn() },
    };

    handlers.get("after_provider_response")({ headers: { "x-generation-id": "gen-tps" } }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    handlers.get("message_start")({ message: { role: "assistant" } }, ctx);
    clock += 10_000;
    handlers.get("message_end")({
      message: { role: "assistant", usage: { output: 100 } },
    }, ctx);
    handlers.get("turn_end")({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setStatus).toHaveBeenCalledWith(
      "openrouter-provider",
      "Provider:Provider A · TPS30m:10.0 / OR30m:20.0 ↓ ;",
    );
  });
});
