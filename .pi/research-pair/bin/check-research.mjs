#!/usr/bin/env node
/*
 * check-research.mjs — deterministic structural validation for the pi research pipeline.
 *
 * Validates researcher raw and condenser -x files using ONLY filesystem + string heuristics
 * (existence, line/byte size, heading count, required section markers, condensation ratio).
 * The condensation ratio is a HOPE not a gate: out-of-range ratios are reported as notes, never fail.
 * Never reads content into a model context — cheap and scriptable.
 *
 * Usage (run from pi-audit root, or set RESEARCH_DIR):
 *   node check-research.mjs 01            # stage 01 raw + -x (if present)
 *   node check-research.mjs 01 --raw-only # raw only
 *   node check-research.mjs 01 --no-x     # skip -x checks
 *   node check-research.mjs --all         # all research-stage-*.md found
 *
 * Exit: 0 = all selected checks pass; 1 = any failure; 2 = no stage given.
 */

import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const RESEARCH_DIR = process.env.RESEARCH_DIR || 'research';
const MIN_RAW_LINES = 100;   // raw must be at least this long
const RATIO_MIN = 0.30;       // -x between 30% and 50% of raw by lines (a HOPE - notes only)
const RATIO_MAX = 0.50;

// Required structural markers (case-insensitive). Tolerance for BOTH conventions observed:
// literal names (## Findings / Contradictions / Gaps / Source refs) OR per-question/numbered
// sections (## F.N ... (Q1) ; ## Q1 — ...). We require the CONCEPT present, not a specific word.
const RAW_CONCEPTS = [
  ['per_question_coverage', /\bq\s*\d\b|\(q\d\)|question/i],
  ['contradictions_or_gaps', /contradiction|differs|conflict|gap|unknown|open\s+issue/i],
  ['source_refs', /source|reference|refs/i],
];
const RATIONAL_RE = /because|reason|due to|since|=>|because of|rationale/;
// Tolerant -x concept checks: mirror RAW_CONCEPTS style; don't require exact words.
const X_CONCEPTS = [
  ['coverage', /q\s*\d\b|\(q\d\)|question|answer/i],
  ['contradictions_or_corrections', /contradiction|correction|differs|conflict|plan\s+correction/i],
  ['open_questions', /open|unverified|unknown|gap/i],
  ['rationale', /because|reason|rationale|due to|why\s+we|why\s+use/i],
];

const args = process.argv.slice(2);
const modeAll = args.includes('--all');
const rawOnly = args.includes('--raw-only');
const skipX = args.includes('--no-x');
const stageArg = args.find((a) => /^\d{2}$/.test(a));

if (!existsSync(RESEARCH_DIR)) {
  console.error(`ERROR: research dir not found: ${RESEARCH_DIR}`);
  process.exit(1);
}

const files = readdirSync(RESEARCH_DIR).filter((f) => f.endsWith('.md'));
let failed = false;

function inspect(fileName, kind, rawRefLines) {
  const full = join(RESEARCH_DIR, fileName);
  if (!existsSync(full)) return { ok: false, problems: ['MISSING'], lines: 0, bytes: 0 };
  const text = readFileSync(full, 'utf8');
  const lower = text.toLowerCase();
  const lines = text.split('\n').length;
  const bytes = statSync(full).size;
  const problems = [];
  const notes = [];

  if (kind === 'raw') {
    if (lines < MIN_RAW_LINES) problems.push(`too_short(${lines}<${MIN_RAW_LINES})`);
    for (const [name, re] of RAW_CONCEPTS) if (!re.test(text)) problems.push(`missing:${name}`);
    // Flag section-number inconsistency like ``F.1..F.5`` then ``3.6`` (seen in stage 01).
    const numbs = [...text.matchAll(/^##\s+([A-Za-z]?\.?\d+)/gm)].map((m) => m[1]);
    const mixed = new Set(numbs.map((n) => (/^[A-Za-z]/.test(n) ? 'alpha' : 'num')));
    if (mixed.size > 1) problems.push('inconsistent_section_numbering');
  } else {
    if (!RATIONAL_RE.test(lower)) problems.push('no_rationale');
    for (const [name, re] of X_CONCEPTS) if (!re.test(text)) problems.push(`missing:${name}`);
    // Condensation ratio is a HOPE, not a gate — report as note, never fail.
    if (rawRefLines > 0) {
      const ratio = lines / rawRefLines;
      if (ratio > RATIO_MAX) notes.push(`ratio_note_high(${ratio.toFixed(2)} , target<=${RATIO_MAX})`);
      else if (ratio < RATIO_MIN) notes.push(`ratio_note_low(${ratio.toFixed(2)}, target>=${RATIO_MIN})`);
      else notes.push(`ratio_ok(${ratio.toFixed(2)})`);
    }
  }
  return { ok: problems.length === 0, problems, notes, lines, bytes };
}

function printResult(kind, name, res) {
  const badge = res.ok ? 'PASS' : 'FAIL';
  console.log(`  ${kind.padEnd(4)} ${name.padEnd(46)} (${res.lines} ln, ${res.bytes} b)  ${badge}`);
  if (!res.ok) { res.problems.forEach((p) => console.log('        - ' + p)); failed = true; }
  if (res.notes && res.notes.length) res.notes.forEach((n) => console.log('        (note) ' + n));
}

const stages = modeAll
  ? [...new Set(files.map((f) => /^research-stage-(\d{2})/.exec(f)?.[1]).filter(Boolean))]
  : (stageArg ? [stageArg] : []);

if (stages.length === 0) {
  console.error('No stage specified. Use `node check-research.mjs NN`, `--all`, or set RESEARCH_DIR.');
  process.exit(2);
}

for (const st of stages) {
  console.log(`\n== Stage ${st} ==`);
  const raws = files.filter((f) => f.startsWith(`research-stage-${st}-`) && !f.endsWith('-x.md'));
  const xs = files.filter((f) => f.startsWith(`research-stage-${st}-`) && f.endsWith('-x.md'));

  for (const raw of raws) {
    const res = inspect(raw, 'raw', 0);
    printResult('RAW', raw, res);
  }

  if (rawOnly) continue;

  for (const x of xs) {
    const rawLines = raws[0] ? readFileSync(join(RESEARCH_DIR, raws[0]), 'utf8').split('\n').length : 0;
    const res = inspect(x, 'x', rawLines);
    printResult('-x ', x, res);
  }
  if (xs.length === 0 && !skipX) console.log('  (no -x file yet for this stage)');
}

console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: ALL PASS');
process.exitCode = failed ? 1 : 0;
