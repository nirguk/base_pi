#!/usr/bin/env node
/**
 * For terminated messages, extract thinking content length directly from
 * the message content (since usage.reasoning is 0 for terminated streams).
 * Compare with successful messages where usage.reasoning IS populated.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const sessionDir = '/root/.pi/agent/sessions/--workspaces-base_pi--';
const sessionFiles = readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));

const data = {
  successful: { thinkingChars: [], outputChars: [], reasoningUsage: [] },
  terminated: { thinkingChars: [], outputChars: [] },
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
      const stopReason = msg.stopReason || 'unknown';
      const content = msg.content;
      const usage = msg.usage || {};

      let thinkingChars = 0;
      let outputChars = 0;

      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === 'thinking') {
            thinkingChars += (part.thinking || '').length;
          }
          if (part.type === 'text') {
            outputChars += (part.text || '').length;
          }
        }
      }

      const isTerminated = stopReason === 'error' || stopReason === 'aborted' || stopReason === 'terminated';
      const group = isTerminated ? data.terminated : data.successful;
      group.thinkingChars.push(thinkingChars);
      group.outputChars.push(outputChars);
      if (!isTerminated && usage.reasoning) {
        data.successful.reasoningUsage.push(usage.reasoning);
      }
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

// Compare thinking chars: successful vs terminated
console.log('=== Thinking Content Length (chars) ===');
console.log(`Successful messages with thinking: ${data.successful.thinkingChars.filter(c => c > 0).length} of ${data.successful.thinkingChars.length}`);
console.log(`Terminated messages with thinking: ${data.terminated.thinkingChars.filter(c => c > 0).length} of ${data.terminated.thinkingChars.length}`);
console.log();

const metrics = [
  ['Count with thinking', (g) => g.thinkingChars.filter(c => c > 0).length],
  ['p50 thinking chars', (g) => pct(g.thinkingChars.filter(c => c > 0), 50)],
  ['p90 thinking chars', (g) => pct(g.thinkingChars.filter(c => c > 0), 90)],
  ['p95 thinking chars', (g) => pct(g.thinkingChars.filter(c => c > 0), 95)],
  ['Max thinking chars', (g) => Math.max(...g.thinkingChars, 0)],
  ['p50 output chars', (g) => pct(g.outputChars.filter(c => c > 0), 50)],
  ['p90 output chars', (g) => pct(g.outputChars.filter(c => c > 0), 90)],
  ['p95 output chars', (g) => pct(g.outputChars.filter(c => c > 0), 95)],
];

const colW = { label: 28, succ: 10, term: 10, delta: 8 };
const top = `┌${'─'.repeat(colW.label + 2)}┬${'─'.repeat(colW.succ + 2)}┬${'─'.repeat(colW.term + 2)}┬${'─'.repeat(colW.delta + 2)}┐`;
const mid = `├${'─'.repeat(colW.label + 2)}┼${'─'.repeat(colW.succ + 2)}┼${'─'.repeat(colW.term + 2)}┼${'─'.repeat(colW.delta + 2)}┤`;
const bot = `└${'─'.repeat(colW.label + 2)}┴${'─'.repeat(colW.succ + 2)}┴${'─'.repeat(colW.term + 2)}┴${'─'.repeat(colW.delta + 2)}┘`;

console.log(top);
console.log(`│ ${'Metric'.padEnd(colW.label)} │ ${'Success'.padStart(colW.succ)} │ ${'Terminated'.padStart(colW.term)} │ ${'Delta'.padStart(colW.delta)} │`);
console.log(mid);

for (const [label, fn] of metrics) {
  const sVal = fn(data.successful);
  const tVal = fn(data.terminated);
  const delta = sVal - tVal;
  const arrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '─';
  const deltaStr = delta === 0 ? '0' : (delta > 0 ? '+' : '') + fmt(delta);
  console.log(`│ ${label.padEnd(colW.label)} │ ${fmt(sVal).padStart(colW.succ)} │ ${fmt(tVal).padStart(colW.term)} │ ${arrow} ${deltaStr.padStart(colW.delta - 2)} │`);
}

console.log(bot);

// Compare usage.reasoning vs content thinking chars for successful messages
console.log('\n=== Successful messages: usage.reasoning vs content thinking chars ===');
const succWithReasoning = data.successful.reasoningUsage;
const succWithThinking = data.successful.thinkingChars.filter(c => c > 0);
console.log(`Messages with usage.reasoning: ${succWithReasoning.length}`);
console.log(`Messages with thinking content: ${succWithThinking.length}`);
console.log(`p50 usage.reasoning: ${fmt(pct(succWithReasoning, 50))} tokens`);
console.log(`p50 thinking chars: ${fmt(pct(succWithThinking, 50))} chars`);
console.log(`Ratio (chars / tokens): ${(pct(succWithThinking, 50) / Math.max(pct(succWithReasoning, 50), 1)).toFixed(1)} chars/token`);

// Key question: at what thinking char count does the 30s wall tend to kill?
console.log('\n=== Terminated thinking char distribution ===');
const buckets = [
  [0, 0, '0 (no thinking)'],
  [1, 100, '1-100 chars'],
  [101, 500, '101-500 chars'],
  [501, 1000, '501-1000 chars'],
  [1001, 2000, '1001-2000 chars'],
  [2001, 3000, '2001-3000 chars'],
  [3001, 5000, '3001-5000 chars'],
  [5001, 10000, '5001-10000 chars'],
  [10001, Infinity, '10000+ chars'],
];
for (const [lo, hi, label] of buckets) {
  const count = data.terminated.thinkingChars.filter(c => c >= lo && c <= hi).length;
  console.log(`  ${label.padEnd(20)}: ${count}`);
}

// What's the thinking char count at the 30s wall boundary?
// The 30s wall kills at ~30s. If thinking tokens stream at ~50 tps,
// then 30s * 50 tps = 1500 thinking tokens.
// At ~4 chars/token, that's ~6000 chars of thinking.
// But the wall is about total time, not just thinking time.
console.log('\n=== 30s wall boundary analysis ===');
console.log('At 50 tps thinking speed, 30s = 1500 thinking tokens ≈ 6000 chars');
console.log(`Terminated messages with thinking ≤ 6000 chars: ${data.terminated.thinkingChars.filter(c => c <= 6000 && c > 0).length} of ${data.terminated.thinkingChars.filter(c => c > 0).length}`);
console.log(`Terminated messages with thinking > 6000 chars: ${data.terminated.thinkingChars.filter(c => c > 6000).length} of ${data.terminated.thinkingChars.filter(c => c > 0).length}`);
