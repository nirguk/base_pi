const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[2] ?? '/workspaces/base_pi/.pi/llm-debug.sqlite');
const q = (sql) => db.prepare(sql).all();
const pad = (s, n) => String(s ?? '').padEnd(n);

console.log('=== 1. error artifacts: err name/message top ===');
for (const r of q(`SELECT COALESCE(err_name,'?') en, substr(COALESCE(err_message,'?'),1,70) em, COUNT(*) n
                   FROM artifacts WHERE kind='error' GROUP BY 1,2 ORDER BY n DESC LIMIT 12`))
  console.log(String(r.n).padStart(5), '|', pad(r.en, 12), '|', r.em);

console.log('\n=== 2. 404s by url shape ===');
for (const r of q(`SELECT CASE WHEN url LIKE '%generation%' THEN 'generation_endpoint' ELSE COALESCE(url,'?') END u,
                          kind, method, COUNT(*) n FROM artifacts WHERE status=404 GROUP BY 1,kind,method ORDER BY n DESC`))
  console.log(String(r.n).padStart(5), '|', pad(r.u, 24), '|', pad(r.kind,5), '|', r.method);

console.log('\n=== 3. 429 error bodies ===');
for (const r of q(`SELECT substr(COALESCE(sample,err_message,''),1,180) s, COUNT(*) n
                   FROM artifacts WHERE kind='error' AND status=429 GROUP BY 1 ORDER BY n DESC LIMIT 6`))
  console.log(String(r.n).padStart(4), '|', r.s.replace(/\n/g, ' '));

console.log('\n=== 4. res kind: stream completeness on 200s ===');
for (const r of q(`SELECT status, has_done, has_message_stop, finish_reason, COUNT(*) n
                   FROM artifacts WHERE kind='res' AND status IN (200,404,429,401) GROUP BY 1,2,3,4 ORDER BY n DESC LIMIT 14`))
  console.log(String(r.n).padStart(5), '| status', pad(r.status,4), '| done', pad(r.has_done,2), '| msg_stop', pad(r.has_message_stop,2), '| finish', pad(r.finish_reason,14));

console.log('\n=== 5. res 200 with NO message_stop (mid-stream cut candidates) ===');
const cut = q(`SELECT session_id, seq, body_chars, has_done, finish_reason, tail FROM artifacts
               WHERE kind='res' AND status=200 AND has_message_stop=0 AND body_chars>0`);
console.log('count:', cut.length);
for (const r of cut.slice(0, 5)) console.log(r.session_id.slice(0,8), 'seq', r.seq, 'chars', r.body_chars, 'done', r.has_done, 'finish', r.finish_reason, 'tail:', JSON.stringify((r.tail||'').slice(-100)));

console.log('\n=== 6. calls with req but NO res/error (aborted early / no completion) ===');
const orphans = q(`SELECT a.session_id, a.seq, a.model, a.body_chars
                   FROM artifacts a WHERE a.kind='req' AND NOT EXISTS (
                     SELECT 1 FROM artifacts b WHERE b.session_id=a.session_id AND b.seq=a.seq AND b.kind IN ('res','error'))
                   LIMIT 12`);
console.log('orphan count row check...');
const orphanCount = db.prepare(`SELECT COUNT(*) n FROM artifacts a WHERE a.kind='req' AND NOT EXISTS (
  SELECT 1 FROM artifacts b WHERE b.session_id=a.session_id AND b.seq=a.seq AND b.kind IN ('res','error'))`).get();
console.log('orphans total:', orphanCount.n);
for (const r of orphans) console.log(r.session_id.slice(0,8), 'seq', r.seq, 'model', (r.model||'').slice(0,40), 'chars', r.body_chars);

console.log('\n=== 7. error artifacts by model ===');
for (const r of q(`SELECT COALESCE(model,'?') m, COUNT(*) n FROM artifacts WHERE kind='error' GROUP BY 1 ORDER BY n DESC LIMIT 10`))
  console.log(String(r.n).padStart(5), '|', r.m);

console.log('\n=== 8. error artifacts: status 200 with non-empty sample (streamed then died) ===');
const died = q(`SELECT COUNT(*) n, SUM(CASE WHEN body_chars>10 THEN 1 ELSE 0 END) with_body FROM artifacts WHERE kind='error' AND status=200`);
console.log('200-error total:', died[0].n, '| with body >10 chars:', died[0].with_body);

console.log('\n=== 9. err_message for the 200/transport errors (full) ===');
for (const r of q(`SELECT substr(COALESCE(err_message,'?'),1,120) em, COUNT(*) n FROM artifacts WHERE kind='error' AND status IS NULL AND err_message IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 8`))
  console.log(String(r.n).padStart(5), '|', r.em);
for (const r of q(`SELECT substr(COALESCE(err_message,'?'),1,120) em, COUNT(*) n FROM artifacts WHERE kind='error' AND status=200 GROUP BY 1 ORDER BY n DESC LIMIT 8`))
  console.log(String(r.n).padStart(5), '| 200:', r.em);

console.log('\n=== 10. error 404 generation: when + which session pattern ===');
for (const r of q(`SELECT substr(mtime,1,13) hr, COUNT(*) n FROM artifacts WHERE kind='error' AND status=404 GROUP BY 1 ORDER BY 1 DESC LIMIT 10`))
  console.log(r.hr, r.n);