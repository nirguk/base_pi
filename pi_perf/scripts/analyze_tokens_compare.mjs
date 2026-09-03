#!/usr/bin/env node
/**
 * Compare token usage between successful and terminated assistant messages.
 * No time filter — all available session data.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const sessionDir = '/root/.pi/agent/sessions/--workspaces-base_pi--';
const sessionFiles = readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));

const groups = {
  successful: { outputTokens: [], reasoningTokens: [], count: 0, models: {} },
  terminated: { outputTokens: [], reasoningTokens: [], count: 0, models: {} },
};

for (const file of sessionFiles) {
  const filepath = join(sessionDir, file);
  const content = readFileSync(filepath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type !== 'message' || obj.message?.role !== 'assistant') continue;

      const msg = obj.message;
      const usage = msg.usage || {};
      const stopReason = msg.stopReason || 'unknown';
      const model = msg.model || 'unknown';
      const outputTokens = usage.output || 0;
      const reasoningTokens = usage.reasoning || 0;

      const isTerminated = stopReason === 'error' || stopReason === 'aborted' || stopReason === 'terminated';
      const group = isTerminated ? groups.terminated : groups.successful;
      group.count++;
      group.outputTokens.push(outputTokens);
      group.reasoningTokens.push(reasoningTokens);

      if (!group.models[model]) group.models[model] = { count: 0, outputTokens: [], reasoningTokens: [] };
      const modelStats = group.models[model];
      modelStats.count++;
      modelStats.outputTokens.push(outputTokens);
      modelStats.reasoningTokens.push(reasoningTokens);
    } catch (e) { /* skip */ }
  }
}

function pct(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(Math.ceil(sorted.length * p / 100) - 1, sorted.length - 1);
  return sorted[idx];
}

function fmt(n) { return n.toLocaleString(); }

const metrics = [
  { label: 'Count', fn: (g) => g.count },
  { label: 'p50 output tokens', fn: (g) => pct(g.outputTokens, 50) },
  { label: 'p90 output tokens', fn: (g) => pct(g.outputTokens, 90) },
  { label: 'p95 output tokens', fn: (g) => pct(g.outputTokens, 95) },
  { label: 'p99 output tokens', fn: (g) => pct(g.outputTokens, 99) },
  { label: 'Max output tokens', fn: (g) => Math.max(...g.outputTokens, 0) },
  { label: 'p50 reasoning tokens', fn: (g) => pct(g.reasoningTokens, 50) },
  { label: 'p90 reasoning tokens', fn: (g) => pct(g.reasoningTokens, 90) },
  { label: 'p95 reasoning tokens', fn: (g) => pct(g.reasoningTokens, 95) },
  { label: 'p99 reasoning tokens', fn: (g) => pct(g.reasoningTokens, 99) },
  { label: 'Max reasoning tokens', fn: (g) => Math.max(...g.reasoningTokens, 0) },
];

const colW = { label: 28, succ: 8, term: 8, delta: 8 };
const top = `┌${'─'.repeat(colW.label + 2)}┬${'─'.repeat(colW.succ + 2)}┬${'─'.repeat(colW.term + 2)}┬${'─'.repeat(colW.delta + 2)}┐`;
const mid = `├${'─'.repeat(colW.label + 2)}┼${'─'.repeat(colW.succ + 2)}┼${'─'.repeat(colW.term + 2)}┼${'─'.repeat(colW.delta + 2)}┤`;
const bot = `└${'─'.repeat(colW.label + 2)}┴${'─'.repeat(colW.succ + 2)}┴${'─'.repeat(colW.term + 2)}┴${'─'.repeat(colW.delta + 2)}┘`;

console.log(top);
console.log(`│ ${'Metric'.padEnd(colW.label)} │ ${'Success'.padStart(colW.succ)} │ ${'Terminated'.padStart(colW.term)} │ ${'Delta'.padStart(colW.delta)} │`);
console.log(mid);

for (const m of metrics) {
  const sVal = m.fn(groups.successful);
  const tVal = m.fn(groups.terminated);
  const delta = sVal - tVal;
  const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '─';
  const deltaStr = delta === 0 ? '0' : (delta > 0 ? '+' : '') + fmt(delta);

  console.log(`│ ${m.label.padEnd(colW.label)} │ ${fmt(sVal).padStart(colW.succ)} │ ${fmt(tVal).padStart(colW.term)} │ ${arrow} ${deltaStr.padStart(colW.delta - 2)} │`);
}

console.log(bot);

// Model breakdown for terminated messages
console.log('\n=== Terminated by model ===');
const termModels = groups.terminated.models;
for (const [model, ms] of Object.entries(termModels).sort((a, b) => b[1].count - a[1].count)) {
  const p50out = pct(ms.outputTokens, 50);
  const p90out = pct(ms.outputTokens, 90);
  const p50reasoning = pct(ms.reasoningTokens, 50);
  console.log(`  ${model}: ${ms.count} terminated, p50_output=${fmt(p50out)}, p90_output=${fmt(p90out)}, p50_reasoning=${fmt(p50reasoning)}`);
}

// Token efficiency
console.log('\n=== Token efficiency at 30s wall boundary ===');
const walls = [
  { tps: 50, tokens: 50 * 30 },
  { tps: 80, tokens: 80 * 30 },
  { tps: 100, tokens: 100 * 30 },
];
for (const w of walls) {
  const succPct = (groups.successful.outputTokens.filter(t => t <= w.tokens).length / groups.successful.count * 100).toFixed(1);
  const termPct = (groups.terminated.outputTokens.filter(t => t <= w.tokens).length / groups.terminated.count * 100).toFixed(1);
  console.log(`  At ${w.tps} tps (${w.tokens} tokens): ${succPct}% successful fit, ${termPct}% terminated fit`);
}

// Key insight: what max_completion_tokens would cover 90% of successful turns?
const p90Output = pct(groups.successful.outputTokens, 90);
const p95Output = pct(groups.successful.outputTokens, 95);
console.log(`\n=== Recommended max_completion_tokens ===`);
console.log(`  p90 output tokens (successful): ${fmt(p90Output)}`);
console.log(`  p95 output tokens (successful): ${fmt(p95Output)}`);
console.log(`  Suggested cap: ${Math.max(p95Output, 2000)} (covers 95% of successful turns)`);
console.log(`  Note: 30s wall at 50 tps = ${50*30} tokens — cap above this won't prevent wall kills`);
console.log(`  Note: 30s wall at 100 tps = ${100*30} tokens — cap above this won't prevent wall kills`);
