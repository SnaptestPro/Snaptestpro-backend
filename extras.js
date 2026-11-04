'use strict';
/**
 * SnapTestPro backend v2.2 — EXTRAS (sab kuch naya, purane routes ka behavior nahi badla)
 *
 *  1. Admin API  (/api/admin/*)   — sirf owner/super-admin: overview, data browser, export/import, users, rules, files, audit
 *  2. Projects   (X-Api-Key)      — dusre log apna alag "backend" use kar sakte hain (alag data, alag users, alag rules, limits)
 *  3. Project users (/api/p/auth) — har project ke apne end-users (main users se bilkul alag)
 *  4. Usage + audit log           — kaun kitna use kar raha hai, admin ne kya badla
 *  5. Dashboard (/dashboard) + SDK (/sdk/snaptestpro-sdk.js)
 *
 * Speed: har project/key lookup memory cache se (60s), usage sirf memory me ginta hai aur 30s me ek baar DB me likhta hai.
 */
const crypto = require('crypto');
const path = require('path');
const bcrypt = require('bcryptjs');
const express = require('express');
const rateLimit = require('express-rate-limit');

const LEVELS = ['public', 'auth', 'owner', 'admin', 'none'];
const RESERVED = /^p([0-9a-f]{8})__/;       // project ke collections ka internal naam: p<8hex>__<naam>
const PREFIX_LEN = 11;                       // 'p' + 8 + '__'
const MAX_USER_COLLECTION = 50;              // 64 - 11 (prefix) - thoda margin
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const likeEsc = s => String(s).replace(/[\\%_]/g, c => '\\' + c);
const int = (v, def, min, max) => Math.min(Math.max(parseInt(v, 10) || def, min), max);
const DENY_ALL = { default: { read: 'none', write: 'none' }, collections: {} };

module.exports = function createExtras(ctx) {
  const { db, wrap, HttpError } = ctx;

  // ------------------------------------------------------------ schema
  async function initSchema() {
    await db.query(`
      CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        owner_email TEXT,
        admin_emails TEXT[] NOT NULL DEFAULT '{}',
        api_key_hash TEXT UNIQUE NOT NULL,
        admin_key_hash TEXT UNIQUE NOT NULL,
        key_hint TEXT,
        rules JSONB NOT NULL DEFAULT '{}',
        origins TEXT[] NOT NULL DEFAULT '{}',
        active BOOLEAN NOT NULL DEFAULT TRUE,
        max_docs INT NOT NULL DEFAULT 20000,
        max_users INT NOT NULL DEFAULT 1000,
        rate_per_min INT NOT NULL DEFAULT 300,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS project_users (
        id SERIAL PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        uid TEXT UNIQUE NOT NULL,
        email TEXT NOT NULL,
        password TEXT NOT NULL,
        name TEXT,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (project_id, email)
      );
      CREATE TABLE IF NOT EXISTS usage_daily (
        scope TEXT NOT NULL, day DATE NOT NULL,
        requests INT NOT NULL DEFAULT 0, writes INT NOT NULL DEFAULT 0, errors INT NOT NULL DEFAULT 0,
        PRIMARY KEY (scope, day)
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        actor TEXT, action TEXT NOT NULL, target TEXT, detail JSONB
      );
      CREATE INDEX IF NOT EXISTS idx_documents_prefix ON documents (collection_name text_pattern_ops);
    `);
    await loadRulesOverride();
    await refreshOrigins();
  }

  // ------------------------------------------------------------ rules (DB me save, taaki Render restart par na jaye)
  function normalizeRules(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new HttpError(400, 'rules ek JSON object hona chahiye');
    const out = { default: { read: 'owner', write: 'owner' }, collections: {} };
    const lvl = (v, where) => { if (!LEVELS.includes(v)) throw new HttpError(400, `${where}: "${v}" sahi level nahi (${LEVELS.join(' | ')})`); return v; };
    if (r.default) {
      out.default = { read: lvl(r.default.read || 'owner', 'default.read'), write: lvl(r.default.write || 'owner', 'default.write') };
    }
    const cols = r.collections || {};
    if (typeof cols !== 'object' || Array.isArray(cols)) throw new HttpError(400, 'collections object hona chahiye');
    for (const name of Object.keys(cols)) {
      if (!NAME_RE.test(name) || name.length > MAX_USER_COLLECTION) throw new HttpError(400, `collection naam galat: ${name}`);
      const c = cols[name] || {};
      out.collections[name] = { read: lvl(c.read || out.default.read, name + '.read'), write: lvl(c.write || out.default.write, name + '.write') };
      if (c.createdByGuard) out.collections[name].createdByGuard = true;
    }
    return out;
  }
  async function loadRulesOverride() {
    if (process.env.IGNORE_DB_RULES === 'true') return;
    const r = await db.query("SELECT value FROM app_config WHERE key='rules'");
    if (r.rows[0]) { try { ctx.setRules(normalizeRules(r.rows[0].value)); statsRulesSource = 'database'; } catch (e) { console.warn('DB rules ignore:', e.message); } }
  }

  // sync: server.js ka rule()/guardOk() isse use karta hai
  function rulesFor(collection, mainRules) {
    const m = RESERVED.exec(collection);
    if (!m) return { R: mainRules, key: collection };
    const p = projById.get(m[1]);
    return { R: p ? p.rulesObj : DENY_ALL, key: collection.slice(PREFIX_LEN) };
  }
  const displayName = c => (RESERVED.test(c) ? c.slice(PREFIX_LEN) : c);
  const isReserved = c => RESERVED.test(String(c || ''));

  // ------------------------------------------------------------ projects cache
  const projByHash = new Map();   // apiKeyHash -> { p, t }
  const projById = new Map();     // id -> project
  let allowedOrigins = new Set(); // saare active projects ke origins (CORS ke liye)

  function buildProject(row) {
    const old = projById.get(row.id);
    let rulesObj;
    try { rulesObj = normalizeRules(row.rules && Object.keys(row.rules).length ? row.rules : {}); } catch { rulesObj = DENY_ALL; }
    const p = {
      id: row.id, name: row.name, active: row.active, ownerEmail: row.owner_email, adminEmails: row.admin_emails || [],
      origins: row.origins || [], rulesObj, adminKeyHash: row.admin_key_hash, maxDocs: row.max_docs, maxUsers: row.max_users,
      rate: row.rate_per_min, prefix: 'p' + row.id + '__',
      _win: old ? old._win : { t: 0, n: 0 }, _docs: old ? old._docs : 0, _docsAt: old ? old._docsAt : 0
    };
    projById.set(p.id, p);
    return p;
  }
  async function lookupProject(key) {
    const h = sha(key);
    const c = projByHash.get(h);
    if (c && Date.now() - c.t < (c.p ? 60000 : 10000)) return c.p;
    const r = await db.query('SELECT * FROM projects WHERE api_key_hash=$1', [h]);
    const p = r.rows[0] ? buildProject(r.rows[0]) : null;
    if (projByHash.size > 5000) projByHash.clear(); // random keys se memory na bhare
    projByHash.set(h, { p, t: Date.now() });
    return p;
  }
  async function loadProjectById(id) {
    const r = await db.query('SELECT * FROM projects WHERE id=$1', [id]);
    return r.rows[0] ? buildProject(r.rows[0]) : null;
  }
  async function refreshOrigins() {
    const r = await db.query('SELECT origins FROM projects WHERE active');
    allowedOrigins = new Set(r.rows.flatMap(x => x.origins || []));
  }
  function invalidateProjects() { projByHash.clear(); projById.clear(); refreshOrigins().catch(() => {}); statsAt = 0; }
  const originAllowed = o => allowedOrigins.has(o);
  const timer = setInterval(() => { refreshOrigins().catch(() => {}); }, 60000); timer.unref();

  // ------------------------------------------------------------ usage (memory me gino, 30s me ek baar DB)
  const usage = new Map();
  function tick(scope, write) { const u = usage.get(scope) || { r: 0, w: 0, e: 0 }; u.r++; if (write) u.w++; usage.set(scope, u); return u; }
  async function flushUsage() {
    if (!usage.size) return;
    const rows = Array.from(usage); usage.clear();
    for (const [scope, u] of rows) {
      await db.query(`INSERT INTO usage_daily (scope, day, requests, writes, errors) VALUES ($1, CURRENT_DATE, $2, $3, $4)
        ON CONFLICT (scope, day) DO UPDATE SET requests = usage_daily.requests + EXCLUDED.requests,
        writes = usage_daily.writes + EXCLUDED.writes, errors = usage_daily.errors + EXCLUDED.errors`, [scope, u.r, u.w, u.e]).catch(() => {});
    }
  }
  const utimer = setInterval(flushUsage, 30000); utimer.unref();

  const audit = (req, action, target, detail) => {
    const actor = req && req.user ? (req.user.email || req.user.uid) : null;
    db.query('INSERT INTO audit_log (actor, action, target, detail) VALUES ($1,$2,$3,$4)', [actor, action, target || null, detail ? JSON.stringify(detail) : null]).catch(() => {});
  };

  // ------------------------------------------------------------ project user (token payload -> user object)
  const projectUser = t => ({ id: null, uid: t.uid, email: t.email, own: true, role: t.role === 'admin' ? 'admin' : 'user', superAdmin: false, pid: t.pid });

  // ------------------------------------------------------------ MIDDLEWARE (authMw ke baad)
  const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const PROJECT_PATHS = /^\/(collections\/|batch$|p\/|ping$)/;
  function bodyHasReserved(body) { return !!(body && Array.isArray(body.ops) && body.ops.some(o => o && isReserved(o.collection))); }

  async function docCount(p) {
    if (Date.now() - p._docsAt > 60000) {
      const r = await db.query("SELECT COUNT(*)::int c FROM documents WHERE collection_name LIKE $1 ESCAPE '\\'", [likeEsc(p.prefix) + '%']);
      p._docs = r.rows[0].c; p._docsAt = Date.now();
    }
    return p._docs;
  }

  const projectMw = wrap(async (req, res, next) => {
    const key = req.get('x-api-key');
    if (!key) {
      tick('main', WRITE_METHODS.has(req.method));
      if (req.user && req.user.pid) req.user = null;        // project ka token main API me bekaar hai
      // project ke internal collections par sirf owner jaa sakta hai
      const m = /^\/collections\/([^/?]+)/.exec(req.url);
      let dn = ''; if (m) { try { dn = decodeURIComponent(m[1]); } catch { dn = ''; } }
      if ((m && isReserved(dn)) || bodyHasReserved(req.body)) {
        if (!(req.user && ctx.isOwnerUser(req.user))) return res.status(403).json({ error: 'Ye collection kisi project ka hai' });
      }
      return next();
    }
    const p = await lookupProject(key);
    if (!p || !p.active) return res.status(401).json({ error: 'API key galat hai ya project band hai' });
    const origin = req.get('origin');
    if (origin && p.origins.length && !p.origins.includes(origin)) return res.status(403).json({ error: 'Is website ka origin is project me allowed nahi hai' });
    // rate limit (per project, per minute)
    const now = Date.now();
    if (now - p._win.t > 60000) { p._win.t = now; p._win.n = 0; }
    if (++p._win.n > p.rate) { res.set('Retry-After', '30'); return res.status(429).json({ error: 'Project ki per-minute limit pura ho gayi' }); }
    const isWrite = WRITE_METHODS.has(req.method);
    const u = tick(p.id, isWrite);
    res.on('finish', () => { if (res.statusCode >= 500) u.e++; });

    if (!PROJECT_PATHS.test(req.url.split('?')[0])) return res.status(404).json({ error: 'Ye endpoint project API me nahi hai' });

    // identity: sirf project ka apna token ya X-Admin-Key (server-side secret)
    const ak = req.get('x-admin-key');
    if (ak) {
      if (sha(ak) !== p.adminKeyHash) return res.status(401).json({ error: 'Admin key galat hai' });
      req.user = { id: null, uid: 'padmin:' + p.id, email: p.ownerEmail || null, own: true, role: 'admin', superAdmin: false, pid: p.id, projectAdmin: true };
    } else if (!(req.user && req.user.own && req.user.pid === p.id)) req.user = null;
    req.project = p;

    // collection naam ko project ke prefix ke saath badlo
    const bad = n => !NAME_RE.test(n) || n.length > MAX_USER_COLLECTION;
    const m = /^\/collections\/([^/?]+)/.exec(req.url);
    if (m) {
      let c; try { c = decodeURIComponent(m[1]); } catch { c = ''; }
      if (bad(c)) return res.status(400).json({ error: 'Invalid collection name (max ' + MAX_USER_COLLECTION + ' akshar: A-Z a-z 0-9 _ -)' });
      req.url = req.url.replace(/^\/collections\/[^/?]+/, '/collections/' + p.prefix + c);
    }
    if (req.url.split('?')[0] === '/batch' && req.body && Array.isArray(req.body.ops)) {
      for (const o of req.body.ops) {
        if (!o || typeof o.collection !== 'string' || bad(o.collection)) return res.status(400).json({ error: 'Batch me collection naam galat hai' });
        o.collection = p.prefix + o.collection;
      }
    }
    // document limit (sirf naya likhne par; delete hamesha chalta hai)
    const creating = req.url.startsWith('/collections/') && (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT');
    const batchWrites = req.url.split('?')[0] === '/batch' && req.body && Array.isArray(req.body.ops) && req.body.ops.some(o => o.type !== 'delete');
    if (creating || batchWrites) {
      if (await docCount(p) >= p.maxDocs) return res.status(403).json({ error: 'Project ki document limit (' + p.maxDocs + ') pura ho gayi', code: 'quota-docs' });
    }
    next();
  });

  // ------------------------------------------------------------ socket.io ke liye project scope
  async function scopeSocket({ apiKey, token, collection, origin }) {
    const p = await lookupProject(apiKey);
    if (!p || !p.active) return null;
    if (origin && p.origins.length && !p.origins.includes(origin)) return null;
    if (!NAME_RE.test(String(collection || '')) || collection.length > MAX_USER_COLLECTION) return null;
    const t = ctx.verifyToken(token);
    return { prefix: p.prefix, collection: p.prefix + collection, user: t && t.pid === p.id ? projectUser(t) : null };
  }

  // ------------------------------------------------------------ stats cache (full-table scan hai, isliye 30s cache)
  let statsCache = null, statsAt = 0;
  async function collectionStats() {
    if (statsCache && Date.now() - statsAt < 30000) return statsCache;
    const r = await db.query(`SELECT collection_name AS c, COUNT(*)::int AS n, COALESCE(SUM(pg_column_size(data)),0)::bigint AS bytes, MAX(updated_at) AS last
                              FROM documents GROUP BY collection_name ORDER BY collection_name`);
    statsCache = r.rows.map(x => ({ name: x.c, count: x.n, bytes: Number(x.bytes), last: x.last }));
    statsAt = Date.now();
    return statsCache;
  }

  // ------------------------------------------------------------ guards
  const requireSuper = (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Login required' });
    if (req.project || !ctx.isOwnerUser(req.user)) return res.status(403).json({ error: 'Sirf owner/super-admin (backend ke ADMIN_EMAILS wala account)' });
    next();
  };
  const projectPrefixOf = id => {
    if (id == null || id === '' || id === 'main') return '';
    if (!/^[0-9a-f]{8}$/.test(String(id))) throw new HttpError(400, 'project id galat hai');
    return 'p' + id + '__';
  };
  const scoped = (project, collection) => {
    if (!NAME_RE.test(String(collection || ''))) throw new HttpError(400, 'Invalid collection name');
    return projectPrefixOf(project) + collection;
  };

  const admin = express.Router();
  admin.use(requireSuper);

  // ---- overview
  admin.get('/overview', wrap(async (req, res) => {
    const t0 = Date.now();
    await db.query('SELECT 1');
    const dbMs = Date.now() - t0;
    const [users, files, size, stats, use, pu, projects] = await Promise.all([
      db.query('SELECT COUNT(*)::int c FROM users'), db.query('SELECT COUNT(*)::int c, COALESCE(SUM(size),0)::bigint s FROM file_storage'),
      db.query('SELECT pg_database_size(current_database())::bigint b'), collectionStats(),
      db.query("SELECT day::text, requests, writes, errors FROM usage_daily WHERE scope='main' AND day > CURRENT_DATE - 7 ORDER BY day"),
      db.query('SELECT COUNT(*)::int c FROM project_users'), db.query('SELECT COUNT(*)::int c FROM projects')]);
    const main = stats.filter(s => !isReserved(s.name));
    const mem = process.memoryUsage();
    res.json({
      success: true,
      overview: {
        users: users.rows[0].c, projectUsers: pu.rows[0].c, projects: projects.rows[0].c,
        documents: main.reduce((a, s) => a + s.count, 0), projectDocuments: stats.filter(s => isReserved(s.name)).reduce((a, s) => a + s.count, 0),
        files: files.rows[0].c, filesMB: Math.round(Number(files.rows[0].s) / 1048576 * 10) / 10,
        dbSizeMB: Math.round(Number(size.rows[0].b) / 1048576 * 10) / 10, dbLatencyMs: dbMs,
        uptimeSec: Math.round(process.uptime()), memoryMB: Math.round(mem.rss / 1048576), node: process.version,
        firebaseBridge: !!process.env.FIREBASE_PROJECT_ID, minBuild: parseInt(process.env.MIN_BUILD || '0', 10) || 0,
        rulesSource: statsRulesSource
      },
      collections: main, usage: use.rows
    });
  }));
  let statsRulesSource = 'file';

  // ---- data browser
  admin.get('/documents', wrap(async (req, res) => {
    const coll = scoped(req.query.project, req.query.collection);
    const q = String(req.query.q || '').trim();
    const limit = int(req.query.limit, 50, 1, 200), offset = int(req.query.offset, 0, 0, 1e7);
    const params = [coll]; let where = 'collection_name=$1';
    if (q) { params.push('%' + likeEsc(q) + '%'); where += ` AND (doc_id ILIKE $${params.length} OR data::text ILIKE $${params.length})`; }
    const total = offset === 0 ? (await db.query(`SELECT COUNT(*)::int c FROM documents WHERE ${where}`, params)).rows[0].c : null;
    const r = await db.query(`SELECT doc_id, data, owner_uid, created_at, updated_at FROM documents WHERE ${where} ORDER BY updated_at DESC, doc_id LIMIT ${limit} OFFSET ${offset}`, params);
    res.json({ success: true, total, docs: r.rows.map(d => ({ id: d.doc_id, data: d.data, ownerUid: d.owner_uid, createdAt: d.created_at, updatedAt: d.updated_at })) });
  }));
  admin.put('/documents/:collection/:docId', wrap(async (req, res) => {
    const coll = scoped(req.query.project, req.params.collection); ctx.checkDocId(req.params.docId);
    const { data, merge } = req.body || {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'data ek JSON object hona chahiye');
    const r = await db.query(`INSERT INTO documents (collection_name, doc_id, data) VALUES ($1,$2,$3::jsonb)
      ON CONFLICT (collection_name, doc_id) DO UPDATE SET data = ${merge ? 'documents.data || EXCLUDED.data' : 'EXCLUDED.data'}, updated_at = NOW() RETURNING *`,
      [coll, req.params.docId, JSON.stringify(data)]);
    statsAt = 0; ctx.broadcast(coll, r.rows[0], 'set'); audit(req, 'doc.set', coll + '/' + req.params.docId);
    res.json({ success: true });
  }));
  admin.delete('/documents/:collection/:docId', wrap(async (req, res) => {
    const coll = scoped(req.query.project, req.params.collection); ctx.checkDocId(req.params.docId);
    const r = await db.query('DELETE FROM documents WHERE collection_name=$1 AND doc_id=$2 RETURNING *', [coll, req.params.docId]);
    if (r.rows[0]) ctx.broadcast(coll, r.rows[0], 'delete');
    statsAt = 0; audit(req, 'doc.delete', coll + '/' + req.params.docId);
    res.json({ success: true });
  }));
  admin.delete('/collections/:collection', wrap(async (req, res) => {
    const coll = scoped(req.query.project, req.params.collection);
    if (req.query.confirm !== req.params.collection) throw new HttpError(400, 'confirm=<collection naam> chahiye');
    const r = await db.query('DELETE FROM documents WHERE collection_name=$1', [coll]);
    statsAt = 0; audit(req, 'collection.delete', coll, { deleted: r.rowCount });
    res.json({ success: true, deleted: r.rowCount });
  }));

  // ---- export / import (backup)
  admin.get('/export', wrap(async (req, res) => {
    const prefix = projectPrefixOf(req.query.project);
    let names;
    if (req.query.collection) names = [scoped(req.query.project, req.query.collection)];
    else {
      const r = prefix
        ? await db.query("SELECT DISTINCT collection_name c FROM documents WHERE collection_name LIKE $1 ESCAPE '\\' ORDER BY 1", [likeEsc(prefix) + '%'])
        : await db.query("SELECT DISTINCT collection_name c FROM documents WHERE collection_name !~ '^p[0-9a-f]{8}__' ORDER BY 1");
      names = r.rows.map(x => x.c);
    }
    res.set({ 'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="snaptestpro-backup-${req.query.collection || 'all'}-${new Date().toISOString().slice(0, 10)}.json"` });
    res.write(`{"version":1,"exportedAt":${JSON.stringify(new Date().toISOString())},"collections":{`);
    let firstC = true;
    for (const name of names) {
      res.write((firstC ? '' : ',') + JSON.stringify(name.slice(prefix.length)) + ':['); firstC = false;
      let last = '', first = true;
      for (;;) {
        const r = await db.query('SELECT doc_id, data, owner_uid, created_at, updated_at FROM documents WHERE collection_name=$1 AND doc_id > $2 ORDER BY doc_id LIMIT 1000', [name, last]);
        if (!r.rows.length) break;
        for (const d of r.rows) {
          res.write((first ? '' : ',') + JSON.stringify({ id: d.doc_id, data: d.data, ownerUid: d.owner_uid, createdAt: d.created_at, updatedAt: d.updated_at })); first = false;
        }
        last = r.rows[r.rows.length - 1].doc_id;
        if (r.rows.length < 1000) break;
      }
      res.write(']');
    }
    res.end('}}');
    audit(req, 'export', req.query.collection || 'all', { project: req.query.project || 'main' });
  }));
  admin.post('/import', wrap(async (req, res) => {
    const { collection, docs, merge } = req.body || {};
    const coll = scoped(req.query.project || (req.body || {}).project, collection);
    if (!Array.isArray(docs) || !docs.length || docs.length > 500) throw new HttpError(400, 'docs 1..500 hone chahiye (ek request me)');
    const ids = [], datas = [], owners = [], created = [];
    for (const d of docs) {
      if (!d || typeof d !== 'object') throw new HttpError(400, 'har doc {id, data} hona chahiye');
      ctx.checkDocId(d.id);
      if (!d.data || typeof d.data !== 'object' || Array.isArray(d.data)) throw new HttpError(400, 'doc ' + d.id + ': data object hona chahiye');
      ids.push(d.id); datas.push(JSON.stringify(d.data)); owners.push(d.ownerUid || null);
      created.push(d.createdAt && !isNaN(new Date(d.createdAt)) ? new Date(d.createdAt).toISOString() : null);
    }
    if (new Set(ids).size !== ids.length) throw new HttpError(400, 'is request me duplicate id hain');
    await db.query(`INSERT INTO documents (collection_name, doc_id, data, owner_uid, created_at)
      SELECT $1, t.id, t.data::jsonb, t.owner, COALESCE(t.created::timestamptz, NOW())
      FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS t(id, data, owner, created)
      ON CONFLICT (collection_name, doc_id) DO UPDATE SET data = ${merge ? 'documents.data || EXCLUDED.data' : 'EXCLUDED.data'}, updated_at = NOW()`,
      [coll, ids, datas, owners, created]);
    statsAt = 0; audit(req, 'import', coll, { docs: ids.length });
    res.json({ success: true, imported: ids.length });
  }));

  // ---- users (main backend ke users)
  admin.get('/users', wrap(async (req, res) => {
    const q = String(req.query.q || '').trim(), limit = int(req.query.limit, 50, 1, 200), offset = int(req.query.offset, 0, 0, 1e7);
    const params = []; let where = 'TRUE';
    if (q) { params.push('%' + likeEsc(q) + '%'); where = 'email ILIKE $1 OR name ILIKE $1'; }
    const [rows, total] = await Promise.all([
      db.query(`SELECT uid, email, name, role, created_at FROM users WHERE ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, params),
      db.query(`SELECT COUNT(*)::int c FROM users WHERE ${where}`, params)]);
    res.json({ success: true, total: total.rows[0].c, users: rows.rows });
  }));
  admin.patch('/users/:uid', wrap(async (req, res) => {
    const role = (req.body || {}).role;
    if (role !== 'admin' && role !== 'user') throw new HttpError(400, 'role admin ya user hona chahiye');
    const r = await db.query('SELECT uid, email FROM users WHERE uid=$1', [req.params.uid]);
    if (!r.rows[0]) throw new HttpError(404, 'User nahi mila');
    if (role === 'user' && req.user.uid === r.rows[0].uid) throw new HttpError(400, 'Apna khud ka admin role mat hatao');
    if (role === 'user' && ctx.ADMIN_EMAILS.includes(r.rows[0].email)) throw new HttpError(400, 'Ye email ADMIN_EMAILS me hai (login par wapas admin ban jayega). Pehle Render env se hatao.');
    await db.query('UPDATE users SET role=$1 WHERE uid=$2', [role, req.params.uid]);
    audit(req, 'user.role', r.rows[0].email, { role });
    res.json({ success: true });
  }));
  admin.post('/users/:uid/password', wrap(async (req, res) => {
    let pw = (req.body || {}).newPassword;
    const generated = !pw;
    if (generated) pw = crypto.randomBytes(6).toString('base64url');
    if (String(pw).length < 6) throw new HttpError(400, 'Password kam se kam 6 character ka ho');
    const r = await db.query('UPDATE users SET password=$1 WHERE uid=$2 RETURNING email', [await bcrypt.hash(String(pw), 10), req.params.uid]);
    if (!r.rows[0]) throw new HttpError(404, 'User nahi mila');
    audit(req, 'user.password', r.rows[0].email);
    res.json({ success: true, ...(generated ? { newPassword: pw } : {}) });
  }));
  admin.delete('/users/:uid', wrap(async (req, res) => {
    if (req.user.uid === req.params.uid) throw new HttpError(400, 'Khud ko delete nahi kar sakte');
    const r = await db.query('DELETE FROM users WHERE uid=$1 RETURNING email', [req.params.uid]);
    if (!r.rows[0]) throw new HttpError(404, 'User nahi mila');
    audit(req, 'user.delete', r.rows[0].email);
    res.json({ success: true });
  }));

  // ---- rules
  admin.get('/rules', wrap(async (req, res) => {
    const r = await db.query("SELECT updated_at FROM app_config WHERE key='rules'");
    res.json({ success: true, rules: ctx.getRules(), source: r.rows[0] && process.env.IGNORE_DB_RULES !== 'true' ? 'database' : 'file', updatedAt: r.rows[0] ? r.rows[0].updated_at : null });
  }));
  admin.put('/rules', wrap(async (req, res) => {
    const rules = normalizeRules((req.body || {}).rules);
    await db.query("INSERT INTO app_config (key, value) VALUES ('rules', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()", [JSON.stringify(rules)]);
    ctx.setRules(rules); statsRulesSource = 'database';
    audit(req, 'rules.set', 'main', { collections: Object.keys(rules.collections).length });
    res.json({ success: true, rules });
  }));
  admin.delete('/rules', wrap(async (req, res) => {
    await db.query("DELETE FROM app_config WHERE key='rules'");
    ctx.reloadRulesFile(); statsRulesSource = 'file';
    audit(req, 'rules.reset', 'main');
    res.json({ success: true, rules: ctx.getRules() });
  }));

  // ---- files (sab users ki)
  admin.get('/files', wrap(async (req, res) => {
    const r = await db.query(`SELECT f.file_id, f.filename, f.size, f.mimetype, f.stored_name, f.created_at, u.email
                              FROM file_storage f LEFT JOIN users u ON u.id = f.user_id ORDER BY f.created_at DESC LIMIT $1`, [int(req.query.limit, 100, 1, 500)]);
    res.json({ success: true, files: r.rows.map(f => ({ id: f.file_id, name: f.filename, size: f.size, type: f.mimetype, by: f.email, at: f.created_at, url: `${ctx.BASE_URL}/uploads/${f.stored_name}` })) });
  }));

  // ---- audit
  admin.get('/audit', wrap(async (req, res) => {
    const r = await db.query('SELECT id, at, actor, action, target, detail FROM audit_log ORDER BY id DESC LIMIT $1', [int(req.query.limit, 100, 1, 500)]);
    res.json({ success: true, log: r.rows });
  }));

  // ---- projects
  const cleanOrigins = arr => (Array.isArray(arr) ? arr : String(arr || '').split(/[\s,]+/)).map(s => String(s).trim().replace(/\/+$/, '')).filter(Boolean).map(o => {
    if (!/^(https?|capacitor|ionic):\/\/[^\/\s]+$/i.test(o)) throw new HttpError(400, 'Origin galat: ' + o + ' (jaise https://mysite.com)');
    return o;
  });
  const cleanEmails = arr => (Array.isArray(arr) ? arr : String(arr || '').split(/[\s,]+/)).map(s => String(s).trim().toLowerCase()).filter(Boolean);
  const newKeys = () => ({ apiKey: 'stp_pk_' + crypto.randomBytes(20).toString('hex'), adminKey: 'stp_sk_' + crypto.randomBytes(24).toString('hex') });
  const pubProject = (r, extra) => ({
    id: r.id, name: r.name, ownerEmail: r.owner_email, adminEmails: r.admin_emails, origins: r.origins, active: r.active, keyHint: r.key_hint,
    rules: r.rules && Object.keys(r.rules).length ? r.rules : { default: { read: 'owner', write: 'owner' }, collections: {} },
    maxDocs: r.max_docs, maxUsers: r.max_users, ratePerMin: r.rate_per_min, notes: r.notes, createdAt: r.created_at, ...(extra || {})
  });
  const limitsFrom = b => ({
    maxDocs: b.maxDocs != null ? int(b.maxDocs, 20000, 100, 5e6) : undefined,
    maxUsers: b.maxUsers != null ? int(b.maxUsers, 1000, 1, 1e6) : undefined,
    ratePerMin: b.ratePerMin != null ? int(b.ratePerMin, 300, 10, 100000) : undefined
  });

  admin.get('/projects', wrap(async (req, res) => {
    const [rows, stats, users] = await Promise.all([db.query('SELECT * FROM projects ORDER BY created_at DESC'), collectionStats(),
      db.query('SELECT project_id, COUNT(*)::int c FROM project_users GROUP BY 1')]);
    const docs = {}; stats.forEach(s => { const m = RESERVED.exec(s.name); if (m) docs[m[1]] = (docs[m[1]] || 0) + s.count; });
    const uc = {}; users.rows.forEach(u => { uc[u.project_id] = u.c; });
    res.json({ success: true, projects: rows.rows.map(r => pubProject(r, { docs: docs[r.id] || 0, users: uc[r.id] || 0 })) });
  }));
  admin.post('/projects', wrap(async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (name.length < 2 || name.length > 60) throw new HttpError(400, 'Project ka naam 2 se 60 akshar ka ho');
    const rules = b.rules ? normalizeRules(b.rules) : { default: { read: 'owner', write: 'owner' }, collections: {} };
    const lim = limitsFrom(b);
    const keys = newKeys(); const id = crypto.randomBytes(4).toString('hex');
    await db.query(`INSERT INTO projects (id, name, owner_email, admin_emails, api_key_hash, admin_key_hash, key_hint, rules, origins, max_docs, max_users, rate_per_min, notes)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)`,
      [id, name, b.ownerEmail ? String(b.ownerEmail).trim().toLowerCase() : null, cleanEmails(b.adminEmails), sha(keys.apiKey), sha(keys.adminKey), keys.apiKey.slice(-4),
        JSON.stringify(rules), cleanOrigins(b.origins), lim.maxDocs || 20000, lim.maxUsers || 1000, lim.ratePerMin || 300, b.notes ? String(b.notes).slice(0, 500) : null]);
    invalidateProjects(); audit(req, 'project.create', id, { name });
    const r = await db.query('SELECT * FROM projects WHERE id=$1', [id]);
    res.json({ success: true, project: pubProject(r.rows[0]), apiKey: keys.apiKey, adminKey: keys.adminKey, note: 'Ye dono key sirf ab dikh rahi hain. Copy karke rakh lo.' });
  }));
  admin.get('/projects/:id', wrap(async (req, res) => {
    projectPrefixOf(req.params.id);
    const r = await db.query('SELECT * FROM projects WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) throw new HttpError(404, 'Project nahi mila');
    const prefix = 'p' + req.params.id + '__';
    const [cols, use, users] = await Promise.all([
      db.query(`SELECT substr(collection_name, ${PREFIX_LEN + 1}) AS name, COUNT(*)::int AS count, COALESCE(SUM(pg_column_size(data)),0)::bigint AS bytes
                FROM documents WHERE collection_name LIKE $1 ESCAPE '\\' GROUP BY 1 ORDER BY 1`, [likeEsc(prefix) + '%']),
      db.query("SELECT day::text, requests, writes, errors FROM usage_daily WHERE scope=$1 AND day > CURRENT_DATE - 14 ORDER BY day", [req.params.id]),
      db.query('SELECT COUNT(*)::int c FROM project_users WHERE project_id=$1', [req.params.id])]);
    res.json({ success: true, project: pubProject(r.rows[0], { users: users.rows[0].c }), collections: cols.rows.map(c => ({ ...c, bytes: Number(c.bytes) })), usage: use.rows });
  }));
  admin.patch('/projects/:id', wrap(async (req, res) => {
    projectPrefixOf(req.params.id);
    const b = req.body || {}; const sets = [], vals = [req.params.id];
    const add = (col, v, cast) => { vals.push(v); sets.push(`${col}=$${vals.length}${cast || ''}`); };
    if (b.name != null) { const n = String(b.name).trim(); if (n.length < 2 || n.length > 60) throw new HttpError(400, 'Naam 2-60 akshar'); add('name', n); }
    if (b.ownerEmail !== undefined) add('owner_email', b.ownerEmail ? String(b.ownerEmail).trim().toLowerCase() : null);
    if (b.adminEmails !== undefined) add('admin_emails', cleanEmails(b.adminEmails));
    if (b.origins !== undefined) add('origins', cleanOrigins(b.origins));
    if (b.active !== undefined) add('active', !!b.active);
    if (b.rules !== undefined) add('rules', JSON.stringify(normalizeRules(b.rules)), '::jsonb');
    if (b.notes !== undefined) add('notes', b.notes ? String(b.notes).slice(0, 500) : null);
    const lim = limitsFrom(b);
    if (lim.maxDocs) add('max_docs', lim.maxDocs); if (lim.maxUsers) add('max_users', lim.maxUsers); if (lim.ratePerMin) add('rate_per_min', lim.ratePerMin);
    if (!sets.length) throw new HttpError(400, 'Kuch badalne ko nahi diya');
    const r = await db.query(`UPDATE projects SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, vals);
    if (!r.rows[0]) throw new HttpError(404, 'Project nahi mila');
    invalidateProjects(); audit(req, 'project.update', req.params.id, Object.keys(b));
    res.json({ success: true, project: pubProject(r.rows[0]) });
  }));
  admin.post('/projects/:id/rotate-keys', wrap(async (req, res) => {
    projectPrefixOf(req.params.id);
    const which = (req.body || {}).which || 'both';
    if (!['api', 'admin', 'both'].includes(which)) throw new HttpError(400, 'which = api | admin | both');
    const keys = newKeys(); const out = {};
    const sets = [], vals = [req.params.id];
    if (which !== 'admin') { vals.push(sha(keys.apiKey)); sets.push(`api_key_hash=$${vals.length}`); vals.push(keys.apiKey.slice(-4)); sets.push(`key_hint=$${vals.length}`); out.apiKey = keys.apiKey; }
    if (which !== 'api') { vals.push(sha(keys.adminKey)); sets.push(`admin_key_hash=$${vals.length}`); out.adminKey = keys.adminKey; }
    const r = await db.query(`UPDATE projects SET ${sets.join(', ')} WHERE id=$1 RETURNING id`, vals);
    if (!r.rows[0]) throw new HttpError(404, 'Project nahi mila');
    invalidateProjects(); audit(req, 'project.rotate', req.params.id, { which });
    res.json({ success: true, ...out, note: 'Purani key turant band. Nayi key sirf ab dikh rahi hai.' });
  }));
  admin.delete('/projects/:id', wrap(async (req, res) => {
    projectPrefixOf(req.params.id);
    if (req.query.confirm !== req.params.id) throw new HttpError(400, 'confirm=<project id> chahiye');
    const d = await db.query("DELETE FROM documents WHERE collection_name LIKE $1 ESCAPE '\\'", [likeEsc('p' + req.params.id + '__') + '%']);
    const r = await db.query('DELETE FROM projects WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows[0]) throw new HttpError(404, 'Project nahi mila');
    invalidateProjects(); audit(req, 'project.delete', req.params.id, { docs: d.rowCount });
    res.json({ success: true, deletedDocs: d.rowCount });
  }));
  admin.get('/projects/:id/users', wrap(async (req, res) => {
    projectPrefixOf(req.params.id);
    const r = await db.query('SELECT uid, email, name, role, created_at FROM project_users WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2', [req.params.id, int(req.query.limit, 200, 1, 500)]);
    res.json({ success: true, users: r.rows });
  }));
  admin.patch('/projects/:id/users/:uid', wrap(async (req, res) => {
    const role = (req.body || {}).role;
    if (role !== 'admin' && role !== 'user') throw new HttpError(400, 'role admin ya user');
    const r = await db.query('UPDATE project_users SET role=$1 WHERE project_id=$2 AND uid=$3 RETURNING email', [role, req.params.id, req.params.uid]);
    if (!r.rows[0]) throw new HttpError(404, 'User nahi mila');
    audit(req, 'puser.role', req.params.id + ':' + r.rows[0].email, { role });
    res.json({ success: true });
  }));
  admin.delete('/projects/:id/users/:uid', wrap(async (req, res) => {
    const r = await db.query('DELETE FROM project_users WHERE project_id=$1 AND uid=$2 RETURNING email', [req.params.id, req.params.uid]);
    if (!r.rows[0]) throw new HttpError(404, 'User nahi mila');
    audit(req, 'puser.delete', req.params.id + ':' + r.rows[0].email);
    res.json({ success: true });
  }));

  // ------------------------------------------------------------ project public API (X-Api-Key ke saath)
  const pub = express.Router();
  pub.use((req, res, next) => (req.project ? next() : res.status(401).json({ error: 'X-Api-Key header chahiye' })));
  const pAuthLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false, message: { error: 'Bahut zyada attempts, 15 minute baad try karo' } });
  const ptoken = u => ctx.signJwt({ uid: u.uid, email: u.email, role: u.role, pid: u.project_id });
  const puView = u => ({ uid: u.uid, email: u.email, name: u.name, role: u.role });

  pub.get('/info', (req, res) => res.json({ success: true, project: { id: req.project.id, name: req.project.name }, user: req.user ? { uid: req.user.uid, email: req.user.email, role: req.user.role } : null }));
  pub.post('/auth/signup', pAuthLimiter, wrap(async (req, res) => {
    const { email, password, name } = req.body || {};
    if (!email || !password) throw new HttpError(400, 'Email aur password chahiye');
    const em = String(email).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) throw new HttpError(400, 'Email sahi nahi hai');
    if (String(password).length < 6) throw new HttpError(400, 'Password kam se kam 6 character ka ho');
    const p = req.project;
    const cnt = await db.query('SELECT COUNT(*)::int c FROM project_users WHERE project_id=$1', [p.id]);
    if (cnt.rows[0].c >= p.maxUsers) throw new HttpError(403, 'Project ki user limit (' + p.maxUsers + ') pura ho gayi');
    const role = p.adminEmails.includes(em) || em === p.ownerEmail ? 'admin' : 'user';
    try {
      const r = await db.query('INSERT INTO project_users (project_id, uid, email, password, name, role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [p.id, crypto.randomUUID(), em, await bcrypt.hash(String(password), 10), name ? String(name).slice(0, 100) : null, role]);
      res.json({ success: true, user: puView(r.rows[0]), token: ptoken(r.rows[0]) });
    } catch (e) { if (e.code === '23505') throw new HttpError(409, 'Ye email pehle se registered hai'); throw e; }
  }));
  pub.post('/auth/login', pAuthLimiter, wrap(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) throw new HttpError(400, 'Email aur password chahiye');
    const em = String(email).trim().toLowerCase(), p = req.project;
    const r = await db.query('SELECT * FROM project_users WHERE project_id=$1 AND email=$2', [p.id, em]);
    const u = r.rows[0];
    if (!u || !(await bcrypt.compare(String(password), u.password))) throw new HttpError(401, 'Email ya password galat hai');
    if (u.role !== 'admin' && (p.adminEmails.includes(em) || em === p.ownerEmail)) { await db.query("UPDATE project_users SET role='admin' WHERE id=$1", [u.id]); u.role = 'admin'; }
    res.json({ success: true, user: puView(u), token: ptoken(u) });
  }));
  pub.get('/auth/me', wrap(async (req, res) => {
    if (!req.user || req.user.projectAdmin) return res.status(401).json({ error: 'Login required' });
    const r = await db.query('SELECT uid, email, name, role FROM project_users WHERE project_id=$1 AND uid=$2', [req.project.id, req.user.uid]);
    if (!r.rows[0]) throw new HttpError(404, 'User not found');
    res.json({ success: true, user: r.rows[0] });
  }));
  pub.post('/auth/change-password', pAuthLimiter, wrap(async (req, res) => {
    if (!req.user || req.user.projectAdmin) return res.status(401).json({ error: 'Login required' });
    const { oldPassword, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 6) throw new HttpError(400, 'Naya password kam se kam 6 character ka ho');
    const r = await db.query('SELECT * FROM project_users WHERE project_id=$1 AND uid=$2', [req.project.id, req.user.uid]);
    if (!r.rows[0] || !(await bcrypt.compare(String(oldPassword || ''), r.rows[0].password))) throw new HttpError(401, 'Purana password galat hai');
    await db.query('UPDATE project_users SET password=$1 WHERE id=$2', [await bcrypt.hash(String(newPassword), 10), r.rows[0].id]);
    res.json({ success: true });
  }));

  // ------------------------------------------------------------ mount (errors handler se pehle)
  function mount(app) {
    app.use('/api/admin', admin);
    app.use('/api/p', pub);
    const dash = path.join(__dirname, 'dashboard', 'index.html');
    app.get(['/dashboard', '/dashboard/'], (req, res) => {
      res.set({
        'Cache-Control': 'no-cache', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
      });
      res.sendFile(dash);
    });
    app.get('/sdk/snaptestpro-sdk.js', (req, res) => {
      res.set({ 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/javascript; charset=utf-8' });
      res.sendFile(path.join(__dirname, 'sdk', 'snaptestpro-sdk.js'));
    });
  }

  return { initSchema, projectMw, mount, rulesFor, displayName, isReserved, originAllowed, scopeSocket, projectUser, flushUsage, invalidateProjects, loadProjectById };
};
