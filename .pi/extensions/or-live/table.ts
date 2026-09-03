/**
 * Generic table rendering utility for pi or-live metrics.
 *
 * Dynamically computes column widths from header labels and formatted
 * data values so that right-aligned headers always sit above the
 * rightmost digit of their values — eliminating the hardcoded-width
 * misalignment class of bugs.
 */

// ─── Types ──────────────────────────────────────────────────────────────

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

// ─── Width computation ──────────────────────────────────────────────────

/**
 * Compute per-column widths as max(label.length, maxFormattedValueWidth).
 */
export function computeWidths<T>(cols: TableCol<T>[], rows: T[]): number[] {
  return cols.map((col) => {
    const labelLen = col.label.length;
    const maxValLen = rows.reduce((max, row, i) => {
      return Math.max(max, col.format(row, i).length);
    }, 0);
    return Math.max(labelLen, maxValLen);
  });
}

// ─── Rendering helpers ──────────────────────────────────────────────────

function padCell(text: string, width: number, align: "left" | "right"): string {
  if (text.length >= width) return text.slice(0, width);
  return align === "right"
    ? " ".repeat(width - text.length) + text
    : text + " ".repeat(width - text.length);
}

/**
 * Render a boxed table with dynamic column widths.
 *
 * Each column is right-aligned by default (suitable for numeric data)
 * unless `align: "left"` is set (suitable for the Model/name column).
 */
export function renderTable<T>(
  cols: TableCol<T>[],
  rows: T[],
  opts: TableOpts = {}
): string {
  const { sep = " ", title, titlePrefix } = opts;
  const widths = computeWidths(cols, rows);

  const inner = widths.reduce((a, b) => a + b, 0) + sep.length * (cols.length - 1);
  const dash = "─".repeat(inner + 2);

  const lines: string[] = [];

  if (titlePrefix) {
    lines.push(`┌${titlePrefix.padEnd(dash.length, "─")}┐`);
  } else if (title) {
    lines.push(`┌─ ${title} ─${"─".repeat(Math.max(0, dash.length - title.length - 4))}┐`);
  }

  // Header row: left-align "Model"/"Rank", right-align everything else
  let header = "";
  for (let i = 0; i < cols.length; i++) {
    const col = cols[i];
    const align = col.align ?? (col.label === "Model" || col.label === "Rank" ? "left" : "right");
    header += padCell(col.label, widths[i], align);
    if (i < cols.length - 1) header += sep;
  }
  lines.push(`│ ${header} │`);
  lines.push(`│${dash}│`);

  // Data rows
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let rowStr = "";
    for (let j = 0; j < cols.length; j++) {
      const col = cols[j];
      const align = col.align ?? (col.label === "Model" || col.label === "Rank" ? "left" : "right");
      rowStr += padCell(col.format(row, i), widths[j], align);
      if (j < cols.length - 1) rowStr += sep;
    }
    lines.push(`│ ${rowStr} │`);
  }

  lines.push(`└${dash}┘`);
  return lines.join("\n");
}
