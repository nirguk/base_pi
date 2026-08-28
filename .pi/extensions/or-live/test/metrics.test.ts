import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeModels,
  findNotable,
  findScoped,
  parsePricing,
  renderTPS,
  renderTop,
} from "../metrics";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenRouter model analysis", () => {
  it("converts token prices to dollars per million and computes blended/cached IPP", () => {
    const [entry] = analyzeModels([{
      id: "acme/model",
      name: "Acme Model",
      pricing: {
        prompt: "0.001",
        completion: "0.002",
        input_cache_read: "0.0002",
      },
      benchmarks: {
        artificial_analysis: {
          intelligence_index: 70,
          coding_index: 80,
          agentic_index: 60,
        },
      },
    }]);

    expect(entry.pricing).toEqual({
      input: 1000,
      output: 2000,
      cacheRead: 200,
      blended: 1200,
      blendedCached: 752,
    });
    expect(entry.indices).toEqual({ intelligence: 70, coding: 80, agentic: 60 });
    expect(entry.ipp.blndcod).toBeCloseTo(80 / 1200);
    expect(entry.ipp.blndagnt).toBeCloseTo(60 / 1200);
    expect(entry.ipp.blnd).toBeCloseTo(70 / 1200);
    expect(entry.ipp.cach).toBeCloseTo(70 / 752);
  });

  it("rejects unusable pricing and preserves missing benchmark values", () => {
    expect(parsePricing(undefined)).toBeNull();
    expect(parsePricing({ prompt: "not-a-number", completion: "0.001" })).toBeNull();

    const [entry] = analyzeModels([{
      id: "acme/no-benchmarks",
      pricing: { prompt: "0", completion: "0" },
      benchmarks: {},
    }]);
    expect(entry.indices).toEqual({ intelligence: null, coding: null, agentic: null });
    expect(entry.ipp).toEqual({
      blndcod: null, blndagnt: null, cachcod: null, cachagt: null, blnd: null, cach: null,
    });
  });

  it("attaches supplied throughput by model slug", () => {
    const [entry] = analyzeModels(
      [{ id: "acme/model", pricing: { prompt: "0.001", completion: "0.001" } }],
      { "acme/model": { p90: 42, p50: 30, mean: 35 } },
    );
    expect(entry.throughput_p90).toBe(42);
    expect(entry.throughput_p50).toBe(30);
    expect(entry.throughput_mean).toBe(35);
  });
});

describe("metrics selection and presentation", () => {
  const entries = analyzeModels([
    { id: "acme/slow", name: "Slow", pricing: { prompt: "0.01", completion: "0.01" }, benchmarks: { artificial_analysis: { coding_index: 80, agentic_index: 80 } } },
    { id: "acme/fast", name: "Fast", pricing: { prompt: "0.001", completion: "0.001" }, benchmarks: { artificial_analysis: { coding_index: 60, agentic_index: 60 } } },
  ]);

  it("keeps scoped-model order and reports missing models explicitly", () => {
    expect(findScoped(entries, [
      { slug: "acme/slow", label: "Slow label" },
      { slug: "missing/model", label: "Missing label" },
    ])).toMatchObject([
      { slug: "acme/slow", label: "Slow label", found: true, entry: { slug: "acme/slow" } },
      { slug: "missing/model", label: "Missing label", found: false, entry: null },
    ]);
  });

  it("ranks notable models by the requested raw or value metric", () => {
    const notable = findNotable(entries);
    expect(notable[0].category).toContain("Agentic Ability");
    expect(notable[0].models[0]).toEqual({ name: "Slow", v: 80 });
    expect(notable[2].category).toContain("Blended IPP");
    expect(notable[2].models[0].name).toBe("Fast");
  });

  it("renders rankings in descending throughput/IPP order with stable headers", () => {
    const withTPS = entries.map((entry) => ({
      ...entry,
      throughput_p90: entry.slug.endsWith("fast") ? 90 : 10,
    }));
    const tps = renderTPS(withTPS);
    expect(tps.indexOf("Fast")).toBeLessThan(tps.indexOf("Slow"));
    expect(tps).toContain("p90 TPS(30m)");

    const top = renderTop(entries);
    expect(top.indexOf("Fast")).toBeLessThan(top.indexOf("Slow"));
    expect(top).toContain("BlndAv");
  });
});
