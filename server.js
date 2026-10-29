/**
 * SnapTestPro Backend v2.1 — free, self-hosted Firebase (Firestore + Auth + Storage) alternative
 * Node.js + Express + PostgreSQL (JSONB) + Socket.io
 *
 * v2.1 HYBRID MODE: Firebase login (ID token) bhi accept hota hai, taaki app ka Firebase Auth jaisa ka taisa
 * rahe aur kuch collections (jaise questionBank) is backend par chalein. Admin/owner ka faisla Firebase ke
 * `admins/{email}` document se hota hai (firestore.rules jaisa), is backend me alag admin list nahi banti.
 */
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------- config
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === 'change-me') {
  if (IS_PROD) { console.error('JWT_SECRET set karo (.env / hosting env vars)'); process.exit(1); }
  console.warn('WARNING: JWT_SECRET set nahi hai, sirf development ke liye temporary secret use ho raha hai');
}
const SECRET = JWT_SECRET && JWT_SECRET !== 'change-me' ? JWT_SECRET : crypto.randomBytes(32).toString('hex');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/snaptestpro';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ORIGINS = (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, 'uploads'));
const MAX_UPLOAD = (parseInt(process.env.MAX_UPLOAD_MB, 10) || 10) * 1024 * 1024;
const TOKEN_DAYS = 14;
// ---- Hybrid mode (Firebase login bridge). FIREBASE_PROJECT_ID khali ho to Firebase tokens band rehte hain.
const FIREBASE_PROJECT_ID = (process.env.FIREBASE_PROJECT_ID || '').trim();
const lc = v => (v || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const OWNER_EMAILS = lc(process.env.OWNER_EMAILS);               // firestore.rules ke isOwner() wali email(s)
const EXTRA_ADMIN_EMAILS = lc(process.env.EXTRA_ADMIN_EMAILS);   // firestore.rules ki hardcoded admin email list
const TRUST_SNAPROLE = process.env.TRUST_SNAPROLE === 'true';    // sirf tab true karo jab Firestore App Check enforce ho (neeche docs dekho)
const ADMIN_CACHE_MS = 10 * 60 * 1000;
let fetchFn = (...a) => fetch(...a); // tests me badal sakte hain

let RULES = { default: { read: 'owner', write: 'owner' }, collections: {} };
const RULES_FILE = process.env.RULES_FILE ? path.resolve(process.env.RULES_FILE) : path.join(__dirname, 'rules.json');
try { RULES = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8')); }
catch (e) { console.warn('rules file nahi mili (' + RULES_FILE + '), default rules (owner/owner) use ho rahe hain'); }

const corsOrigin = (origin, cb) => {
  // Same-origin / curl / mobile webview (no Origin header) allowed
  if (!origin) return cb(null, true);
  if (!ORIGINS.length && !IS_PROD) return cb(null, true);
  cb(null, ORIGINS.includes(origin));
};

// ---------------------------------------------------------------- app + db
const app = express();
app.set('trust proxy', 1); // Render/Railway proxy ke peeche sahi IP ke liye
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: corsOrigin, methods: ['GET', 'POST'] } });

const db = new Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000 // Neon cold-start ke liye
});
db.on('error', err => console.error('DB pool error:', err.message));

async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      uid TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      name TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS documents (
      collection_name TEXT NOT NULL,
      doc_id TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}',
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (collection_name, doc_id)
    );
    ALTER TABLE documents ADD COLUMN IF NOT EXISTS owner_uid TEXT;
    UPDATE documents d SET owner_uid = u.uid FROM users u WHERE d.owner_uid IS NULL AND d.user_id = u.id;
    CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents (collection_name, updated_at);
    CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents (collection_name, owner_uid);
    CREATE TABLE IF NOT EXISTS file_storage (
      file_id TEXT PRIMARY KEY,
      filename TEXT,
      stored_name TEXT NOT NULL,
      size INT,
      mimetype TEXT,
      user_id INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

// ---------------------------------------------------------------- helpers
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Firestore jaisa: koi bhi character (hindi, space, #...) chalega, bas '/' aur control characters nahi, '.' / '..' nahi, max 1500 bytes
const DOCID_RE = /^[^/\u0000-\u001f]{1,1500}$/;
const FIELD_RE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;

function checkCollection(name) {
  if (!NAME_RE.test(name)) throw new HttpError(400, 'Invalid collection name');
  return name;
}
function checkDocId(id) {
  if (typeof id !== 'string' || id === '.' || id === '..' || !DOCID_RE.test(id) || Buffer.byteLength(id) > 1500) throw new HttpError(400, 'Invalid document id');
  return id;
}
function rule(collection, kind) {
  const r = (RULES.collections && RULES.collections[collection]) || RULES.default || {};
  return r[kind] || 'owner';
}

function signToken(user) {
  return jwt.sign({ id: user.id, uid: user.uid, email: user.email, role: user.role }, SECRET, { expiresIn: `${TOKEN_DAYS}d`, algorithm: 'HS256' });
}
function verifyToken(token) {
  try { return jwt.verify(token, SECRET, { algorithms: ['HS256'] }); } catch { return null; }
}

// ---- Firebase ID token verification (Google ke public certificates se, koi service-account nahi chahiye)
let fbCerts = {}, fbCertsExp = 0;
async function getFirebaseCerts() {
  if (Date.now() < fbCertsExp && Object.keys(fbCerts).length) return fbCerts;
  const r = await fetchFn('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com');
  if (!r.ok) throw new Error('Firebase certs fetch failed');
  const m = /max-age=(\d+)/.exec((r.headers && r.headers.get && r.headers.get('cache-control')) || '');
  fbCerts = await r.json();
  fbCertsExp = Date.now() + (m ? parseInt(m[1], 10) * 1000 : 3600 * 1000);
  return fbCerts;
}
async function verifyFirebase(token) {
  if (!FIREBASE_PROJECT_ID) return null;
  const dec = jwt.decode(token, { complete: true });
  if (!dec || dec.header.alg !== 'RS256' || !dec.header.kid) return null;
  let certs; try { certs = await getFirebaseCerts(); } catch (e) { console.warn('Firebase certs:', e.message); return null; }
  const pem = certs[dec.header.kid]; if (!pem) return null;
  try {
    const p = jwt.verify(token, pem, { algorithms: ['RS256'], audience: FIREBASE_PROJECT_ID, issuer: 'https://securetoken.google.com/' + FIREBASE_PROJECT_ID });
    if (!p.sub) return null;
    return { uid: p.sub, email: p.email ? String(p.email).toLowerCase() : null, anonymous: !!(p.firebase && p.firebase.sign_in_provider === 'anonymous'),
      snapRole: p.snapRole || '', firebase: true, idToken: token };
  } catch { return null; }
}
// Firestore REST se (user ke apne token ke saath, to Firestore rules lagte hain) ek document padho
async function fsGet(docPath, idToken) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${docPath}`;
  const r = await fetchFn(url, { headers: { Authorization: 'Bearer ' + idToken } });
  if (r.status === 404) return { status: 404, fields: {} };
  if (!r.ok) return { status: r.status, fields: {} };
  const j = await r.json(); return { status: 200, fields: j.fields || {} };
}
const adminCache = new Map(); // email -> { t, role, instituteId }
// firestore.rules ke isOwner / isAdminEmailAllowed / adminInstituteActive ka copy
async function firebaseRole(u) {
  if (!u.email || u.anonymous) return { role: 'user' };
  if (OWNER_EMAILS.includes(u.email) || u.snapRole === 'owner') return { role: 'owner' };
  const c = adminCache.get(u.email);
  if (c && Date.now() - c.t < c.ttl) return c;
  let res = { role: 'user', instituteId: null }, ttl = ADMIN_CACHE_MS;
  try {
    const d = await fsGet('admins/' + encodeURIComponent(u.email), u.idToken);
    const a = d.fields.active;
    const active = d.status === 200 && a && 'booleanValue' in a ? a.booleanValue : null;
    let ok = active === true || (EXTRA_ADMIN_EMAILS.includes(u.email) && active !== false);
    if (!ok && TRUST_SNAPROLE && u.snapRole === 'admin') ok = true;
    let inst = d.fields.instituteId && d.fields.instituteId.stringValue || null;
    if (ok && inst) { // institute band (active:false) ho to admin nahi
      const i = await fsGet('institutes/' + encodeURIComponent(inst), u.idToken);
      if (i.status === 200 && i.fields.active && i.fields.active.booleanValue === false) ok = false;
    }
    res = { role: ok ? 'admin' : 'user', instituteId: inst };
  } catch (e) { console.warn('admin check failed:', e.message); ttl = 30 * 1000; }
  const entry = { t: Date.now(), ttl, ...res }; adminCache.set(u.email, entry); return entry;
}
// Ek hi jagah jo token (backend ka apna ya Firebase ka) ko user object me badalti hai
async function resolveUser(token) {
  if (!token) return null;
  const own = verifyToken(token);
  if (own) return { id: own.id, uid: own.uid, email: own.email, own: true, role: own.role === 'admin' ? 'admin' : 'user', superAdmin: own.role === 'admin' };
  const fb = await verifyFirebase(token);
  if (!fb) return null;
  const r = await firebaseRole(fb);
  fb.role = r.role; fb.instituteId = r.instituteId || null; fb.superAdmin = r.role === 'owner';
  return fb;
}
const bearer = req => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7) : null; };
const authMw = wrap(async (req, res, next) => { req.user = await resolveUser(bearer(req)); next(); });
function requireAuth(req, res, next) { if (!req.user) return res.status(401).json({ error: 'Login required' }); next(); }
function requireOwn(req, res, next) { if (!req.user || !req.user.own) return res.status(401).json({ error: 'Login required' }); next(); }

const isAdmin = u => !!u && (u.role === 'admin' || u.role === 'owner');
const isOwnerUser = u => !!u && (u.role === 'owner' || u.superAdmin === true);

// Read allowed? returns {ok, ownerOnly}.  Level 'none' sabke liye band (admin ke liye bhi).
function canRead(collection, user) {
  const lvl = rule(collection, 'read');
  if (lvl === 'none') return { ok: false };
  if (isAdmin(user)) return { ok: true, ownerOnly: false };
  if (lvl === 'public') return { ok: true, ownerOnly: false };
  if (!user) return { ok: false };
  if (lvl === 'auth') return { ok: true, ownerOnly: false };
  if (lvl === 'owner') return { ok: true, ownerOnly: true };
  return { ok: false };
}
function canWriteLevel(collection, user) {
  const lvl = rule(collection, 'write');
  if (lvl === 'none') return false;
  if (isAdmin(user)) return true;
  if (lvl === 'public') return true;
  if (!user) return false;
  return lvl === 'auth' || lvl === 'owner';
}
// firestore.rules ke questionBank wala "createdBy" niyam (rules.json me "createdByGuard": true)
function guardOk(collection, user, action, existing, finalData) {
  if (!(RULES.collections && RULES.collections[collection] && RULES.collections[collection].createdByGuard)) return true;
  if (isOwnerUser(user)) return true;
  const has = o => o && Object.prototype.hasOwnProperty.call(o, 'createdBy');
  if (action === 'create') return !has(finalData) || finalData.createdBy === user.email;
  if (action === 'update') return !has(existing) || finalData.createdBy === existing.createdBy;
  if (action === 'delete') return !has(existing) || existing.createdBy === user.email;
  return false;
}
// Firestore ke FieldValue.serverTimestamp() ka sentinel ({__sv:'serverTimestamp'}) -> {__ts: ms}
function resolveSentinels(v, now) {
  if (Array.isArray(v)) return v.map(x => resolveSentinels(x, now));
  if (v && typeof v === 'object') {
    if (v.__sv === 'serverTimestamp') return { __ts: now };
    const o = {}; for (const k of Object.keys(v)) o[k] = resolveSentinels(v[k], now); return o;
  }
  return v;
}

const fmt = r => ({ id: r.doc_id, data: r.data, createdAt: r.created_at, updatedAt: r.updated_at });

function broadcast(collection, row, action) {
  const payload = { collection, docId: row.doc_id, data: action === 'delete' ? null : row.data, action, timestamp: new Date() };
  io.to(`c:${collection}:all`).emit('update', payload);
  if (row.owner_uid) io.to(`c:${collection}:u:${row.owner_uid}`).emit('update', payload);
}

// ---- document operations (shared by REST + batch) ----
const uidOf = u => (u ? u.uid : null);
async function opSet(client, user, collection, docId, data, merge = false) {
  checkCollection(collection); checkDocId(docId);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'data must be an object');
  if (!canWriteLevel(collection, user)) throw new HttpError(403, 'Write not allowed');
  data = resolveSentinels(data, Date.now());
  const lvl = rule(collection, 'write');
  const privileged = isAdmin(user) || lvl === 'auth' || lvl === 'public';
  const ex = (await client.query('SELECT data, owner_uid FROM documents WHERE collection_name=$1 AND doc_id=$2 FOR UPDATE', [collection, docId])).rows[0];
  if (ex && !privileged && ex.owner_uid !== uidOf(user)) throw new HttpError(403, 'Ye document kisi aur ka hai');
  const finalData = ex && merge ? { ...ex.data, ...data } : data;
  if (!guardOk(collection, user, ex ? 'update' : 'create', ex && ex.data, finalData)) throw new HttpError(403, 'createdBy rule: ye question kisi aur admin ka hai');
  const r = await client.query(
    `INSERT INTO documents (collection_name, doc_id, data, user_id, owner_uid)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (collection_name, doc_id) DO UPDATE SET data = ${merge ? 'documents.data || EXCLUDED.data' : 'EXCLUDED.data'}, updated_at = NOW()
     RETURNING *`,
    [collection, docId, JSON.stringify(data), user && user.id || null, uidOf(user)]);
  return r.rows[0];
}
async function opUpdate(client, user, collection, docId, data) {
  checkCollection(collection); checkDocId(docId);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'data must be an object');
  if (!canWriteLevel(collection, user)) throw new HttpError(403, 'Write not allowed');
  data = resolveSentinels(data, Date.now());
  const lvl = rule(collection, 'write');
  const privileged = isAdmin(user) || lvl === 'auth' || lvl === 'public';
  const ex = (await client.query('SELECT data, owner_uid FROM documents WHERE collection_name=$1 AND doc_id=$2 FOR UPDATE', [collection, docId])).rows[0];
  if (!ex) throw new HttpError(404, 'Document not found');
  if (!privileged && ex.owner_uid !== uidOf(user)) throw new HttpError(403, 'Ye document kisi aur ka hai');
  if (!guardOk(collection, user, 'update', ex.data, { ...ex.data, ...data })) throw new HttpError(403, 'createdBy rule: ye question kisi aur admin ka hai');
  const r = await client.query(
    `UPDATE documents SET data = data || $3::jsonb, updated_at = NOW() WHERE collection_name = $1 AND doc_id = $2 RETURNING *`,
    [collection, docId, JSON.stringify(data)]);
  return r.rows[0];
}
async function opDelete(client, user, collection, docId) {
  checkCollection(collection); checkDocId(docId);
  if (!canWriteLevel(collection, user)) throw new HttpError(403, 'Write not allowed');
  const lvl = rule(collection, 'write');
  const privileged = isAdmin(user) || lvl === 'auth' || lvl === 'public';
  const ex = (await client.query('SELECT data, owner_uid FROM documents WHERE collection_name=$1 AND doc_id=$2 FOR UPDATE', [collection, docId])).rows[0];
  if (!ex) return null; // Firebase jaisa: jo document hai hi nahi, uska delete chupchap ho jata hai (404 nahi)
  if (!privileged && ex.owner_uid !== uidOf(user)) throw new HttpError(403, 'Ye document kisi aur ka hai');
  if (!guardOk(collection, user, 'delete', ex.data, null)) throw new HttpError(403, 'createdBy rule: ye question kisi aur admin ka hai');
  const r = await client.query('DELETE FROM documents WHERE collection_name = $1 AND doc_id = $2 RETURNING *', [collection, docId]);
  return r.rows[0];
}

// ---------------------------------------------------------------- middleware (ROUTES SE PEHLE!)
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '2mb' }));
app.use('/api/', rateLimit({ windowMs: 60 * 1000, limit: 600, standardHeaders: true, legacyHeaders: false }));
app.use('/api/', authMw); // req.user = backend ka apna user ya Firebase user (ya null)
// Purane app-version band: MIN_BUILD (Render env) set ho to admin/owner ki wo requests jinme X-App-Build >= MIN_BUILD nahi, 426 se lautti hain.
// Students/anonymous par kabhi nahi lagta. MIN_BUILD khali/0 = band. (Header na bhejne wale bahut purane app bhi isi me aate hain.)
const MIN_BUILD = parseInt(process.env.MIN_BUILD || '0', 10) || 0;
app.use('/api/', (req, res, next) => {
  if (!MIN_BUILD || !isAdmin(req.user)) return next();
  const build = parseInt(req.get('x-app-build') || '0', 10) || 0;
  if (build >= MIN_BUILD) return next();
  res.status(426).json({ error: 'App update zaroori hai (build ' + MIN_BUILD + ' ya naya chahiye)', code: 'update-required', minBuild: MIN_BUILD });
});
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Bahut zyada attempts, 15 minute baad try karo' } });

// ---------------------------------------------------------------- health
app.get('/', (req, res) => res.json({ name: 'SnapTestPro backend', status: 'running' }));
app.get('/api/ping', (req, res) => res.json({ ok: true })); // DB nahi chhuta — UptimeRobot ke liye
app.get('/api/health', wrap(async (req, res) => {
  await db.query('SELECT 1');
  res.json({ success: true, status: 'healthy', timestamp: new Date() });
}));

// ---------------------------------------------------------------- auth
app.post('/api/auth/signup', authLimiter, wrap(async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) throw new HttpError(400, 'Email aur password chahiye');
  const em = String(email).trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) throw new HttpError(400, 'Email sahi nahi hai');
  if (String(password).length < 6) throw new HttpError(400, 'Password kam se kam 6 character ka ho');
  const hash = await bcrypt.hash(String(password), 10);
  const role = ADMIN_EMAILS.includes(em) ? 'admin' : 'user';
  try {
    const r = await db.query(
      'INSERT INTO users (uid, email, password, name, role) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [crypto.randomUUID(), em, hash, name || null, role]);
    const u = r.rows[0];
    res.json({ success: true, user: { uid: u.uid, email: u.email, name: u.name, role: u.role }, token: signToken(u) });
  } catch (e) {
    if (e.code === '23505') throw new HttpError(409, 'Ye email pehle se registered hai');
    throw e;
  }
}));

app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw new HttpError(400, 'Email aur password chahiye');
  const em = String(email).trim().toLowerCase();
  const r = await db.query('SELECT * FROM users WHERE email = $1', [em]);
  const u = r.rows[0];
  // Same error dono cases me (user enumeration se bachne ke liye)
  if (!u || !(await bcrypt.compare(String(password), u.password))) throw new HttpError(401, 'Email ya password galat hai');
  if (ADMIN_EMAILS.includes(em) && u.role !== 'admin') {
    await db.query("UPDATE users SET role='admin' WHERE id=$1", [u.id]); u.role = 'admin';
  }
  res.json({ success: true, user: { uid: u.uid, email: u.email, name: u.name, role: u.role }, token: signToken(u) });
}));

app.get('/api/auth/me', requireOwn, wrap(async (req, res) => {
  const r = await db.query('SELECT uid, email, name, role FROM users WHERE id = $1', [req.user.id]);
  if (!r.rows[0]) throw new HttpError(404, 'User not found');
  res.json({ success: true, user: r.rows[0] });
}));

app.post('/api/auth/change-password', requireOwn, authLimiter, wrap(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) throw new HttpError(400, 'Naya password kam se kam 6 character ka ho');
  const r = await db.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(String(oldPassword || ''), u.password))) throw new HttpError(401, 'Purana password galat hai');
  await db.query('UPDATE users SET password=$1 WHERE id=$2', [await bcrypt.hash(String(newPassword), 10), u.id]);
  res.json({ success: true });
}));

// Debug: "mera token backend ko kaisa dikh raha hai?" (Firebase token ke saath bhi chalta hai)
app.get('/api/auth/whoami', wrap(async (req, res) => {
  const u = req.user;
  if (!u) return res.json({ success: true, signedIn: false, firebaseBridge: !!FIREBASE_PROJECT_ID });
  res.json({ success: true, signedIn: true, via: u.own ? 'backend' : 'firebase', uid: u.uid, email: u.email || null,
    anonymous: !!u.anonymous, role: u.role, instituteId: u.instituteId || null });
}));

// ---------------------------------------------------------------- documents
// Query: ?where=field:op:value (repeatable; op = eq|ne|lt|lte|gt|gte)  &orderBy=field:desc  &limit=  &offset=  &since=ISO
const OPS = { eq: '=', ne: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=' };
function parseValue(v) { try { return JSON.parse(v); } catch { return v; } }

app.get('/api/collections/:collection/documents', wrap(async (req, res) => {
  const collection = checkCollection(req.params.collection);
  const perm = canRead(collection, req.user);
  if (!perm.ok) throw new HttpError(req.user ? 403 : 401, req.user ? 'Read not allowed' : 'Login required');

  const params = [collection];
  let sql = 'SELECT * FROM documents WHERE collection_name = $1';
  if (perm.ownerOnly) { params.push(req.user.uid); sql += ` AND owner_uid = $${params.length}`; }

  const wheres = [].concat(req.query.where || []);
  for (const w of wheres) {
    const parts = String(w).split(':');
    let field, op, value;
    if (parts.length >= 3 && OPS[parts[1]]) { field = parts[0]; op = parts[1]; value = parts.slice(2).join(':'); }
    else { const i = String(w).indexOf('='); field = String(w).slice(0, i); op = 'eq'; value = String(w).slice(i + 1); }
    if (!FIELD_RE.test(field || '')) throw new HttpError(400, 'Invalid where field');
    params.push(field.split('.')); const pi = params.length;
    params.push(JSON.stringify(parseValue(value))); const vi = params.length;
    sql += ` AND (data #> $${pi}::text[]) ${OPS[op]} $${vi}::jsonb`;
  }
  if (req.query.since) {
    const d = new Date(String(req.query.since));
    if (isNaN(d)) throw new HttpError(400, 'Invalid since');
    params.push(d.toISOString()); sql += ` AND updated_at > $${params.length}`;
  }
  if (req.query.orderBy) {
    const [field, dir] = String(req.query.orderBy).split(':');
    if (!FIELD_RE.test(field || '')) throw new HttpError(400, 'Invalid orderBy field');
    params.push(field.split('.'));
    // Firestore jaisa: orderBy field jis doc me nahi hai wo result me nahi aata
    sql += ` AND (data #> $${params.length}::text[]) IS NOT NULL ORDER BY (data #> $${params.length}::text[]) ${dir === 'desc' ? 'DESC' : 'ASC'}, doc_id`;
  } else sql += ' ORDER BY updated_at DESC, doc_id';

  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 1000);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  params.push(limit); sql += ` LIMIT $${params.length}`;
  params.push(offset); sql += ` OFFSET $${params.length}`;

  const r = await db.query(sql, params);
  res.json({ success: true, docs: r.rows.map(fmt), count: r.rows.length, serverTime: new Date().toISOString() });
}));

// Kitne documents hain (migration ke baad Firebase se milan karne ke liye)
app.get('/api/collections/:collection/count', wrap(async (req, res) => {
  const collection = checkCollection(req.params.collection);
  const perm = canRead(collection, req.user);
  if (!perm.ok) throw new HttpError(req.user ? 403 : 401, req.user ? 'Read not allowed' : 'Login required');
  const params = [collection]; let sql = 'SELECT COUNT(*)::int AS c FROM documents WHERE collection_name = $1';
  if (perm.ownerOnly) { params.push(req.user.uid); sql += ' AND owner_uid = $2'; }
  const r = await db.query(sql, params);
  res.json({ success: true, count: r.rows[0].c });
}));

app.get('/api/collections/:collection/documents/:docId', wrap(async (req, res) => {
  const collection = checkCollection(req.params.collection);
  const docId = checkDocId(req.params.docId);
  const perm = canRead(collection, req.user);
  if (!perm.ok) throw new HttpError(req.user ? 403 : 401, req.user ? 'Read not allowed' : 'Login required');
  const r = await db.query('SELECT * FROM documents WHERE collection_name=$1 AND doc_id=$2', [collection, docId]);
  const row = r.rows[0];
  if (!row) throw new HttpError(404, 'Document not found');
  if (perm.ownerOnly && row.owner_uid !== req.user.uid) throw new HttpError(403, 'Read not allowed');
  res.json({ success: true, doc: fmt(row) });
}));

app.post('/api/collections/:collection/documents', wrap(async (req, res) => {
  const { collection } = req.params;
  const { data, docId, merge } = req.body || {};
  const row = await opSet(db, req.user, collection, docId || crypto.randomUUID(), data, !!merge);
  broadcast(collection, row, 'set');
  res.json({ success: true, doc: fmt(row) });
}));

app.patch('/api/collections/:collection/documents/:docId', wrap(async (req, res) => {
  const { collection, docId } = req.params;
  const row = await opUpdate(db, req.user, collection, docId, (req.body || {}).data);
  broadcast(collection, row, 'update');
  res.json({ success: true, doc: fmt(row) });
}));

app.delete('/api/collections/:collection/documents/:docId', wrap(async (req, res) => {
  const { collection, docId } = req.params;
  const row = await opDelete(db, req.user, collection, docId);
  if (row) broadcast(collection, row, 'delete');
  res.json({ success: true });
}));

// Batch: ek hi transaction me kai writes (max 400)
app.post('/api/batch', wrap(async (req, res) => {
  const ops = (req.body || {}).ops;
  if (!Array.isArray(ops) || !ops.length || ops.length > 400) throw new HttpError(400, 'ops 1..400 hone chahiye');
  const client = await db.connect();
  const events = [];
  try {
    await client.query('BEGIN');
    for (const o of ops) {
      if (o.type === 'set') events.push([o.collection, await opSet(client, req.user, o.collection, o.docId || crypto.randomUUID(), o.data, !!o.merge), 'set']);
      else if (o.type === 'update') events.push([o.collection, await opUpdate(client, req.user, o.collection, o.docId, o.data), 'update']);
      else if (o.type === 'delete') { const dr = await opDelete(client, req.user, o.collection, o.docId); if (dr) events.push([o.collection, dr, 'delete']); }
      else throw new HttpError(400, 'Unknown op type');
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
  finally { client.release(); }
  events.forEach(([c, row, a]) => broadcast(c, row, a));
  res.json({ success: true, count: events.length });
}));

// ---------------------------------------------------------------- storage
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const ALLOWED_MIME = /^(image\/(png|jpe?g|gif|webp)|application\/pdf)$/;
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, ''))
  }),
  limits: { fileSize: MAX_UPLOAD },
  fileFilter: (req, file, cb) => ALLOWED_MIME.test(file.mimetype) ? cb(null, true) : cb(new HttpError(400, 'Sirf image (png/jpg/gif/webp) ya PDF allowed hai'))
});

app.post('/api/storage/upload', requireOwn, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'File nahi mili');
  const fileId = crypto.randomUUID();
  await db.query('INSERT INTO file_storage (file_id, filename, stored_name, size, mimetype, user_id) VALUES ($1,$2,$3,$4,$5,$6)',
    [fileId, req.file.originalname, req.file.filename, req.file.size, req.file.mimetype, req.user.id]);
  res.json({ success: true, file: { id: fileId, name: req.file.originalname, url: `${BASE_URL}/uploads/${req.file.filename}`, size: req.file.size } });
}));
app.get('/api/storage/files', requireOwn, wrap(async (req, res) => {
  const r = await db.query('SELECT * FROM file_storage WHERE user_id=$1 ORDER BY created_at DESC LIMIT 500', [req.user.id]);
  res.json({ success: true, files: r.rows.map(f => ({ id: f.file_id, name: f.filename, size: f.size, url: `${BASE_URL}/uploads/${f.stored_name}` })) });
}));
app.delete('/api/storage/files/:id', requireOwn, wrap(async (req, res) => {
  const r = await db.query('DELETE FROM file_storage WHERE file_id=$1 AND ($2::boolean OR user_id=$3) RETURNING stored_name',
    [req.params.id, isAdmin(req.user), req.user.id]);
  if (!r.rows[0]) throw new HttpError(404, 'File not found');
  fs.unlink(path.join(UPLOAD_DIR, path.basename(r.rows[0].stored_name)), () => {});
  res.json({ success: true });
}));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d', index: false, dotfiles: 'deny' }));

// ---------------------------------------------------------------- stats (admin)
app.get('/api/stats', requireOwn, wrap(async (req, res) => {
  if (!isAdmin(req.user)) throw new HttpError(403, 'Admin only');
  const [u, d, f] = await Promise.all([
    db.query('SELECT COUNT(*)::int c FROM users'), db.query('SELECT COUNT(*)::int c FROM documents'), db.query('SELECT COUNT(*)::int c FROM file_storage')]);
  const size = await db.query('SELECT pg_database_size(current_database())::bigint b');
  res.json({ success: true, stats: { users: u.rows[0].c, documents: d.rows[0].c, files: f.rows[0].c, dbSizeMB: Math.round(Number(size.rows[0].b) / 1048576 * 10) / 10 } });
}));

// ---------------------------------------------------------------- realtime
io.on('connection', socket => {
  socket.on('subscribe', async ({ collection, token } = {}) => {
    try {
      checkCollection(collection);
      const user = await resolveUser(token);
      const perm = canRead(collection, user);
      if (!perm.ok) return socket.emit('error', 'Read not allowed');
      socket.join(perm.ownerOnly ? `c:${collection}:u:${user.uid}` : `c:${collection}:all`);
      socket.emit('subscribed', { collection });
    } catch { socket.emit('error', 'Invalid subscribe request'); }
  });
  socket.on('unsubscribe', collection => {
    for (const room of socket.rooms) if (typeof collection === 'string' && room.startsWith(`c:${collection}:`)) socket.leave(room);
  });
});

// ---------------------------------------------------------------- errors
require('./clip')({ app, db, wrap, HttpError, isAdmin, uidOf, broadcast }); // SnapTest Clipper (photo -> AI -> PDF Drafts)
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { // eslint-disable-line
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `File ${MAX_UPLOAD / 1048576}MB se badi hai` : err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request bahut badi hai' });
  if (err instanceof SyntaxError && err.status === 400) return res.status(400).json({ error: 'Invalid JSON' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 && IS_PROD ? 'Server error' : err.message });
});

// ---------------------------------------------------------------- start
async function start() {
  await initDb();
  server.listen(PORT, () => console.log(`SnapTestPro backend running on port ${PORT}`));
}
if (require.main === module) start().catch(e => { console.error('Start failed:', e.message); process.exit(1); });
module.exports = { app, server, io, db, initDb, start, __setFetch: f => { fetchFn = f; fbCerts = {}; fbCertsExp = 0; adminCache.clear(); } };
