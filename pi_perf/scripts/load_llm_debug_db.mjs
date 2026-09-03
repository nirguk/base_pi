#!/usr/bin/env node
/**
 * Load .pi/pi-llm-debugging artifacts into SQLite WITHOUT storing full bodies.
 * Stores: lengths, small samples, flags (stream completeness), model, counts.
 * Usage: node load_llm_debug_db.mjs [artifactDir] [dbPath]
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const [aDir, dbPathArg] = process.argv.slice(2);
const cwd = process.cwd();
const artifactDir = resolve(aDir ?? join(cwd, '.pi', 'pi-llm-debugging'));
const dbPath = resolve(dbPathArg ?? join(cwd, '.pi', 'llm-debug.sqlite'));
if (!existsSync(artifactDir)) { console.error('not found:', artifactDir); process.exit(1); }

const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = DELETE;
  CREATE TABLE IF NOT EXISTS artifacts (
    session_id  TEXT, seq INTEGER, kind TEXT, file TEXT, mtime TEXT,
    url TEXT, method TEXT, ok INTEGER, status INTEGER, status_text TEXT,
    model TEXT, content_type TEXT, headers TEXT,
    body_chars INTEGER, parsed_chars INTEGER,
    sample TEXT, tail TEXT,
    has_done INTEGER, has_message_stop INTEGER, finish_reason TEXT,
    n_messages INTEGER, n_tools INTEGER,
    err_name TEXT, err_message TEXT, err_cause TEXT, err_extra TEXT,
    PRIMARY KEY (session_id, seq, kind)
  );
  CREATE INDEX IF NOT EXISTS idx_status ON artifacts(status);
  CREATE INDEX IF NOT EXISTS idx_kind   ON artifacts(kind);
  CREATE INDEX IF NOT EXISTS idx_model  ON artifacts(model);
  CREATE INDEX IF NOT EXISTS idx_url    ON artifacts(url);
  CREATE INDEX IF NOT EXISTS idx_err    ON artifacts(err_name);
  CREATE INDEX IF NOT EXISTS idx_mtime  ON artifacts(mtime);
`);
db.exec('DELETE FROM artifacts');

const rows = [];
const t0 = Date.now();

// --- cheap extractors for REQ (avoid parsing 1GB) ---
function reqModel(body) { const m = body.match(/"model":\s*"([^"]{1,140})"/); return m ? m[1] : null; }
function countOccurrences(s, pat) { let c = 0, i = -1; while ((i = s.indexOf(pat, i + 1)) !== -1) c++; return c; }

for (const s of readdirSync(artifactDir, { withFileTypes: true })) {
  if (!s.isDirectory()) continue;
  const sid = s.name;
  for (const f of readdirSync(join(artifactDir, sid))) {
    if (!f.endsWith('.json')) continue;
    let kind = f.includes('-error.json') ? 'error'
             : f.includes('-res-meta.json') ? 'meta'
             : f.includes('-res.json') ? 'res'
             : f.includes('-req.json') ? 'req' : null;
    if (!kind) continue;
    const seq = parseInt(f.split('-')[0], 10);
    if (Number.isNaN(seq)) continue;
    const file = join(artifactDir, sid, f);
    const mtime = statSync(file).mtime.toISOString();
    let text;
    try { text = readFileSync(file, 'utf8'); } catch (e) { console.warn('read fail', file); continue; }

    let j = null;
    if (kind !== 'req') { try { j = JSON.parse(text); } catch { j = null; } }

    const row = {
      session_id: sid, seq, kind, file, mtime,
      url: j ? (j.url ?? null) : null,
      method: j ? (j.method ?? null) : null,
      ok: j ? (typeof j.ok === 'boolean' ? (j.ok ? 1 : 0) : null) : null,
      status: j ? (Number.isFinite(j.status) ? j.status : null) : null,
      status_text: j ? (typeof j.statusText === 'string' ? j.statusText : null) : null,
      content_type: j ? (j.headers?.['content-type'] ?? null) : null,
      headers: j && j.headers != null ? (() => { try { const s = JSON.stringify(j.headers); return typeof s === 'string' ? s : null; } catch { return null; } })() : null,
      body_chars: text.length,
      parsed_chars: j && j.parsedBody != null ? JSON.stringify(j.parsedBody).length : null,
      sample: null, tail: null,
      has_done: null, has_message_stop: null, finish_reason: null,
      n_messages: null, n_tools: null,
      err_name: null, err_message: null, err_cause: null, err_extra: null,
      model: null,
    };
    if (kind === 'req') {
      row.model = reqModel(text);
      row.n_messages = countOccurrences(text, '"role":');
      const tfn = countOccurrences(text, '"type": "function"');
      row.n_tools = tfn + countOccurrences(text, '"type":"function"');
      row.sample = null; // too big
    } else {
      if (j) {
        const e = j.error ?? null;
        if (e) {
          row.err_name = typeof e.name === 'string' ? e.name : null;
          row.err_message = typeof e.message === 'string' ? e.message : null;
          if (typeof e.cause === 'string') row.err_cause = e.cause;
          else if (e.cause) row.err_cause = JSON.stringify(e.cause).slice(0, 300);
          const extra = {};
          if (e && typeof e === 'object') for (const [k, v] of Object.entries(e))
            if (!['name', 'message', 'stack', 'cause'].includes(k)) extra[k] = v;
          row.err_extra = Object.keys(extra).length ? JSON.stringify(extra).slice(0, 300) : null;
        }
        row.sample = (typeof j.body === 'string' ? j.body : '').slice(0, 300) || null;
        if (kind === 'res') {
          const b = typeof j.body === 'string' ? j.body : '';
          row.tail = b.slice(-250) || null;
          row.has_done = b.includes('data: [DONE]') ? 1 : 0;
          row.has_message_stop = b.includes('message_stop') ? 1 : 0;
          const fr = b.match(/"finish_reason":\s*"([a-z_]+)"/g);
          row.finish_reason = fr ? fr[fr.length - 1].match(/"([a-z_]+)"/)[1] : null;
        }
      }
    }
    rows.push(row);
  }
}

const ins = db.prepare(`INSERT OR REPLACE INTO artifacts (
  session_id, seq, kind, file, mtime, url, method, ok, status, status_text,
  model, content_type, headers, body_chars, parsed_chars, sample, tail,
  has_done, has_message_stop, finish_reason, n_messages, n_tools,
  err_name, err_message, err_cause, err_extra
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
db.exec('BEGIN');
for (const r of rows) ins.run(r.session_id, r.seq, r.kind, r.file, r.mtime, r.url,
  r.method, r.ok, r.status, r.status_text, r.model, r.content_type, r.headers, r.body_chars,
  r.parsed_chars, r.sample, r.tail, r.has_done, r.has_message_stop, r.finish_reason,
  r.n_messages, r.n_tools, r.err_name, r.err_message, r.err_cause, r.err_extra);
db.exec('COMMIT');

console.log(`Loaded ${rows.length} artifacts from ${readdirSync(artifactDir, {withFileTypes:true}).filter(d=>d.isDirectory()).length} sessions in ${((Date.now()-t0)/1000).toFixed(1)}s -> ${dbPath}`);
console.log('  kinds:', JSON.stringify(rows.reduce((m, r) => (m[r.kind] = (m[r.kind] ?? 0) + 1, m), {})));
console.log(`  DB size: ${(statSync(dbPath).size / 1024).toFixed(0)} KB`);
db.close();