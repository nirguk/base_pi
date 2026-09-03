#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/workspaces/base_pi/.pi/llm-debug.sqlite');
const q = (sql) => db.prepare(sql).all();

// 1. Res completeness flags (fixed quoting)
console.log('=== Res 200 completeness flags ===');
for (const r of q(`
  SELECT has_done, has_message_stop, finish_reason, COUNT(*) n
  FROM artifacts WHERE kind='res' AND status=200
  GROUP BY 1,2,3 ORDER BY n DESC
`))
  console.log(JSON.stringify(r));

// 2. Res with parsed_chars stats
console.log('\n=== Res parsed_chars stats ===');
for (const r of q(`
  SELECT COUNT(*) n, AVG(parsed_chars) avg_parsed, MIN(parsed_chars) min_p, MAX(parsed_chars) max_p
  FROM artifacts WHERE kind='res' AND parsed_chars IS NOT NULL
`))
  console.log(JSON.stringify(r));

// 3. Res with parsed_chars > 0 but has_done=0 (partial streams?)
console.log('\n=== Res with parsed_chars but has_done=0 ===');
for (const r of q(`
  SELECT COUNT(*) n FROM artifacts
  WHERE kind='res' AND parsed_chars IS NOT NULL AND has_done=0
`))
  console.log('count:', r.n);

// 4. Res with parsed_chars > 0 and has_done=1 (complete streams)
console.log('\n=== Res with parsed_chars and has_done=1 ===');
for (const r of q(`
  SELECT COUNT(*) n FROM artifacts
  WHERE kind='res' AND parsed_chars IS NOT NULL AND has_done=1
`))
  console.log('count:', r.n);

// 5. Check if error artifacts for terminated streams have any partial data in err_extra
console.log('\n=== Terminated error err_extra (sample) ===');
for (const r of q(`
  SELECT session_id, seq, err_extra FROM artifacts
  WHERE kind='error' AND status=200 AND err_message='terminated' AND err_extra IS NOT NULL
  LIMIT 5
`))
  console.log(r.session_id.slice(0,8), 'seq', r.seq, '|', (r.err_extra||'').slice(0,200));

// 6. Check the 4 res with has_done=1 AND has_message_stop=1
console.log('\n=== Res with both done+message_stop ===');
for (const r of q(`
  SELECT session_id, seq, model, body_chars, parsed_chars, finish_reason
  FROM artifacts WHERE kind='res' AND has_done=1 AND has_message_stop=1
`))
  console.log(JSON.stringify(r));

// 7. For terminated errors, what's the body_chars distribution? (all ~3072-3073, confirming empty body)
console.log('\n=== Terminated error body_chars distribution ===');
for (const r of q(`
  SELECT MIN(body_chars) min_bc, MAX(body_chars) max_bc, AVG(body_chars) avg_bc,
         COUNT(DISTINCT body_chars) distinct_bc
  FROM artifacts WHERE kind='error' AND status=200 AND err_message='terminated'
`))
  console.log(JSON.stringify(r));

// 8. Check if any error artifacts have non-null sample or tail
console.log('\n=== Terminated errors with sample/tail ===');
for (const r of q(`
  SELECT COUNT(*) n,
    SUM(CASE WHEN sample IS NOT NULL THEN 1 ELSE 0 END) with_sample,
    SUM(CASE WHEN tail IS NOT NULL THEN 1 ELSE 0 END) with_tail
  FROM artifacts WHERE kind='error' AND status=200 AND err_message='terminated'
`))
  console.log(JSON.stringify(r));

// 9. Look at the req artifacts for terminated error sessions - do they have reasoning in the body?
// The req body is stored as a file on disk, not in the DB. But body_chars tells us the size.
// Let's check if we can find the req file and grep for reasoning.
console.log('\n=== Checking req files for reasoning field ===');
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const artifactDir = '/workspaces/base_pi/.pi/pi-llm-debugging';
const rows = q(`
  SELECT r.session_id, r.seq, r.model
  FROM artifacts r
  JOIN artifacts e ON r.session_id=e.session_id AND r.seq=e.seq
  WHERE e.kind='error' AND e.status=200 AND e.err_message='terminated'
  AND r.kind='req' AND r.model LIKE '%deepseek%'
  LIMIT 3
`);
for (const r of rows) {
  const reqFile = join(artifactDir, r.session_id, `${r.seq}-req.json`);
  if (existsSync(reqFile)) {
    const text = readFileSync(reqFile, 'utf8');
    const hasReasoning = text.includes('"reasoning"');
    const reasoningMatch = text.match(/"reasoning":\s*(\{[^}]*\}|"[^"]*")/);
    console.log(r.model, '| has_reasoning:', hasReasoning, '| match:', reasoningMatch?.[1]?.slice(0,100));
  }
}

// 10. For the deepseek terminated errors, check the corresponding req files for reasoning effort
console.log('\n=== Req reasoning for deepseek terminated sessions ===');
const deepseekTerminated = q(`
  SELECT r.session_id, r.seq, r.model
  FROM artifacts r
  JOIN artifacts e ON r.session_id=e.session_id AND r.seq=e.seq
  WHERE e.kind='error' AND e.status=200 AND e.err_message='terminated'
  AND r.kind='req' AND r.model LIKE '%deepseek%'
  LIMIT 5
`);
for (const r of deepseekTerminated) {
  const reqFile = join(artifactDir, r.session_id, `${r.seq}-req.json`);
  if (existsSync(reqFile)) {
    const text = readFileSync(reqFile, 'utf8');
    const reasoningMatch = text.match(/"reasoning":\s*(\{[^}]*\}|"[^"]*")/);
    console.log(r.session_id.slice(0,8), 'seq', r.seq, '| reasoning:', JSON.stringify(reasoningMatch?.[1]?.slice(0,120)));
  }
}

// 11. Check if res artifacts exist for sessions that have terminated errors (same session_id, different seq)
console.log('\n=== Res artifacts in sessions with terminated errors ===');
for (const r of q(`
  SELECT DISTINCT r.session_id, r.seq, r.model, r.body_chars, r.parsed_chars, r.has_done
  FROM artifacts r
  JOIN artifacts e ON r.session_id=e.session_id
  WHERE e.kind='error' AND e.status=200 AND e.err_message='terminated'
  AND r.kind='res' AND r.seq != e.seq
  LIMIT 10
`))
  console.log(JSON.stringify(r));

// 12. Check the err_extra field for terminated errors - what extra info is captured?
console.log('\n=== Terminated error err_extra (sample) ===');
for (const r of q(`
  SELECT err_extra FROM artifacts
  WHERE kind='error' AND status=200 AND err_message='terminated' AND err_extra IS NOT NULL
  LIMIT 3
`))
  console.log(r.err_extra?.slice(0,300));
