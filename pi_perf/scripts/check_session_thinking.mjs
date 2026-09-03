#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const db = new DatabaseSync('/workspaces/base_pi/.pi/llm-debug.sqlite');
const q = (sql) => db.prepare(sql).all();

// Get session IDs that had terminated errors, along with their req model info
const terminatedSessions = q(`
  SELECT DISTINCT e.session_id, r.model, e.seq as term_seq
  FROM artifacts e
  JOIN artifacts r ON e.session_id=r.session_id AND e.seq=r.seq AND r.kind='req'
  WHERE e.kind='error' AND e.status=200 AND e.err_message='terminated'
  LIMIT 5
`);

const sessionDir = '/root/.pi/agent/sessions/--workspaces-base_pi--';
const sessionFiles = readdirSync(sessionDir);

for (const s of terminatedSessions) {
  const sid = s.session_id;
  console.log('=== Session:', sid.slice(0, 12), 'model:', s.model, 'term_seq:', s.termSeq, '===');

  // Find matching session file
  const matchingFile = sessionFiles.find(f => f.includes(sid.slice(0, 8)));
  if (!matchingFile) { console.log('  No session file found'); continue; }

  const sessionFile = join(sessionDir, matchingFile);
  const content = readFileSync(sessionFile, 'utf8');
  const lines = content.split('\n').filter(l => l.trim());

  // Find assistant messages
  let msgCount = 0;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'message' && obj.message?.role === 'assistant') {
        msgCount++;
        const msg = obj.message;
        const content = msg.content;
        const usage = msg.usage || {};

        // Check for thinking parts
        const thinkingParts = Array.isArray(content) ? content.filter(p => p.type === 'thinking') : [];
        const textParts = Array.isArray(content) ? content.filter(p => p.type === 'text') : [];

        console.log(`  Message #${msgCount}:`);
        console.log(`    Thinking parts: ${thinkingParts.length}`);
        if (thinkingParts.length > 0) {
          const thinking = thinkingParts[0].thinking || '';
          console.log(`    Thinking length: ${thinking.length} chars`);
          console.log(`    Thinking preview: ${thinking.slice(0, 200)}`);
        }
        console.log(`    Text parts: ${textParts.length}`);
        if (textParts.length > 0) {
          const text = textParts.map(p => p.text || '').join('');
          console.log(`    Text length: ${text.length} chars`);
          console.log(`    Text preview: ${text.slice(0, 200)}`);
        }
        console.log(`    Usage: input=${usage.input}, output=${usage.output}, reasoning=${usage.reasoning}`);
        console.log(`    stopReason: ${msg.stopReason}`);
        console.log();
      }
    } catch (e) { /* skip malformed lines */ }
  }
}
