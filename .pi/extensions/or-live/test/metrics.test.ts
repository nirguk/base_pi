import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyzeModels,
  findNotable,
  findScoped,
  parsePricing,
  renderNotable,
  renderTPS,
  renderTop,
  renderScoped,
} from "../metrics";

afterEach(() => {
  vi.restoreAllMocks();
});

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

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
      { "acme/model": { p50: 30, mean: 35 } },
    );
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
    expect(notable[0].title).toContain("Agentic Ability");
    expect(notable[0].kind).toBe("sideBySide");
    expect(notable[0].leftModels[0]).toEqual({ slug: "acme/slow", name: "Slow", v: 80, blended_cost: 10000 });
    // Blended IPP is now at index 2 (after Agentic side-by-side, Coding side-by-side)
    const blendedIPP = notable.find((n) => n.kind === "vertical" && n.category.includes("Blended IPP"));
    expect(blendedIPP).toBeDefined();
    expect(blendedIPP!.models[0]).toEqual({ slug: "acme/fast", name: "Fast", v: expect.any(Number), blended_cost: 1000 });
  });

  it("includes <$1 blend-cost capped columns as side-by-side with the raw Agentic and Coding categories", () => {
    const cheap = analyzeModels([
      { id: "acme/cheap-fast", name: "Cheap Fast", pricing: { prompt: "0.0000005", completion: "0.0000005" }, benchmarks: { artificial_analysis: { coding_index: 90, agentic_index: 85 } } },
      { id: "acme/cheap-slow", name: "Cheap Slow", pricing: { prompt: "0.0000005", completion: "0.0000005" }, benchmarks: { artificial_analysis: { coding_index: 70, agentic_index: 90 } } },
      { id: "acme/expensive", name: "Expensive", pricing: { prompt: "0.01", completion: "0.01" }, benchmarks: { artificial_analysis: { coding_index: 95, agentic_index: 95 } } },
    ]);
    const notable = findNotable(cheap);

    // Agentic is a side-by-side pair
    const agenticPair = notable.find((n) => n.kind === "sideBySide" && n.title === "🏆 Agentic Ability");
    expect(agenticPair).toBeDefined();
    expect(agenticPair!.kind).toBe("sideBySide");
    // Cheap Slow has higher agentic (90) than Cheap Fast (85); both are <$1
    expect(agenticPair!.rightModels.map((m) => m.slug)).toEqual(["acme/cheap-slow", "acme/cheap-fast"]);
    // Expensive model is excluded from the <$1 cap
    expect(agenticPair!.rightModels.every((m) => m.blended_cost < 1)).toBe(true);
    // Left (no cap) includes expensive
    expect(agenticPair!.leftModels.map((m) => m.slug)).toContain("acme/expensive");

    // Coding is a side-by-side pair
    const codingPair = notable.find((n) => n.kind === "sideBySide" && n.title === "💻 Coding Ability");
    expect(codingPair).toBeDefined();
    // Cheap Fast has higher coding (90) than Cheap Slow (70); both are <$1
    expect(codingPair!.rightModels.map((m) => m.slug)).toEqual(["acme/cheap-fast", "acme/cheap-slow"]);
    expect(codingPair!.rightModels.every((m) => m.blended_cost < 1)).toBe(true);
  });

  it("accepts a custom cap for the side-by-side capped variations", () => {
    const cheap = analyzeModels([
      { id: "acme/cheap-fast", name: "Cheap Fast", pricing: { prompt: "0.0000005", completion: "0.0000005" }, benchmarks: { artificial_analysis: { coding_index: 90, agentic_index: 85 } } },
      { id: "acme/cheap-slow", name: "Cheap Slow", pricing: { prompt: "0.0000005", completion: "0.0000005" }, benchmarks: { artificial_analysis: { coding_index: 70, agentic_index: 90 } } },
      { id: "acme/expensive", name: "Expensive", pricing: { prompt: "0.01", completion: "0.01" }, benchmarks: { artificial_analysis: { coding_index: 95, agentic_index: 95 } } },
    ]);
    // With cap=100, the expensive model (blended_cost=10000) is excluded from the right column
    const notable100 = findNotable(cheap, 100);
    const agenticPair100 = notable100.find((n) => n.kind === "sideBySide" && n.title === "🏆 Agentic Ability");
    expect(agenticPair100).toBeDefined();
    // Expensive model has blended_cost=10000 which is >= 100, so excluded from right column
    expect(agenticPair100!.rightModels.map((m) => m.slug)).toEqual(["acme/cheap-slow", "acme/cheap-fast"]);
    // But still in the left (no cap) column
    expect(agenticPair100!.leftModels.map((m) => m.slug)).toContain("acme/expensive");
    // With cap=20000, the expensive model is included in the right column
    const notable20000 = findNotable(cheap, 20000);
    const agenticPair20000 = notable20000.find((n) => n.kind === "sideBySide" && n.title === "🏆 Agentic Ability");
    expect(agenticPair20000).toBeDefined();
    expect(agenticPair20000!.rightModels.map((m) => m.slug)).toContain("acme/expensive");
  });

  it("renders rankings in descending throughput/IPP order with stable headers", () => {
    const withTPS = entries.map((entry) => ({
      ...entry,
      throughput_p50: entry.slug.endsWith("fast") ? 90 : 10,
    }));
    const tps = renderTPS(withTPS);
    // Slugs are shown by default (acme/fast before acme/slow)
    expect(tps.indexOf("acme/fast")).toBeLessThan(tps.indexOf("acme/slow"));
    expect(tps).toContain("p50 TPS(30m)");

    const top = renderTop(entries);
    expect(top.indexOf("acme/fast")).toBeLessThan(top.indexOf("acme/slow"));
    expect(top).toContain("BlndAv");
  });

  it("aligns the scoped-models table header precisely over its data columns", () => {
    const scoped = findScoped(entries, [
      { slug: "acme/slow", label: "deepseek/deepseek-v4-flash-0731" },
    ]);
    const scopedWithData = scoped.map((s) => ({
      ...s,
      entry: s.entry
        ? {
            ...s.entry,
            pricing: { blended: 0.072 },
            throughput_p50: 106.83,
            ipp: {
              blndcod: 959.72,
              blndagnt: 672.22,
              cachcod: 1531.47,
              cachagt: 1072.70,
              blnd: 800,
              cach: 900,
            },
            indices: { intelligence: 51.8, coding: 69.1, agentic: 48.4 },
          }
        : s.entry,
    }));
    const out = renderScoped(scopedWithData);
    const lines = out.split("\n");
    const header = stripAnsi(lines[1]);
    const row = stripAnsi(lines[3]);

    // "Model" is left-aligned: the label start sits above the value start.
    expect(header.indexOf("Model")).toBe(row.indexOf("deepseek/deepseek-v4-flash-0731"));

    // Every numeric column is right-aligned: the last character of each header
    // label must sit in the same column as the last digit of its value.
    const numericPairs: [string, string][] = [
      ["Intel", "51.8"],
      ["Coding", "69.1"],
      ["Agentic", "48.4"],
      ["Base$/M", "$0.0720"],
      ["p50TPS", "106.8"],  // tpsDec is derived from the value precision
      ["BlndCd", "959.72"],
      ["BlndAg", "672.22"],
      ["CachCd", "1531.47"],
      ["CachAg", "1072.70"],
    ];
    for (const [label, value] of numericPairs) {
      const labelEnd = header.lastIndexOf(label) + label.length;
      const valueEnd = row.indexOf(value) + value.length;
      expect(labelEnd).toBe(valueEnd);
    }

    // The whole table must remain within a single, consistent inner width
    // (after stripping ANSI escape codes, which are invisible but count toward string length).
    const stripped = lines.map(stripAnsi);
    const topBorderLen = stripped[0].length;
    const bottomBorderLen = stripped[stripped.length - 1].length;
    expect(topBorderLen).toBe(bottomBorderLen);
    expect(stripped.every((l) => l.length === topBorderLen)).toBe(true);
  });

  it("aligns right-aligned header labels over their values in renderTop and renderTPS", () => {
    const entries = analyzeModels([
      { id: "acme/slow", name: "Slow", pricing: { prompt: "0.01", completion: "0.01" }, benchmarks: { artificial_analysis: { coding_index: 80, agentic_index: 80 } } },
    ]);
    const data = entries.map((e) => ({
      ...e,
      pricing: { blended: 0.072 },
      throughput_p50: 106.83,
      ipp: { blndcod: 959.72, blndagnt: 672.22, cachcod: 1531.47, cachagt: 1072.70, blnd: 800, cach: 900 },
      indices: { intelligence: 52, coding: 69, agentic: 48 },
    }));

    // renderTop: integer indices (toFixed(0)), right-aligned labels.
    const top = renderTop(data);
    let lines = top.split("\n");
    let header = stripAnsi(lines[1]), row = stripAnsi(lines[3]);
    const topPairs: [string, string][] = [
      ["Intel", "52"], ["Coding", "69"], ["Agent", "48"],
      ["$M/M", "$0.0720"], ["p50TPS", "106.8"],
      ["BlndCd", "959.72"], ["BlndCd", "959.72"], ["BlndAv", "800.00"], ["CachAv", "900.00"],
    ];
    const seen = new Set<string>();
    for (const [label, value] of topPairs) {
      const key = label + "|" + value;
      if (seen.has(key)) continue;
      seen.add(key);
      expect(header.lastIndexOf(label) + label.length).toBe(row.indexOf(value) + value.length);
    }
    // Rank is left-aligned over the rank number: right edges should align.
    expect(header.lastIndexOf("Rank") + "Rank".length).toBe(row.indexOf("1") + "1".length);

    // renderTPS: right-aligned labels over values
    const tps = renderTPS(data);
    lines = tps.split("\n");
    header = stripAnsi(lines[1]);
    row = stripAnsi(lines[3]);
    const tpsPairs: [string, string][] = [
      ["Base$/M", "$0.0720"], ["BlndAv", "800.00"], ["Coding", "69"],
      ["Agentic", "48"], ["Intel", "52"], ["p50 TPS(30m)", "106.8"],
    ];
    for (const [label, value] of tpsPairs) {
      expect(header.lastIndexOf(label) + label.length).toBe(row.indexOf(value) + value.length);
    }
  });

  it("renders side-by-side notable tables for raw ability categories", () => {
    const cheap = analyzeModels([
      { id: "acme/cheap-fast", name: "Cheap Fast", pricing: { prompt: "0.0000005", completion: "0.0000005" }, benchmarks: { artificial_analysis: { coding_index: 90, agentic_index: 85 } } },
      { id: "acme/cheap-slow", name: "Cheap Slow", pricing: { prompt: "0.0000005", completion: "0.0000005" }, benchmarks: { artificial_analysis: { coding_index: 70, agentic_index: 90 } } },
      { id: "acme/expensive", name: "Expensive", pricing: { prompt: "0.01", completion: "0.01" }, benchmarks: { artificial_analysis: { coding_index: 95, agentic_index: 95 } } },
    ]);
    const notable = findNotable(cheap);
    const rendered = renderNotable(notable);

    // Side-by-side tables should have the title and column headers
    expect(rendered).toContain("🏆 Agentic Ability");
    expect(rendered).toContain("Agentic (raw)");
    expect(rendered).toContain("Agentic <\$1>");
    expect(rendered).toContain("💻 Coding Ability");
    expect(rendered).toContain("Coding (raw)");
    expect(rendered).toContain("Coding <\$1>");

    // Vertical IPP entries should still appear
    expect(rendered).toContain("Blended IPP");
    expect(rendered).toContain("Cached IPP");

    // The expensive model should appear in the left (no cap) column but not the right (capped) column
    const agenticSection = rendered.slice(rendered.indexOf("🏆 Agentic Ability"), rendered.indexOf("💻 Coding Ability"));
    expect(agenticSection).toContain("acme/expensive");
    // Cheap Slow (agentic=90, <$1) should appear in the right column
    expect(agenticSection).toContain("acme/cheap-slow");
  });
});
