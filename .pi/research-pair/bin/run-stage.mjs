#!/usr/bin/env node
/*
 * run-stage.mjs — deterministic per-stage prep + gate for the pi research pipeline.
 *
 * What this script does (and what it does NOT):
 *   - It CANNOT spawn pi sub-agents (the `pi-researcher`/`pi-condenser` are launched by the
 *     pi host from a session/workflow, not from Node).
 *   - It prepares a stage and gates it deterministically, so the human/orchestrator only needs
 *     to (1) call this to scaffold, (2) spawn the two agents in pi, (3) re-run this to gate.
 *
 * Usage (run from pi-audit root):
 *   node run-stage.mjs 01           # check preconditions, print the stage task, run the gate
 *   node run-stage.mjs 01 --gate-only   # just run check-research on existing files
 *   node run-stage.mjs 01 --imports-csv  # (placeholder — stage-specific flags)
 *
 * Flow:
 *   1. resolve stage number, raw/x paths (from the standard naming).
 *   2. if files already exist, warn (do not silently overwrite).
 *   3. run the pi/check gate via `check-research.mjs`.
 *   4. print exact instructions to then call pi-researcher / pi-condenser in this session.
 *
 * The REAL orchestration (spawning agents) lives in the pi session — as a `workflowScript`
 * like the one in prompts/README.md — NOT in this file. This script is the deterministic
 * scaffold/gate that the orchestrator calls between agent launches.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const RESEARCH_DIR = process.env.RESEARCH_DIR || 'research';
const CHECK_SCRIPT = process.env.CHECK_SCRIPT || './check-research.mjs';

const args = process.argv.slice(2);
const stageArg = args.find((a) => /^\d{2}$/.test(a));
const gateOnly = args.includes('--gate-only');

if (!stageArg) {
  console.error('Usage: node run-stage.mjs NN [--gate-only]');
  console.error('  NN    stage number, e.g. 08');
  console.error('  --gate-only   skip scaffold, only run the structural gate on existing files');
  process.exit(2);
}

const STAGE = stageArg;
if (!/^\d{2}$/.test(STAGE)) { console.error(`Invalid stage '${STAGE}' (expect NN).`); process.exit(2); }

if (!existsSync(RESEARCH_DIR)) {
  console.error(`ERROR: research dir not found: ${RESEARCH_DIR}`);
  process.exit(1);
}

const files = readdirSync(RESEARCH_DIR).filter((f) => f.endsWith('.md'));
const raws = files.filter((f) => f.startsWith(`research-stage-${STAGE}-`) && !f.endsWith('-x.md'));
const xs = files.filter((f) => f.startsWith(`research-stage-${STAGE}-`) && f.endsWith('-x.md'));

console.log(`\n===== pi research pipeline — Stage ${STAGE} =====`);

// --- preconditions ---
if (!gateOnly) {
  if (raws.length > 0) {
    console.log(`  [warn] raw already present: ${raws.join(', ')}`);
  } else {
    console.log(`  [ok ] no raw yet — ready for pi-researcher to write research/research-stage-${STAGE}-<topic>.md`);
  }
  if (xs.length > 0) console.log(`  [warn] -x already present: ${xs.join(', ')}`);
} else {
  console.log('  gate-only mode: skipping scaffold, gating existing files.');
}

// --- run the structural gate (deterministic) ---
console.log(`\n--- running gate: node ${CHECK_SCRIPT} ${STAGE}${gateOnly ? ' (full: raw + x)' : ''} ---`);
const res = spawnSync(process.execPath, [CHECK_SCRIPT, STAGE], {
  cwd: process.cwd(),
  encoding: 'utf8',
});
process.stdout.write(res.stdout || '');
process.stderr.write(res.stderr || '');
const gateFailed = res.status !== 0;

console.log(`\n==== gate for stage ${STAGE}: ${gateFailed ? 'FAIL' : 'PASS'} ====`);
if (gateFailed) {
  console.log('The raw stage output does not pass the deterministic gate. Fix and re-run before advancing.');
  process.exitCode = 1;
} else if (!gateOnly) {
  console.log('\nNEXT (in this session, when a pi host is available):');
  console.log('  1. Spawn pi-researcher with the Stage-' + STAGE + ' task (QUESTIONS etc. — see prompts/README.md for the workflowScript shape).');
  console.log('  2. After it writes the raw, re-run:  node run-stage.mjs ' + STAGE + ' --gate-only');
  console.log('  3. If pass, spawn pi-condenser to produce the -x.');
  console.log('  4. Final gate:  node run-stage.mjs ' + STAGE + ' --gate-only  (now checks raw + -x)');
}