// migrate-to-own-backend.html + .js ko nakli browser (jsdom) me chala kar test karta hai
const path = require('path'), fs = require('fs'), crypto = require('crypto'), jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret'; process.env.NODE_ENV = 'test';
process.env.RULES_FILE = path.join(__dirname, '..', 'rules.json'); process.env.FIREBASE_PROJECT_ID = 'test-proj'; process.env.OWNER_EMAILS = 'owner@x.com';
let JSDOM; try { ({ JSDOM } = require('/home/claude/pgtest/node_modules/jsdom')); } catch (e) { console.log('SKIP: jsdom install nahi hai (npm i --no-save jsdom)'); process.exit(0); }
const { server, db, initDb, io, __setFetch } = require('../server');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' });
const ADMINS = { 'admins/a@x.com': { active: true } };
__setFetch(async (url) => {
  if (url.includes('x509/securetoken')) return { ok: true, status: 200, headers: { get: () => 'max-age=3600' }, json: async () => ({ kid1: PEM }) };
  const d = ADMINS[decodeURIComponent(url.split('/documents/')[1])]; if (!d) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ fields: { active: { booleanValue: true } } }) };
});
const tok = email => jwt.sign({ firebase: { sign_in_provider: 'password' }, email }, privateKey, { algorithm: 'RS256', keyid: 'kid1', subject: 'uid-' + email, audience: 'test-proj', issuer: 'https://securetoken.google.com/test-proj', expiresIn: '1h' });
let p = 0, f = 0; const ok = (c, m) => { c ? (p++, console.log('  ✓', m)) : (f++, console.log('  ✗ FAIL:', m)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- nakli Firestore (700 docs, Timestamp jaisi objects, hindi id)
const mkTs = ms => ({ toMillis: () => ms, toDate: () => new Date(ms) });
function makeFs(store, failAfterPages) {
  let pages = 0;
  return { collection: name => { const st = { lim: 1e9, after: null };
    const q = { orderBy() { return q; }, limit(n) { st.lim = n; return q; }, startAfter(id) { st.after = id; return q; },
      async get(o) { if (failAfterPages != null && pages >= failAfterPages) { const e = new Error('Quota exceeded'); e.code = 'resource-exhausted'; throw e; }
        pages++; let ids = Object.keys(store[name] || {}).sort(); if (st.after != null) ids = ids.filter(i => i > st.after); ids = ids.slice(0, st.lim);
        return { empty: !ids.length, docs: ids.map(id => ({ id, data: () => store[name][id] })) }; } };
    return q; } };
}
const store = { questionBank: {}, deletedQuestions: {} };
for (let i = 0; i < 700; i++) store.questionBank['q' + String(i).padStart(4, '0')] = { text: 'Q' + i, n: i, createdAt: mkTs(1700000000000 + i), opts: ['a', 'b'], nested: { when: mkTs(5) } };
store.questionBank['प्रश्न 1'] = { text: 'hindi id', createdAt: mkTs(9) };
store.deletedQuestions['d1'] = { text: 'gone', _deletedAt: mkTs(77) };

(async () => {
  await db.query('DROP TABLE IF EXISTS documents, file_storage, users CASCADE'); await initDb();
  await new Promise(r => server.listen(0, r));
  const url = 'http://localhost:' + server.address().port;
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'migrate-to-own-backend.html'), 'utf8').replace(/<script src="[^"]*"><\/script>/g, '');
  const code = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'migrate-to-own-backend.js'), 'utf8');

  async function boot(email, fsStore, failAfter) {
    const dom = new JSDOM(html, { url: 'https://snaptestpro.github.io/migrate-to-own-backend.html', runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window; w.fetch = (...a) => fetch(...a); w.TextEncoder = TextEncoder;
    w.SNAP_CONFIG = { ownBackend: { url, collections: ['questionBank', 'deletedQuestions'] } };
    const user = email ? { isAnonymous: false, email, getIdToken: async () => tok(email) } : null;
    w.vishnuFirebase = { authReady: Promise.resolve(user), auth: { get currentUser() { return user; }, signOut: async () => {} } };
    w.firebase = { firestore: Object.assign(() => makeFs(fsStore, failAfter), { FieldPath: { documentId: () => '__name__' } }) };
    w.eval(code); await sleep(400); return w;
  }

  console.log('UI: owner login -> check');
  let w = await boot('owner@x.com', store);
  await sleep(800);
  ok(/owner/.test(w.document.getElementById('checkOut').textContent), 'check shows role owner');
  ok(w.document.getElementById('btnCopy').disabled === false, 'copy button enabled for owner');
  ok(w.document.querySelectorAll('.cc').length === 2, 'collections checklist shown');

  console.log('UI: non-owner blocked');
  const wa = await boot('a@x.com', store); await sleep(800);
  ok(/Owner/.test(wa.document.getElementById('checkOut').textContent) && wa.document.getElementById('btnCopy').disabled === true, 'admin (not owner): copy disabled with explanation');

  console.log('COPY via button');
  w.document.getElementById('btnCopy').click();
  for (let i = 0; i < 80 && w.document.getElementById('c4').style.display === 'none'; i++) await sleep(250);
  const doneTxt = w.document.getElementById('done').textContent;
  ok(w.document.getElementById('c4').style.display !== 'none' && /701/.test(doneTxt) && /✓/.test(doneTxt), 'done table shows 701 and checkmark');
  const g = await (await fetch(url + '/api/collections/questionBank/documents/q0005', { headers: { Authorization: 'Bearer ' + tok('owner@x.com') } })).json();
  ok(g.doc.data.createdAt.__ts === 1700000000005 && g.doc.data.nested.when.__ts === 5 && g.doc.data.opts[1] === 'b', 'Timestamps converted to {__ts}, arrays/nested ok');
  const h = await (await fetch(url + '/api/collections/questionBank/documents/' + encodeURIComponent('प्रश्न 1'), { headers: { Authorization: 'Bearer ' + tok('owner@x.com') } })).json();
  ok(h.doc && h.doc.data.text === 'hindi id', 'hindi document id copied');
  const d1 = await (await fetch(url + '/api/collections/deletedQuestions/documents/d1', { headers: { Authorization: 'Bearer ' + tok('owner@x.com') } })).json();
  ok(d1.doc.data._deletedAt.__ts === 77, 'second collection copied');

  console.log('QUOTA STOP + RESUME');
  await db.query('DELETE FROM documents');
  const w2 = await boot('owner@x.com', store, 1); // sirf 1 page (300 docs) padhne ke baad quota khatam
  let err = null; try { await w2.SnapMigrate.copyCollection('questionBank', { resume: false }); } catch (e) { err = e; }
  const cnt1 = (await (await fetch(url + '/api/collections/questionBank/count', { headers: { Authorization: 'Bearer ' + tok('owner@x.com') } })).json()).count;
  ok(err && err.code === 'resource-exhausted' && cnt1 === 300, 'stopped on quota error after first page (300 copied)');
  ok(w2.localStorage.getItem('snapMigrate:questionBank') === 'q0299', 'progress remembered (last id q0299)');
  const w3 = await boot('owner@x.com', store); w3.localStorage.setItem('snapMigrate:questionBank', 'q0299');
  const r = await w3.SnapMigrate.copyCollection('questionBank', { resume: true });
  const cnt2 = (await (await fetch(url + '/api/collections/questionBank/count', { headers: { Authorization: 'Bearer ' + tok('owner@x.com') } })).json()).count;
  ok(r.total === 401 && cnt2 === 701, 'resume copied remaining 401 -> total 701, no duplicates');
  ok(w3.localStorage.getItem('snapMigrate:questionBank') === null, 'progress cleared after finish');
  const r2 = await w3.SnapMigrate.copyCollection('questionBank', { resume: false });
  const cnt3 = (await (await fetch(url + '/api/collections/questionBank/count', { headers: { Authorization: 'Bearer ' + tok('owner@x.com') } })).json()).count;
  ok(r2.total === 701 && cnt3 === 701, 'running again is safe (overwrites, still 701)');

  console.log(`\n${p} passed, ${f} failed`);
  io.close(); await db.end(); process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
