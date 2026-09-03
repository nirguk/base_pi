#!/usr/bin/env node
/**
 * Analyze session JSONL files for thinking/reasoning content distribution.
 *
 * Extracts from assistant messages:
 *   - thinking length (chars)
 *   - text length (chars)
 *   - reasoning token count (from usage)
 *   - stopReason (success vs error/terminated)
 *   - model
 *
 * Outputs:
 *   1. JSON distribution data to stdout
 *   2. An HTML visualization file
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sessionDir = '/root/.pi/agent/sessions/--workspaces-base_pi--';
const sessionFiles = readdirSync(sessionDir).filter(f => f.endsWith('.jsonl'));

const results = {
  totalMessages: 0,
  totalAssistantMessages: 0,
  totalWithThinking: 0,
  totalTerminated: 0,
  totalSuccess: 0,
  terminated: [],   // { thinkingLen, textLen, reasoningTokens, model, stopReason, sessionId }
  success: [],      // same structure
  allMessages: [],  // all assistant messages
};

function extractThinkingData(obj, sessionId) {
  if (obj.type !== 'message' || obj.message?.role !== 'assistant') return;

  results.totalAssistantMessages++;
  const msg = obj.message;
  const content = msg.content;
  const usage = msg.usage || {};
  const stopReason = msg.stopReason || 'unknown';
  const model = msg.model || 'unknown';

  let thinkingLen = 0;
  let textLen = 0;
  let reasoningTokens = usage.reasoning || 0;

  if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === 'thinking') {
        thinkingLen = (part.thinking || '').length;
      }
      if (part.type === 'text') {
        textLen += (part.text || '').length;
      }
    }
  } else if (typeof content === 'string') {
    textLen = content.length;
  }

  const entry = {
    thinkingLen,
    textLen,
    reasoningTokens,
    model,
    stopReason,
    sessionId: sessionId.slice(0, 12),
    timestamp: obj.timestamp || null,
  };

  results.allMessages.push(entry);

  if (thinkingLen > 0 || reasoningTokens > 0) {
    results.totalWithThinking++;
  }

  if (stopReason === 'error' || stopReason === 'aborted' || stopReason === 'terminated') {
    results.totalTerminated++;
    results.terminated.push(entry);
  } else {
    results.totalSuccess++;
    results.success.push(entry);
  }
}

// Process all session files
for (const file of sessionFiles) {
  const filepath = join(sessionDir, file);
  const content = readFileSync(filepath, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      const sessionId = obj.id || obj.sessionId || file;
      extractThinkingData(obj, sessionId);
    } catch (e) {
      // skip malformed lines
    }
  }
}

// Print summary
console.log('=== Summary ===');
console.log('Total assistant messages:', results.totalAssistantMessages);
console.log('Messages with thinking data:', results.totalWithThinking);
console.log('Terminated (error/aborted/terminated):', results.totalTerminated);
console.log('Successful:', results.totalSuccess);
console.log();

// Distribution buckets for thinking length
function buildDistribution(entries, field, buckets) {
  const dist = {};
  for (const b of buckets) dist[b] = 0;
  for (const e of entries) {
    const val = e[field] || 0;
    for (let i = 0; i < buckets.length; i++) {
      if (i === buckets.length - 1 || val < buckets[i + 1]) {
        dist[buckets[i]]++;
        break;
      }
    }
  }
  return dist;
}

const charBuckets = [0, 100, 500, 1000, 2000, 5000, 10000, 50000, Infinity];
const tokenBuckets = [0, 100, 500, 1000, 2000, 5000, 10000, Infinity];

console.log('=== Terminated: Thinking length distribution (chars) ===');
const termThinkingDist = buildDistribution(results.terminated, 'thinkingLen', charBuckets);
for (const [bucket, count] of Object.entries(termThinkingDist)) {
  const label = bucket === Infinity ? '50000+' : bucket;
  console.log(`  ${String(label).padStart(6)} chars: ${count}`);
}

console.log('\n=== Success: Thinking length distribution (chars) ===');
const succThinkingDist = buildDistribution(results.success, 'thinkingLen', charBuckets);
for (const [bucket, count] of Object.entries(succThinkingDist)) {
  const label = bucket === Infinity ? '50000+' : bucket;
  console.log(`  ${String(label).padStart(6)} chars: ${count}`);
}

console.log('\n=== Terminated: Reasoning tokens distribution ===');
const termTokenDist = buildDistribution(results.terminated, 'reasoningTokens', tokenBuckets);
for (const [bucket, count] of Object.entries(termTokenDist)) {
  const label = bucket === Infinity ? '10000+' : bucket;
  console.log(`  ${String(label).padStart(6)} tokens: ${count}`);
}

console.log('\n=== Success: Reasoning tokens distribution ===');
const succTokenDist = buildDistribution(results.success, 'reasoningTokens', tokenBuckets);
for (const [bucket, count] of Object.entries(succTokenDist)) {
  const label = bucket === Infinity ? '10000+' : bucket;
  console.log(`  ${String(label).padStart(6)} tokens: ${count}`);
}

// Terminated messages with thinking content - what happened?
console.log('\n=== Terminated messages WITH thinking content (sample) ===');
const termWithThinking = results.terminated.filter(e => e.thinkingLen > 0);
console.log('Count:', termWithThinking.length, 'of', results.terminated.length, 'terminated');
for (const e of termWithThinking.slice(0, 10)) {
  console.log(`  thinking=${e.thinkingLen} chars, text=${e.textLen} chars, ` +
    `reasoning_tokens=${e.reasoningTokens}, model=${e.model}, ` +
    `stopReason=${e.stopReason}, session=${e.sessionId}`);
  console.log(`    thinking preview: ${e.thinkingLen > 0 ? JSON.stringify(results.allMessages
    .find(m => m === e)?.thinkingLen || '?') : '?'}`);
}

// Actually, let me get the thinking preview from the session files directly
console.log('\n=== Terminated messages with thinking: preview ===');
for (const e of termWithThinking.slice(0, 5)) {
  // Find the session file
  for (const file of sessionFiles) {
    if (file.includes(e.sessionId)) {
      const filepath = join(sessionDir, file);
      const content = readFileSync(filepath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'message' && obj.message?.role === 'assistant') {
            const content = obj.message.content;
            if (Array.isArray(content)) {
              for (const part of content) {
                if (part.type === 'thinking' && (part.thinking || '').length === e.thinkingLen) {
                  console.log(`  thinking preview: ${(part.thinking || '').slice(0, 150)}`);
                  console.log(`  stopReason: ${obj.message.stopReason}`);
                  break;
                }
              }
            }
          }
        } catch (ex) { /* skip */ }
      }
      break;
    }
  }
}

// Generate HTML visualization
const html = generateHTML(results);
writeFileSync('/workspaces/base_pi/.pi/thinking_distribution.html', html);
console.log('\n=== HTML visualization written to .pi/thinking_distribution.html ===');

function generateHTML(results) {
  // Prepare data for Chart.js
  const termThinking = results.terminated.map(e => e.thinkingLen).filter(v => v >= 0);
  const succThinking = results.success.map(e => e.thinkingLen).filter(v => v >= 0);
  const termTokens = results.terminated.map(e => e.reasoningTokens).filter(v => v > 0);
  const succTokens = results.success.map(e => e.reasoningTokens).filter(v => v > 0);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Thinking Token Distribution — Pi/OpenRouter Sessions</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; background: #1a1a2e; color: #e0e0e0; }
  h1 { color: #e94560; }
  h2 { color: #0f3460; background: #16213e; padding: 10px; border-radius: 8px; }
  .chart-container { background: #16213e; padding: 20px; border-radius: 8px; margin: 20px 0; }
  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin: 20px 0; }
  .stat { background: #16213e; padding: 15px; border-radius: 8px; text-align: center; }
  .stat .value { font-size: 2em; font-weight: bold; color: #e94560; }
  .stat .label { color: #a0a0a0; font-size: 0.9em; }
  canvas { max-height: 400px; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #333; }
  th { background: #0f3460; color: #e94560; }
  tr:hover { background: #1a1a3e; }
  .error-row { color: #e94560; }
  .success-row { color: #4ecca3; }
</style>
</head>
<body>
<h1>🧠 Thinking Token Distribution — Pi/OpenRouter Sessions</h1>

<div class="summary">
  <div class="stat"><div class="value">${results.totalAssistantMessages}</div><div class="label">Total Assistant Messages</div></div>
  <div class="stat"><div class="value">${results.totalWithThinking}</div><div class="label">With Thinking Data</div></div>
  <div class="stat"><div class="value">${results.totalTerminated}</div><div class="label">Terminated (error/aborted)</div></div>
  <div class="stat"><div class="value">${results.totalSuccess}</div><div class="label">Successful</div></div>
  <div class="stat"><div class="value">${termWithThinking.length}</div><div class="label">Terminated with Thinking Content</div></div>
</div>

<h2>Thinking Length Distribution (chars)</h2>
<div class="chart-container">
  <canvas id="thinkingChart"></canvas>
</div>

<h2>Reasoning Token Count Distribution</h2>
<div class="chart-container">
  <canvas id="tokenChart"></canvas>
</div>

<h2>Terminated Messages with Thinking Content</h2>
<table>
  <tr><th>Session</th><th>Model</th><th>Thinking Chars</th><th>Text Chars</th><th>Reasoning Tokens</th><th>stopReason</th></tr>
  ${results.terminated.filter(e => e.thinkingLen > 0).slice(0, 50).map(e => `
    <tr class="error-row">
      <td>${e.sessionId}</td>
      <td>${e.model}</td>
      <td>${e.thinkingLen.toLocaleString()}</td>
      <td>${e.textLen.toLocaleString()}</td>
      <td>${e.reasoningTokens.toLocaleString()}</td>
      <td>${e.stopReason}</td>
    </tr>
  `).join('')}
</table>

<script>
const termThinking = ${JSON.stringify(termThinking)};
const succThinking = ${JSON.stringify(succThinking)};
const termTokens = ${JSON.stringify(termTokens)};
const succTokens = ${JSON.stringify(succTokens)};

// Helper to create histogram bins
function histogram(data, binSize) {
  if (data.length === 0) return { labels: [], counts: [] };
  const max = Math.max(...data);
  const bins = [];
  const counts = [];
  for (let i = 0; i <= max; i += binSize) {
    bins.push(i + '-' + (i + binSize));
    counts.push(data.filter(v => v >= i && v < i + binSize).length);
  }
  return { labels: bins, counts };
}

// Thinking length chart
const termHist = termThinking.length > 0 ? histogram(termThinking, 500) : { labels: [], counts: [] };
const succHist = succThinking.length > 0 ? histogram(succThinking, 500) : { labels: [], counts: [] };

new Chart(document.getElementById('thinkingChart'), {
  type: 'bar',
  data: {
    labels: termHist.labels,
    datasets: [
      { label: 'Terminated', data: termHist.counts, backgroundColor: 'rgba(233,69,96,0.7)' },
      { label: 'Successful', data: succHist.counts, backgroundColor: 'rgba(78,204,163,0.7)' }
    ]
  },
  options: {
    responsive: true,
    plugins: { title: { display: true, text: 'Thinking Length (chars)', color: '#e0e0e0' },
               legend: { labels: { color: '#e0e0e0' } } },
    scales: {
      x: { ticks: { color: '#a0a0a0', maxRotation: 45 }, grid: { color: '#333' } },
      y: { ticks: { color: '#a0a0a0' }, grid: { color: '#333' }, title: { display: true, text: 'Count', color: '#e0e0e0' } }
    }
  }
});

// Token count chart
const termTokenHist = termTokens.length > 0 ? histogram(termTokens, 100) : { labels: [], counts: [] };
const succTokenHist = succTokens.length > 0 ? histogram(succTokens, 100) : { labels: [], counts: [] };

new Chart(document.getElementById('tokenChart'), {
  type: 'bar',
  data: {
    labels: termTokenHist.labels,
    datasets: [
      { label: 'Terminated', data: termTokenHist.counts, backgroundColor: 'rgba(233,69,96,0.7)' },
      { label: 'Successful', data: succTokenHist.counts, backgroundColor: 'rgba(78,204,163,0.7)' }
    ]
  },
  options: {
    responsive: true,
    plugins: { title: { display: true, text: 'Reasoning Token Count', color: '#e0e0e0' },
               legend: { labels: { color: '#e0e0e0' } } },
    scales: {
      x: { ticks: { color: '#a0a0a0', maxRotation: 45 }, grid: { color: '#333' } },
      y: { ticks: { color: '#a0a0a0' }, grid: { color: '#333' }, title: { display: true, text: 'Count', color: '#e0e0e0' } }
    }
  }
});
</script>
</body>
</html>`;
}
