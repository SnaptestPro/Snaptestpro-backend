// own-backend.js (frontend adapter) ko asli Firebase compat SDK ke Timestamp/FieldValue + real server ke saath test karta hai
const path = require('path'), crypto = require('crypto'), jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret'; process.env.NODE_ENV = 'test';
process.env.RULES_FILE = path.join(__dirname, '..', 'rules.json'); process.env.FIREBASE_PROJECT_ID = 'test-proj'; process.env.OWNER_EMAILS = 'owner@x.com';
const { server, db, initDb, io, __setFetch } = require('../server');
let firebase; try { firebase = require(path.join(__dirname, '..', '..', 'pgtest', 'node_modules', 'firebase', 'compat', 'app')); require(path.join(__dirname, '..', '..', 'pgtest', 'node_modules', 'firebase', 'compat', 'firestore')); }
catch (e) { firebase = null; }
if (!firebase) { console.log('SKIP: firebase@9.22.0 compat install nahi hai (npm i --no-save firebase@9.22.0)'); process.exit(0); }
const ioClient = require('socket.io-client').io;
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' });
const ADMINS = { 'admins/a@x.com': { active: true, instituteId: 'instA' } };
__setFetch(async (url, opts = {}) => {
  if (url.includes('x509/securetoken')) return { ok: true, status: 200, headers: { get: () => 'max-age=3600' }, json: async () => ({ kid1: PEM }) };
  const d = ADMINS[decodeURIComponent(url.split('/documents/')[1])];
  if (!d) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ fields: Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === 'boolean' ? { booleanValue: v } : { stringValue: v }])) }) };
});
const tok = (email) => jwt.sign({ firebase: { sign_in_provider: email ? 'password' : 'anonymous' }, ...(email ? { email } : {}) }, privateKey,
  { algorithm: 'RS256', keyid: 'kid1', subject: 'uid-' + (email || 'anon'), audience: 'test-proj', issuer: 'https://securetoken.google.com/test-proj', expiresIn: '1h' });
let p = 0, f = 0; const ok = (c, m) => { c ? (p++, console.log('  ✓', m)) : (f++, console.log('  ✗ FAIL:', m)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

(async () => {
  await db.query('DROP TABLE IF EXISTS documents, file_storage, users CASCADE'); await initDb();
  await new Promise(r => server.listen(0, r));
  // --- browser jaisa environment
  let current = tok('a@x.com'), sockets = [];
  global.firebase = firebase;
  global.io = (...a) => { const s = ioClient(...a, { transports: ['websocket'] }); sockets.push(s); return s; };
  global.SNAP_CONFIG = { ownBackend: { enabled: true, url: 'http://localhost:' + server.address().port, collections: ['questionBank', 'deletedQuestions'] } };
  global.vishnuFirebase = { authReady: Promise.resolve(), auth: { get currentUser() { return { getIdToken: async () => current }; } } };
  require('../frontend/own-backend.js');
  const realCalls = []; const realBatchOps = [];
  const fakeReal = { collection: n => ({ real: true, name: n, doc: id => ({ real: true, name: n, id }) }), doc: p => ({ real: true, path: p }), settings() { return 'settings-ok'; },
    batch: () => ({ set: (r) => { realBatchOps.push(['set', r.name]); }, update() {}, delete: (r) => { realBatchOps.push(['delete', r.name]); }, commit: async () => { realBatchOps.push(['commit']); } }) };
  const dbx = global.SnapOwnBackend.wrap(fakeReal);
  const FV = firebase.firestore.FieldValue, TS = firebase.firestore.Timestamp;
  const asAdmin = () => { current = tok('a@x.com'); }, asStudent = () => { current = tok(null); };

  console.log('ROUTING');
  ok(dbx.collection('tests').real === true, 'non-routed collection (tests) -> real Firebase');
  ok(dbx.collection('questionBank').real === undefined, 'routed collection (questionBank) -> own backend');
  ok(dbx.settings() === 'settings-ok', 'other db methods pass through to Firebase');
  ok(global.SnapOwnBackend.status().enabled && (await global.SnapOwnBackend.whoami()).role === 'admin', 'whoami shows firebase login as admin');

  console.log('DOCS (set/get/update/delete + Timestamp/serverTimestamp)');
  const qb = dbx.collection('questionBank');
  await qb.doc('q1').set({ text: 'Q1', subject: 'math', marks: 4, createdBy: 'a@x.com', createdAt: FV.serverTimestamp(), when: new Date(5000), ts: TS.fromMillis(7000), arr: [1, { n: 2 }], skip: undefined });
  let s = await qb.doc('q1').get();
  ok(s.exists && s.id === 'q1' && s.data().text === 'Q1', 'get() returns exists/id/data()');
  ok(s.data().createdAt instanceof TS && Math.abs(s.data().createdAt.toMillis() - Date.now()) < 5000, 'serverTimestamp -> real Timestamp (server time)');
  ok(s.data().when.toMillis() === 5000 && s.data().ts.toMillis() === 7000, 'Date and Timestamp round-trip');
  ok(s.get('arr')[1].n === 2 && !('skip' in s.data()), 'nested values ok, undefined skipped');
  ok(!(await qb.doc('nope').get()).exists, 'missing doc -> exists:false');
  await qb.doc('q1').update({ marks: 6 }); s = await qb.doc('q1').get();
  ok(s.data().marks === 6 && s.data().text === 'Q1', 'update merges top-level fields');
  await qb.doc('q1').set({ extra: 1 }, { merge: true }); ok((await qb.doc('q1').get()).data().extra === 1 && (await qb.doc('q1').get()).data().text === 'Q1', 'set merge');
  const added = await qb.add({ text: 'auto', subject: 'chem', marks: 1 });
  ok(added.id.length === 20 && (await added.get()).data().text === 'auto', 'add() creates 20-char id');
  let e = await rejects(() => qb.doc('nope').update({ a: 1 })); ok(e && e.code === 'not-found', 'update missing -> code not-found');
  e = await rejects(() => qb.doc('q1').update({ 'a.b': 1 })); ok(e && e.code === 'unimplemented', 'dotted update key -> clear error');
  e = await rejects(() => qb.doc('q1').update({ n: FV.increment(1) })); ok(e && e.code === 'unimplemented', 'FieldValue.increment -> clear error');
  e = await rejects(async () => qb.where('a', 'in', [1])); ok(e && e.code === 'unimplemented', "'in' query -> clear error");
  e = await rejects(async () => qb.doc('x').collection('sub')); ok(e && e.code === 'unimplemented', 'sub-collection -> clear error');

  console.log('PERMISSIONS (error codes like Firestore)');
  asStudent();
  e = await rejects(() => qb.doc('q9').set({ a: 1 })); ok(e && e.code === 'permission-denied', 'student write -> permission-denied');
  ok((await qb.doc('q1').get()).exists, 'student can read');
  e = await rejects(() => dbx.collection('deletedQuestions').get()); ok(e && e.code === 'permission-denied', 'student read admin-only -> permission-denied');
  asAdmin();

  console.log('QUERIES + PAGING');
  const ops = []; const bt = dbx.batch();
  for (let i = 0; i < 2500; i++) bt.set(qb.doc('b' + String(i).padStart(4, '0')), { n: i, subject: i % 2 ? 'math' : 'bio', d: new Date(i) });
  await bt.commit();
  let all = await qb.get(); ok(all.size === 2502 && !all.empty, 'batch of 2500 (chunked) + get() pages through 2502 docs');
  let q = await qb.where('subject', '==', 'math').orderBy('n', 'desc').limit(3).get();
  ok(q.size === 3 && q.docs[0].data().n === 2499, 'where + orderBy desc + limit');
  q = await qb.where('n', '>=', 2495).orderBy('n').get(); ok(q.size === 5 && q.docs[0].data().n === 2495, 'where >= with orderBy asc');
  q = await qb.where('d', '>=', new Date(2498)).get(); ok(q.size === 2, 'where with Date value');
  let n = 0; all.forEach(() => n++); ok(n === 2502, 'snapshot.forEach');

  console.log('LIVE onSnapshot');
  asStudent();
  const snaps = []; const unsub = qb.where('subject', '==', 'live').orderBy('n').limit(3).onSnapshot(sn => snaps.push(sn));
  await sleep(1500);
  ok(snaps.length >= 1 && snaps[0].size === 0 && snaps[0].empty, 'initial snapshot delivered (empty)');
  const base = snaps.length; asAdmin();
  await qb.doc('l2').set({ subject: 'live', n: 2 }); await sleep(500);
  let last = snaps[snaps.length - 1];
  ok(snaps.length === base + 1 && last.size === 1 && last.docChanges()[0].type === 'added' && last.docChanges()[0].doc.id === 'l2', 'added -> docChanges added');
  await qb.doc('l1').set({ subject: 'live', n: 1 }); await qb.doc('l3').set({ subject: 'live', n: 3 }); await sleep(500);
  last = snaps[snaps.length - 1]; ok(last.docs.map(d => d.id).join() === 'l1,l2,l3', 'live docs sorted by orderBy');
  await qb.doc('l0').set({ subject: 'live', n: 0 }); await sleep(500);
  last = snaps[snaps.length - 1];
  ok(last.docs.map(d => d.id).join() === 'l0,l1,l2' && last.docChanges().some(c => c.type === 'removed' && c.doc.id === 'l3'), 'limit(3): new top doc pushes l3 out (removed)');
  await qb.doc('l1').update({ n: 1.5, note: 'x' }); await sleep(500);
  last = snaps[snaps.length - 1]; ok(last.docChanges().some(c => c.type === 'modified' && c.doc.id === 'l1' && c.doc.data().note === 'x'), 'update -> modified');
  const cnt = snaps.length; await qb.doc('other').set({ subject: 'zzz', n: 0 }); await sleep(400);
  ok(snaps.length === cnt, 'non-matching doc does not trigger callback');
  await qb.doc('l2').update({ subject: 'zzz' }); await sleep(500);
  last = snaps[snaps.length - 1]; ok(last.docChanges().some(c => c.type === 'removed' && c.doc.id === 'l2'), 'doc stops matching -> removed');
  await qb.doc('l0').delete(); await sleep(500);
  last = snaps[snaps.length - 1]; ok(last.docChanges().some(c => c.type === 'removed' && c.doc.id === 'l0'), 'delete -> removed');

  console.log('RECONNECT (disconnect ke dauran hue changes)');
  const liveSock = sockets[0]; liveSock.disconnect(); await sleep(300);
  await qb.doc('l7').set({ subject: 'live', n: 7 }); await qb.doc('l1').delete(); await sleep(300);
  const before = snaps.length; liveSock.connect(); await sleep(2000);
  last = snaps[snaps.length - 1];
  ok(snaps.length > before && last.docs.map(d => d.id).join() === 'l3,l7', 'after reconnect listener catches up (added l7, removed l1)');
  unsub(); const c2 = snaps.length; await qb.doc('l9').set({ subject: 'live', n: 9 }); await sleep(400);
  ok(snaps.length === c2, 'unsubscribe stops callbacks');

  console.log('FIRST-LOAD DELTA (no gap)');
  const snaps2 = []; asStudent(); const u2 = qb.where('subject', '==', 'math').limit(2).onSnapshot(sn => snaps2.push(sn)); await sleep(1200);
  ok(snaps2.length >= 1 && snaps2[0].size === 2, 'limit(2) initial snapshot size 2'); u2();
  const errs = []; asStudent(); const u3 = dbx.collection('deletedQuestions').onSnapshot(() => {}, er => errs.push(er)); await sleep(800);
  ok(errs.length === 1 && errs[0].code === 'permission-denied', 'onSnapshot error callback gets permission-denied'); u3();

  console.log('BATCH mixed (own + firebase)');
  asAdmin(); const mb = dbx.batch();
  mb.set(qb.doc('m1'), { a: 1 }); mb.set(dbx.collection('tests').doc('t1'), { x: 1 }); mb.delete(dbx.collection('tests').doc('t2')); mb.delete(qb.doc('m1')); await mb.commit();
  ok(!(await qb.doc('m1').get()).exists && realBatchOps.some(o => o[0] === 'commit') && realBatchOps.filter(o => o[0] !== 'commit').length === 2, 'mixed batch: own ops applied, firebase ops sent to real batch');

  console.log('KILL SWITCH');
  global.SNAP_CONFIG.ownBackend.enabled = false;
  ok(dbx.collection('questionBank').real === true, 'enabled:false -> everything back on real Firebase');
  console.log(`\n${p} passed, ${f} failed`);
  sockets.forEach(x => x.close()); io.close(); await db.end(); process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
