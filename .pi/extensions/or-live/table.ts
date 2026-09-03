/**
 * Generic table rendering utility for pi or-live metrics.
 *
 * Thin wrapper around cli-table3 that produces the same visual output
 * (box-drawing borders: ┌─┐│└┘, same column alignment, same padding)
 * as the previous hand-rolled renderer.
 *
 * Exports the same renderTable<T>() function signature so metrics.ts
 * doesn't need major changes.
 */

import Table from "cli-table3";

// ─── Types ──────────────────────────────────────────────────────

export interface TableCol<T> {
  /** Column header label. */
  label: string;
  /** Format a data row (and its index) into the string displayed in this column. */
  format: (row: T, index: number) => string;
  /** Alignment within the column. Default: "right" for numeric labels, "left" otherwise. */
  align?: "left" | "right";
}

export interface TableOpts {
  /** Column separator string. Default: single space. */
  sep?: string;
  /** Title displayed above the table (no box drawing). */
  title?: string;
  /** Prefix prepended to the title line (e.g. "─ Top 20 by Blended IPP ─"). */
  titlePrefix?: string;
}

// ─── Rendering ──────────────────────────────────────────────────

/**
 * Render a boxed table with dynamic column widths using cli-table3.
 *
 * Each column is right-aligned by default (suitable for numeric data)
 * unless `align: "left"` is set (suitable for the Model/name column).
 *
 * The `sep` option controls the padding between columns (passed as
 * `paddingLeft`/`paddingRight` on each cell via cli-table3 style options).
 */
export function renderTable<T>(
  cols: TableCol<T>[],
  rows: T[],
  opts: TableOpts = {}
): string {
  const { sep = " ", title, titlePrefix } = opts;

  // Determine per-column alignment: left for "Model"/"Rank", right otherwise.
  const aligns: ("left" | "right")[] = cols.map(
    (c) => c.align ?? (c.label === "Model" || c.label === "Rank" ? "left" : "right")
  );

  // Build cli-table3 head and rows.
  const head = cols.map((c) => c.label);
  const dataRows = rows.map((row, i) => cols.map((c) => c.format(row, i)));

  // cli-table3 uses paddingLeft/paddingRight for cell padding.
  // We use sep as the inter-column gap by setting paddingLeft and paddingRight
  // to half the separator length on each side.
  const padLeft = Math.floor(sep.length / 2);
  const padRight = sep.length - padLeft;

  const table = new Table({
    head,
    style: {
      border: ["─", "│", "┌", "┐", "└", "┘", "┬", "├", "┤", "┴", "┼"],
      paddingLeft: padLeft,
      paddingRight: padRight,
      head: [],
    },
    colAligns: aligns,
    // Ensure columns are wide enough for their content (cli-table3 does this
    // automatically by default, which is what we want).
  } as any);

  for (const row of dataRows) {
    table.push(row);
  }

  let output = table.toString();

  // Wrap with title prefix if provided.
  if (titlePrefix) {
    const lines = output.split("\n");
    const innerWidth = lines[0].length;
    const topLine = lines[0];
    const titledTop = topLine.replace(
      /^┌/,
      `┌${titlePrefix.padEnd(innerWidth - 2, "─")}`
    );
    output = [titledTop, ...lines.slice(1)].join("\n");
  } else if (title) {
    const lines = output.split("\n");
    const innerWidth = lines[0].length;
    const titledTop = `┌─ ${title} ─${"─".repeat(Math.max(0, innerWidth - title.length - 4))}┐`;
    output = [titledTop, ...lines.slice(1)].join("\n");
  }

  return output;
}
