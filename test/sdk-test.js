// Run:  DATABASE_URL=postgresql://... node test/sdk-test.js
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret'; process.env.ADMIN_EMAILS = 'admin@test.com'; process.env.NODE_ENV = 'test';
const store = {}; global.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; }, get length() { return Object.keys(store).length; } };
Object.defineProperty(global.localStorage, 'keys', { value: () => Object.keys(store) });
// SDK uses Object.keys(localStorage) -> make store enumerable on the shim
const shim = new Proxy(global.localStorage, { ownKeys: () => Object.keys(store), getOwnPropertyDescriptor: (t, k) => (k in store ? { enumerable: true, configurable: true, value: store[k] } : Reflect.getOwnPropertyDescriptor(t, k)) });
global.localStorage = shim;
global.io = require('socket.io-client').io;
const { server, db, initDb, io: sio } = require('../server');
const SnapTestPro = require('../sdk/snaptestpro-sdk.js');
let p = 0, f = 0; const ok = (c, m) => { c ? (p++, console.log('  ✓', m)) : (f++, console.log('  ✗ FAIL:', m)); };
(async () => {
  await db.query('DROP TABLE IF EXISTS documents, file_storage, users CASCADE'); await initDb();
  await new Promise(r => server.listen(0, r));
  const url = 'http://localhost:' + server.address().port;
  let fetches = 0; const of = global.fetch; global.fetch = (...a) => { fetches++; return of(...a); };

  const admin = new SnapTestPro(url);
  await admin.auth().createUserWithEmailAndPassword('admin@test.com', 'secret1', 'Admin');
  ok(admin.auth().currentUser.role === 'admin', 'sdk signup (admin)');
  for (const [i, s, m] of [['q1', 'math', 4], ['q2', 'chem', 2], ['q3', 'math', 6]]) await admin.collection('questions').doc(i).set({ subject: s, marks: m });
  const stu = new SnapTestPro(url);
  await stu.auth().createUserWithEmailAndPassword('stu@test.com', 'secret1', 'Stu');

  fetches = 0;
  const s1 = await stu.collection('questions').where('subject', '==', 'math').orderBy('marks', 'desc').limit(5).get();
  ok(s1.size === 2 && s1.docs[0].id === 'q3' && s1.docs[0].data().marks === 6, 'query where/orderBy/limit + doc.data()');
  const n1 = fetches;
  await stu.collection('questions').where('subject', '==', 'math').orderBy('marks', 'desc').limit(5).get();
  ok(fetches === n1, 'second get() served from cache (0 server reads)');
  await stu.collection('questions').where('subject', '==', 'math').orderBy('marks', 'desc').limit(5).get({ cache: 'reload' });
  ok(fetches === n1 + 1, "get({cache:'reload'}) hits server");

  const d = await stu.collection('results').add({ score: 50 });
  ok(d.id && d.data().score === 50, 'add() returns id + data');
  const g = await stu.collection('results').doc(d.id).get();
  ok(g.exists && g.data().score === 50, 'doc.get()');
  ok(!(await stu.collection('results').doc('missing').get()).exists, 'missing doc -> exists:false');
  try { await stu.collection('questions').doc('qx').set({ a: 1 }); ok(false, 'student write blocked'); } catch (e) { ok(e.status === 403, 'student write to questions blocked (403)'); }

  const b = stu.batch(); b.set(stu.collection('results').doc('b1'), { n: 1 }); b.set(stu.collection('results').doc('b2'), { n: 2 }); await b.commit();
  ok((await stu.collection('results').get()).size === 3, 'batch commit + cache invalidated on write');

  // realtime
  let last = null; const unsub = stu.collection('questions').onSnapshot(s => { last = s; });
  await new Promise(r => setTimeout(r, 800));
  ok(last && last.size === 3, 'onSnapshot initial snapshot');
  await admin.collection('questions').doc('q9').set({ subject: 'bio', marks: 1 });
  await new Promise(r => setTimeout(r, 600));
  ok(last.size === 4, 'onSnapshot live add');
  await admin.collection('questions').doc('q9').update({ marks: 9 });
  await new Promise(r => setTimeout(r, 600));
  ok(last.docs.find(x => x.id === 'q9').data().marks === 9 && last.docs.find(x => x.id === 'q9').data().subject === 'bio', 'onSnapshot live update merged');
  await admin.collection('questions').doc('q9').delete();
  await new Promise(r => setTimeout(r, 600));
  ok(last.size === 3, 'onSnapshot live delete');
  unsub();

  await stu.auth().signOut();
  ok(stu.auth().currentUser === null, 'signOut');
  try { await stu.collection('questions').get(); ok(false, 'anon blocked'); } catch (e) { ok(e.status === 401, 'anonymous read blocked after signOut'); }
  console.log(`\n${p} passed, ${f} failed`);
  sio.close(); await db.end(); process.exit(f ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
