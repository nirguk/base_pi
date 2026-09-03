// OpenRouter Free Model Analysis Extension
// This extension registers a command that fetches the live OpenRouter model catalog,
// extracts enriched data for free models, and stores it as a session entry.
// A custom entry renderer displays the data as a nicely formatted markdown table.

import type { ExtensionAPI, CustomEntry } from "@earendil-works/pi-coding-agent";
import { Box, Markdown } from "@earendil-works/pi-tui";

// Helper to extract parameter counts and MoE flag from model metadata
function extractParams(id: string, hfId?: string, description?: string) {
  const text = `${description ?? ""} ${hfId ?? ""} ${id}`.toLowerCase();
  let total: number | null = null;
  let active: number | null = null;

  // Pattern: Xb-aYb (MoE)
  let m = text.match(/(\d+(?:\.\d+)?)b-a(\d+(?:\.\d+)?)b/);
  if (m) {
    total = Number(m[1]);
    active = Number(m[2]);
  }

  // Various textual patterns for total/active
  if (!total) {
    m = text.match(/(\d+(?:\.\d+)?)\s*[bB]\s*active.*?\b(?:out of|from)\b\s*(\d+(?:\.\d+)?)\s*[bB]\s*total/);
    if (m) {
      active = Number(m[1]);
      total = Number(m[2]);
    }
  }
  if (!total) {
    m = text.match(/(\d+(?:\.\d+)?)\s*[bB]\s*total\s*parameter.*?(\d+(?:\.\d+)?)\s*[bB]\s*active/);
    if (m) {
      total = Number(m[1]);
      active = Number(m[2]);
    }
  }
  if (!total) {
    m = text.match(/(\d+(?:\.\d+)?)\s*[bB]\s*total\s*parameters?\s*(?:and\s*)?(\d+(?:\.\d+)?)\s*[bB]\s*active/);
    if (m) {
      total = Number(m[1]);
      active = Number(m[2]);
    }
  }

  // Only total
  if (!total) {
    m = text.match(/(\d+(?:\.\d+)?)\s*[bB]\s*param(?:eters?|s)/);
    if (m) total = Number(m[1]);
  }
  // Only active
  if (!active) {
    m = text.match(/(\d+(?:\.\d+)?)\s*[bB]\s*active\s*param/);
    if (m) active = Number(m[1]);
  }

  // Fallback: number in id like "2.5b"
  if (!total) {
    m = id.match(/(\d+(?:\.\d+)?)b(?!-?\d)/);
    if (m) total = Number(m[1]);
  }

  // Dense model => active = total
  if (total && !active) active = total;

  const isMoe = Boolean(
    /\bmoe\b|mixture-of-experts|mixture of experts|sparse/.test(text) ||
    /(\d+(?:\.\d+)?)b-a\d+(?:\.\d+)?b/.test(text) ||
    (active !== null && total !== null && active < total)
  );

  return { total, active, isMoe };
}

// Build the markdown table shared by the entry renderer and optional LLM delivery.
function buildMarkdownTable(rows: any[]): string {
  let md = "| Model ID | Total (B) | Active (B) | MoE | Tools | Coding | Intel | Agentic | Context |\n";
  md += "|----------|-----------|------------|-----|-------|--------|-------|---------|---------|\n";
  for (const r of rows) {
    const label = r.isRouter ? `${r.id} *(router)*` : r.id;
    md += `| ${label} | ${r.total ?? "—"} | ${r.active ?? "—"} | ${r.isMoe ? "Y" : "-"} | ${r.tools ? "✓" : "-"} | ${r.coding ?? "—"} | ${r.intel ?? "—"} | ${r.agentic ?? "—"} | ${r.context ?? "—"} |\n`;
  }
  return md;
}

export default function (pi: ExtensionAPI) {
  // Register a command that performs the analysis and stores it as an entry.
  // Usage: /openrouter-free-analysis [--send]
  //   --send  Additionally deliver the table to the LLM context (opt-in;
  //           default is TUI-only via session entry, keeping context clean).
  pi.registerCommand("openrouter-free-analysis", {
    description:
      "Fetch and display free OpenRouter model analysis (add --send to also share results with the LLM)",
    handler: async (args, ctx) => {
      const sendToLLM = /(^|\s)--send(\s|$)/.test(args ?? "");
      // Fetch the live model catalog from OpenRouter.
      const resp = await fetch("https://openrouter.ai/api/v1/models");
      if (!resp.ok) {
        ctx.ui.notify(`Failed to fetch models: ${resp.statusText}`, "error");
        return;
      }
      const api = await resp.json();

      // Filter free models (both prompt and completion pricing are "0").
      const free = api.data.filter((m: any) => m.pricing?.prompt === "0" && m.pricing?.completion === "0");

      const nonLLM = new Set([
        "google/lyria-3-pro-preview",
        "google/lyria-3-clip-preview",
      ]);
      const router = new Set(["openrouter/free"]);

      const rows = free
        .filter((m: any) => !nonLLM.has(m.id))
        .map((m: any) => {
          const p = extractParams(m.id, m.hugging_face_id, m.description);
          const supportsTools = m.supported_parameters?.includes("tools") || m.supported_parameters?.includes("tool_choice") || false;
          const bm = m.benchmarks?.artificial_analysis || {};
          const isRouter = router.has(m.id);
          return {
            id: m.id,
            name: m.name,
            total: p.total,
            active: p.active,
            isMoe: p.isMoe,
            tools: supportsTools,
            coding: bm.coding_index ?? null,
            intel: bm.intelligence_index ?? null,
            agentic: bm.agentic_index ?? null,
            context: m.context_length ?? null,
            isRouter,
          };
        });

      // Store the rows as a TUI-only session entry (does NOT enter LLM context).
      pi.appendEntry("model-analysis", { rows });

      if (sendToLLM) {
        // Opt-in: inject the table into LLM context without triggering a turn.
        pi.sendMessage(
          {
            customType: "model-analysis-for-llm",
            content: `Free OpenRouter model analysis (${rows.length} models):\n\n${buildMarkdownTable(rows)}`,
            display: false,
            details: { rows },
          },
          { deliverAs: "nextTurn" },
        );
        ctx.ui.notify(`Analysis stored in session and queued for next turn (${rows.length} models).`, "info");
      } else {
        ctx.ui.notify(`Free OpenRouter model analysis stored in session (${rows.length} models). Use --send to share with the LLM.`, "info");
      }
    },
  });

  // Register a renderer for the "model-analysis" entry type.
  pi.registerEntryRenderer("model-analysis", (entry: CustomEntry, { expanded }: any, theme: any) => {
    const rows = (entry.data as any)?.rows ?? [];
    const md = buildMarkdownTable(rows);

    // Return a proper TUI Component (Markdown) that the TUI can render.
    const markdownComponent = new Markdown(md, 0, 0, theme);
    const box = new Box(0, 0, (t) => theme.bg("customMessageBg", t));
    box.addChild(markdownComponent);
    return box;
  });
}
