#!/usr/bin/env node
/**
 * Analyze token usage from successful session messages over the last 24 hours.
 * Extracts usage statistics to inform max_completion_tokens and throughput analysis.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const sessionDir = '/root/.pi/agent/sessions/--workspaces-base_pi--';
const sessionFiles = readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));

// 24 hours ago in ms
const cutoff = Date.now() - 24 * 60 * 60 * 1000;

const stats = {
  totalMessages: 0,
  successful: 0,
  terminated: 0,
  byModel: {},
  tokenBuckets: {
    output_0_100: 0,
    output_100_500: 0,
    output_500_1000: 0,
    output_1000_2000: 0,
    output_2000_3000: 0,
    output_3000_5000: 0,
    output_5000_plus: 0,
  },
  thinkingBuckets: {
    reasoning_0: 0,
    reasoning_1_500: 0,
    reasoning_500_1000: 0,
    reasoning_1000_2000: 0,
    reasoning_2000_3000: 0,
    reasoning_3000_plus: 0,
  },
  outputTokens: [],
  reasoningTokens: [],
  totalTokens: [],
  latencyEstimates: {}, // estimated latency at various tps rates
};

for (const file of sessionFiles) {
  const filepath = join(sessionDir, file);
  const content = readFileSync(filepath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type !== 'message' || obj.message?.role !== 'assistant') continue;

      // Check timestamp for last 24 hours
      const ts = obj.timestamp || 0;
      // Some sessions may have timestamp as string or number
      const tsMs = typeof ts === 'string' ? new Date(ts).getTime() : ts;
      if (tsMs < cutoff && cutoff > 0) continue;

      stats.totalMessages++;
      const msg = obj.message;
      const usage = msg.usage || {};
      const stopReason = msg.stopReason || 'unknown';
      const model = msg.model || 'unknown';
      const outputTokens = usage.output || 0;
      const reasoningTokens = usage.reasoning || 0;
      const inputTokens = usage.input || 0;
      const totalTokens = usage.totalTokens || (inputTokens + outputTokens + reasoningTokens);

      if (stopReason === 'error' || stopReason === 'aborted' || stopReason === 'terminated') {
        stats.terminated++;
      } else {
        stats.successful++;
      }

      // Model breakdown
      if (!stats.byModel[model]) {
        stats.byModel[model] = { successful: 0, terminated: 0, outputTokens: [], reasoningTokens: [] };
      }
      const modelStats = stats.byModel[model];
      if (stopReason === 'error' || stopReason === 'aborted' || stopReason === 'terminated') {
        modelStats.terminated++;
      } else {
        modelStats.successful++;
      }
      modelStats.outputTokens.push(outputTokens);
      modelStats.reasoningTokens.push(reasoningTokens);

      // Token buckets
      if (outputTokens <= 100) stats.tokenBuckets.output_0_100++;
      else if (outputTokens <= 500) stats.tokenBuckets.output_100_500++;
      else if (outputTokens <= 1000) stats.tokenBuckets.output_500_1000++;
      else if (outputTokens <= 2000) stats.tokenBuckets.output_1000_2000++;
      else if (outputTokens <= 3000) stats.tokenBuckets.output_2000_3000++;
      else if (outputTokens <= 5000) stats.tokenBuckets.output_3000_5000++;
      else stats.tokenBuckets.output_5000_plus++;

      // Reasoning buckets
      if (reasoningTokens === 0) stats.thinkingBuckets.reasoning_0++;
      else if (reasoningTokens <= 500) stats.thinkingBuckets.reasoning_1_500++;
      else if (reasoningTokens <= 1000) stats.thinkingBuckets.reasoning_500_1000++;
      else if (reasoningTokens <= 2000) stats.thinkingBuckets.reasoning_1000_2000++;
      else if (reasoningTokens <= 3000) stats.thinkingBuckets.reasoning_2000_3000++;
      else stats.thinkingBuckets.reasoning_3000_plus++;

      stats.outputTokens.push(outputTokens);
      stats.reasoningTokens.push(reasoningTokens);
      stats.totalTokens.push(totalTokens);

    } catch (e) { /* skip malformed lines */ }
  }
}

// Print summary
console.log('=== Token Usage Analysis (last 24h) ===');
console.log('Total assistant messages:', stats.totalMessages);
console.log('Successful:', stats.successful);
console.log('Terminated:', stats.terminated);
console.log();

// Overall token distributions
console.log('=== Output Token Distribution (successful messages) ===');
for (const [bucket, count] of Object.entries(stats.tokenBuckets)) {
  console.log(`  ${bucket}: ${count}`);
}

console.log('\n=== Reasoning Token Distribution (successful messages) ===');
for (const [bucket, count] of Object.entries(stats.thinkingBuckets)) {
  console.log(`  ${bucket}: ${count}`);
}

// Percentile calculations
function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

console.log('\n=== Output Token Percentiles (all messages) ===');
console.log('  p50:', percentile(stats.outputTokens, 50));
console.log('  p90:', percentile(stats.outputTokens, 90));
console.log('  p95:', percentile(stats.outputTokens, 95));
console.log('  p99:', percentile(stats.outputTokens, 99));
console.log('  max:', Math.max(...stats.outputTokens, 0));

console.log('\n=== Reasoning Token Percentiles (all messages) ===');
console.log('  p50:', percentile(stats.reasoningTokens, 50));
console.log('  p90:', percentile(stats.reasoningTokens, 90));
console.log('  p95:', percentile(stats.reasoningTokens, 95));
console.log('  p99:', percentile(stats.reasoningTokens, 99));
console.log('  max:', Math.max(...stats.reasoningTokens, 0));

console.log('\n=== Total Token Percentiles (all messages) ===');
console.log('  p50:', percentile(stats.totalTokens, 50));
console.log('  p90:', percentile(stats.totalTokens, 90));
console.log('  p95:', percentile(stats.totalTokens, 95));
console.log('  p99:', percentile(stats.totalTokens, 99));
console.log('  max:', Math.max(...stats.totalTokens, 0));

// Model breakdown
console.log('\n=== By Model ===');
for (const [model, ms] of Object.entries(stats.byModel).sort((a,b) => b[1].successful - a[1].successful)) {
  const total = ms.successful + ms.terminated;
  const avgOutput = ms.outputTokens.length > 0
    ? Math.round(ms.outputTokens.reduce((a,b) => a+b, 0) / ms.outputTokens.length) : 0;
  const avgReasoning = ms.reasoningTokens.length > 0
    ? Math.round(ms.reasoningTokens.reduce((a,b) => a+b, 0) / ms.reasoningTokens.length) : 0;
  console.log(`  ${model}: ${total} total (${ms.successful} ok, ${ms.terminated} term), avg_output=${avgOutput}, avg_reasoning=${avgReasoning}`);
}

// 50 tps analysis
console.log('\n=== Throughput Analysis: 50 tps ===');
const tps = 50;
const wallTime = 30; // seconds
const maxTokensAtWall = tps * wallTime;
console.log(`At ${tps} tps, in ${wallTime}s: ${maxTokensAtWall} tokens max`);
console.log(`  If all tokens are content: ${maxTokensAtWall} tokens of output`);
console.log(`  If thinking takes 1000 tokens: ${maxTokensAtWall - 1000} tokens of content remaining`);
console.log(`  If thinking takes 2000 tokens: ${maxTokensAtWall - 2000} tokens of content remaining`);

// What max_completion_tokens would be safe?
console.log('\n=== Recommended max_completion_tokens ===');
const p95_output = percentile(stats.outputTokens, 95);
const p90_output = percentile(stats.outputTokens, 90);
const p99_output = percentile(stats.outputTokens, 99);
console.log(`  p50 output: ${percentile(stats.outputTokens, 50)}`);
console.log(`  p90 output: ${p90_output}`);
console.log(`  p95 output: ${p95_output}`);
console.log(`  p99 output: ${p99_output}`);
console.log(`  max output: ${Math.max(...stats.outputTokens, 0)}`);

// Suggested cap: a bit above p95 but below the 30s wall at current tps
const suggestedCap = Math.min(maxTokensAtWall - 500, Math.max(p95_output * 2, 2000));
console.log(`  Suggested max_completion_tokens: ${suggestedCap} (30s wall at 50tps = ${maxTokensAtWall}, p95 output = ${p95_output})`);

// Latency estimates
console.log('\n=== Estimated time-to-complete at various throughput rates ===');
for (const t of [20, 30, 50, 80, 100]) {
  const timeForP95 = (p95_output / t).toFixed(1);
  const timeForP99 = (p99_output / t).toFixed(1);
  const wouldFit = p95_output <= t * wallTime ? 'YES' : 'NO - would hit 30s wall';
  console.log(`  ${t} tps: p95 output takes ${timeForP95}s (${wouldFit}), p99 takes ${timeForP99}s`);
}
