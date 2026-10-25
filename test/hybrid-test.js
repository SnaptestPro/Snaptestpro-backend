// Hybrid mode test: Firebase ID token + admins/{email} (Firestore REST ka mock) + rules.json
const path = require('path'), crypto = require('crypto'), jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret'; process.env.NODE_ENV = 'test';
process.env.RULES_FILE = path.join(__dirname, '..', 'rules.json');
process.env.FIREBASE_PROJECT_ID = 'test-proj'; process.env.OWNER_EMAILS = 'owner@x.com'; process.env.EXTRA_ADMIN_EMAILS = 'extra@x.com,extra2@x.com';
const { server, db, initDb, io, __setFetch } = require('../server');
const { io: ioc } = require('socket.io-client');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' });
let p = 0, f = 0, restCalls = 0;
const ok = (c, m) => { c ? (p++, console.log('  ✓', m)) : (f++, console.log('  ✗ FAIL:', m)); };

const ADMINS = { // Firestore ka admins/{email} + institutes/{id} (mock)
  'admins/a@x.com': { active: true, instituteId: 'instA' }, 'admins/b@x.com': { active: true, instituteId: 'instB' },
  'admins/closed@x.com': { active: true, instituteId: 'instClosed' }, 'admins/off@x.com': { active: false, instituteId: 'instA' },
  'admins/extra@x.com': { active: false }, 'institutes/instClosed': { active: false }, 'institutes/instA': { active: true } };
const toFields = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'boolean' ? { booleanValue: v } : { stringValue: v }]));
__setFetch(async (url, opts = {}) => {
  if (url.includes('x509/securetoken')) return { ok: true, status: 200, headers: { get: () => 'max-age=3600' }, json: async () => ({ kid1: PEM }) };
  if (url.startsWith('https://firestore.googleapis.com/v1/projects/test-proj/')) {
    restCalls++;
    const tok = (opts.headers.Authorization || '').replace('Bearer ', ''); const claims = jwt.decode(tok);
    const docPath = decodeURIComponent(url.split('/documents/')[1]);
    if (docPath.startsWith('admins/') && docPath !== 'admins/' + claims.email) return { ok: false, status: 403, json: async () => ({}) }; // rules: sirf apna doc
    const d = ADMINS[docPath]; if (!d) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ fields: toFields(d) }) };
  }
  throw new Error('unexpected fetch ' + url);
});
const fbToken = (claims = {}, o = {}) => jwt.sign({ firebase: { sign_in_provider: claims.email ? 'password' : 'anonymous' }, ...claims },
  o.key || privateKey, { algorithm: 'RS256', keyid: o.kid || 'kid1', subject: claims.sub || 'fbuid-' + (claims.email || 'anon'),
  audience: o.aud || 'test-proj', issuer: 'https://securetoken.google.com/' + (o.iss || 'test-proj'), expiresIn: o.exp || '1h' });
let base;
const call = async (m, u, b, t) => { const r = await fetch(base + u, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
  let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j }; };
const who = async t => (await call('GET', '/api/auth/whoami', null, t)).j;

(async () => {
  await db.query('DROP TABLE IF EXISTS documents, file_storage, users CASCADE'); await initDb();
  await new Promise(r => server.listen(0, r)); base = 'http://localhost:' + server.address().port;
  const T = { anon: fbToken({}), stu: fbToken({ email: 'stu@x.com' }), A: fbToken({ email: 'a@x.com' }), B: fbToken({ email: 'b@x.com' }),
    owner: fbToken({ email: 'owner@x.com' }), extra: fbToken({ email: 'extra@x.com' }), extra2: fbToken({ email: 'extra2@x.com' }),
    closed: fbToken({ email: 'closed@x.com' }), off: fbToken({ email: 'off@x.com' }) };

  console.log('FIREBASE TOKEN -> ROLE');
  ok((await who()).signedIn === false, 'no token -> signedIn:false');
  let w = await who(T.anon); ok(w.signedIn && w.via === 'firebase' && w.anonymous && w.role === 'user', 'anonymous firebase user -> user');
  w = await who(T.stu); ok(w.role === 'user' && w.email === 'stu@x.com', 'normal email (no admins doc) -> user');
  w = await who(T.A); ok(w.role === 'admin' && w.instituteId === 'instA', 'admins/a@x.com active:true -> admin (instA)');
  ok((await who(T.off)).role === 'user', 'admins doc active:false -> user');
  ok((await who(T.closed)).role === 'user', 'admin of a closed institute -> user');
  ok((await who(T.owner)).role === 'owner', 'OWNER_EMAILS -> owner');
  ok((await who(T.extra)).role === 'user', 'extra-admin email but doc active:false -> user');
  ok((await who(T.extra2)).role === 'admin', 'extra-admin email with no doc -> admin');

  console.log('TOKEN SECURITY');
  ok(!(await who(fbToken({ email: 'a@x.com' }, { key: other.privateKey }))).signedIn, 'token signed with a different key rejected');
  ok(!(await who(fbToken({ email: 'a@x.com' }, { aud: 'other-proj' }))).signedIn, 'wrong audience (other project) rejected');
  ok(!(await who(fbToken({ email: 'a@x.com' }, { iss: 'other-proj' }))).signedIn, 'wrong issuer rejected');
  ok(!(await who(fbToken({ email: 'a@x.com' }, { exp: -10 }))).signedIn, 'expired token rejected');
  ok(!(await who(fbToken({ email: 'a@x.com' }, { kid: 'unknown' }))).signedIn, 'unknown key id rejected');
  const forged = jwt.sign({ email: 'a@x.com', sub: 'x', role: 'admin' }, PEM, { algorithm: 'HS256', expiresIn: '1h' });
  ok(!(await who(forged)).signedIn, 'HS256 token signed with public key (alg confusion) rejected');
  ok(!(await who('garbage.token.here')).signedIn, 'garbage token rejected');
  const before = restCalls; await who(T.A); await who(T.A); await who(T.A);
  ok(restCalls === before, 'admin check cached (no extra Firestore REST calls)');

  console.log('questionBank (read: any signed-in, write: admin + createdBy rule)');
  ok((await call('GET', '/api/collections/questionBank/documents')).s === 401, 'no token cannot read');
  ok((await call('GET', '/api/collections/questionBank/documents', null, T.anon)).s === 200, 'anonymous firebase student can read');
  ok((await call('POST', '/api/collections/questionBank/documents', { docId: 'q1', data: { text: 'x' } }, T.anon)).s === 403, 'student cannot write');
  ok((await call('POST', '/api/collections/questionBank/documents', { docId: 'q1', data: { text: 'x' } }, T.stu)).s === 403, 'non-admin email cannot write');
  ok((await call('POST', '/api/collections/questionBank/documents', { docId: 'q1', data: { text: 'A1', createdBy: 'a@x.com' } }, T.A)).s === 200, 'admin A creates own question');
  ok((await call('POST', '/api/collections/questionBank/documents', { docId: 'q2', data: { text: 'forge', createdBy: 'a@x.com' } }, T.B)).s === 403, 'admin B cannot create with createdBy = A');
  ok((await call('POST', '/api/collections/questionBank/documents', { docId: 'q3', data: { text: 'legacy' } }, T.B)).s === 200, 'admin B creates question without createdBy');
  ok((await call('PATCH', '/api/collections/questionBank/documents/q1', { data: { createdBy: 'b@x.com' } }, T.B)).s === 403, 'admin B cannot change createdBy of A question');
  ok((await call('PATCH', '/api/collections/questionBank/documents/q1', { data: { text: 'fixed' } }, T.B)).s === 200, 'admin B can edit other fields (same as firestore.rules)');
  ok((await call('DELETE', '/api/collections/questionBank/documents/q1', null, T.B)).s === 403, "admin B cannot delete A's question");
  ok((await call('DELETE', '/api/collections/questionBank/documents/q3', null, T.A)).s === 200, 'admin can delete question without createdBy');
  ok((await call('DELETE', '/api/collections/questionBank/documents/q1', null, T.owner)).s === 200, 'owner can delete anything');
  ok((await call('POST', '/api/collections/questionBank/documents', { docId: 'q4', data: { createdBy: 'zzz@x.com' } }, T.owner)).s === 200, 'owner can write any createdBy');

  console.log('OTHER COLLECTIONS');
  ok((await call('POST', '/api/collections/deletedQuestions/documents', { docId: 'd1', data: { a: 1 } }, T.A)).s === 200, 'admin writes deletedQuestions');
  ok((await call('GET', '/api/collections/deletedQuestions/documents', null, T.stu)).s === 403, 'student cannot read deletedQuestions');
  ok((await call('GET', '/api/collections/tests/documents', null, T.owner)).s === 403, "collection not in rules.json -> blocked even for owner (default none)");
  ok((await call('POST', '/api/collections/tests/documents', { data: {} }, T.A)).s === 403, 'unknown collection write blocked for admin');


  console.log('COUNT + UNUSUAL DOC IDS');
  const odd = ['प्रश्न 1', 'a b#c?d', 'seed:ab+cd@e.f', 'x'.repeat(300)];
  for (const id of odd) {
    const w1 = await call('POST', '/api/collections/seedExclusions/documents', { docId: id, data: { v: 1 } }, T.owner);
    const g1 = await call('GET', '/api/collections/seedExclusions/documents/' + encodeURIComponent(id), null, T.owner);
    ok(w1.s === 200 && g1.s === 200 && g1.j.doc.id === id, 'doc id round-trips: ' + id.slice(0, 12));
  }
  ok((await call('POST', '/api/collections/seedExclusions/documents', { docId: 'a/b', data: {} }, T.owner)).s === 400, "doc id with '/' rejected");
  ok((await call('POST', '/api/collections/seedExclusions/documents', { docId: '..', data: {} }, T.owner)).s === 400, "doc id '..' rejected");
  ok((await call('GET', '/api/collections/seedExclusions/count', null, T.A)).j.count === 4, 'count endpoint (admin)');
  ok((await call('GET', '/api/collections/seedExclusions/count', null, T.stu)).s === 403, 'count respects read rule (student blocked)');
  ok((await call('GET', '/api/collections/questionBank/count', null, T.stu)).j.count >= 1, 'count for readable collection (student)');

  console.log('serverTimestamp sentinel');
  const ts = await call('POST', '/api/collections/appSettings/documents', { docId: 's1', data: { updatedAt: { __sv: 'serverTimestamp' }, nested: { at: { __sv: 'serverTimestamp' } } } }, T.A);
  ok(ts.s === 200 && typeof ts.j.doc.data.updatedAt.__ts === 'number' && typeof ts.j.doc.data.nested.at.__ts === 'number', 'sentinel -> {__ts: ms} (also nested)');
  ok(Math.abs(ts.j.doc.data.updatedAt.__ts - Date.now()) < 5000, 'timestamp is server time');

  console.log('REALTIME with Firebase token');
  const sock = ioc(base, { transports: ['websocket'] }); await new Promise(r => sock.on('connect', r));
  const got = new Promise(r => sock.on('update', r));
  sock.emit('subscribe', { collection: 'questionBank', token: T.anon });
  await new Promise(r => setTimeout(r, 400));
  await call('POST', '/api/collections/questionBank/documents', { docId: 'live1', data: { text: 'live' } }, T.A);
  const ev = await Promise.race([got, new Promise(r => setTimeout(() => r(null), 2000))]);
  ok(ev && ev.docId === 'live1', 'anonymous student receives live update');
  const sock2 = ioc(base, { transports: ['websocket'] }); await new Promise(r => sock2.on('connect', r));
  let leak = false; sock2.on('update', () => leak = true); let err = null; sock2.on('error', e => err = e);
  sock2.emit('subscribe', { collection: 'deletedQuestions', token: T.stu });
  await new Promise(r => setTimeout(r, 300));
  await call('POST', '/api/collections/deletedQuestions/documents', { docId: 'd2', data: {} }, T.A);
  await new Promise(r => setTimeout(r, 400));
  ok(!leak && err, 'student cannot subscribe to admin-only collection');
  sock.close(); sock2.close();

  console.log('OWN LOGIN STILL WORKS');
  const su = await call('POST', '/api/auth/signup', { email: 'own@x.com', password: 'secret1' });
  ok(su.s === 200 && (await who(su.j.token)).via === 'backend', 'backend signup/login token still accepted');

  console.log(`\n${p} passed, ${f} failed`);
  io.close(); await db.end(); process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
