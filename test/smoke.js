// Run:  DATABASE_URL=postgresql://... npm test
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-test-secret-test-secret';
process.env.ADMIN_EMAILS = 'admin@test.com';
process.env.NODE_ENV = 'test'; process.env.RULES_FILE = require('path').join(__dirname, 'rules.test.json');
const { server, db, initDb, io } = require('../server');
const { io: ioc } = require('socket.io-client');
let base, passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m); } else { failed++; console.log('  ✗ FAIL:', m); } };
const call = async (method, url, body, token) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j };
};
(async () => {
  await db.query('DROP TABLE IF EXISTS documents, file_storage, users CASCADE');
  await initDb();
  await new Promise(r => server.listen(0, r));
  base = 'http://localhost:' + server.address().port;

  console.log('AUTH');
  const adm = await call('POST', '/api/auth/signup', { email: 'Admin@test.com', password: 'secret1', name: 'Admin' });
  ok(adm.s === 200 && adm.j.user.role === 'admin', 'admin email -> admin role');
  const a = await call('POST', '/api/auth/signup', { email: 'a@test.com', password: 'secret1', name: 'A' });
  const b = await call('POST', '/api/auth/signup', { email: 'b@test.com', password: 'secret1', name: 'B' });
  ok(a.s === 200 && a.j.token, 'signup works (body parse ok)');
  ok((await call('POST', '/api/auth/signup', { email: 'a@test.com', password: 'secret1' })).s === 409, 'duplicate email -> 409');
  ok((await call('POST', '/api/auth/login', { email: 'a@test.com', password: 'wrong' })).s === 401, 'wrong password -> 401');
  const lg = await call('POST', '/api/auth/login', { email: 'a@test.com', password: 'secret1' });
  ok(lg.s === 200 && lg.j.token, 'login works');
  ok((await call('GET', '/api/auth/me', null, lg.j.token)).j.user.email === 'a@test.com', '/me works');
  ok((await call('GET', '/api/auth/me')).s === 401, '/me without token -> 401');
  const A = a.j.token, B = b.j.token, ADM = adm.j.token;

  console.log('RULES (questions: auth read / admin write)');
  ok((await call('POST', '/api/collections/questions/documents', { docId: 'q1', data: { text: '2+2', subject: 'math', marks: 4 } }, A)).s === 403, 'normal user cannot write questions');
  ok((await call('POST', '/api/collections/questions/documents', { docId: 'q1', data: { text: '2+2', subject: 'math', marks: 4 } }, ADM)).s === 200, 'admin can write questions');
  await call('POST', '/api/collections/questions/documents', { docId: 'q2', data: { text: 'H2O?', subject: 'chem', marks: 2 } }, ADM);
  await call('POST', '/api/collections/questions/documents', { docId: 'q3', data: { text: 'sin', subject: 'math', marks: 6 } }, ADM);
  ok((await call('GET', '/api/collections/questions/documents')).s === 401, 'anonymous cannot read questions');
  ok((await call('GET', '/api/collections/questions/documents', null, A)).j.count === 3, 'logged-in user reads questions');

  console.log('QUERIES');
  const q1 = await call('GET', '/api/collections/questions/documents?where=subject:eq:math', null, A);
  ok(q1.j.count === 2, 'where subject:eq:math -> 2');
  const q2 = await call('GET', '/api/collections/questions/documents?where=marks:gte:4&where=subject:eq:math&orderBy=marks:desc', null, A);
  ok(q2.j.count === 2 && q2.j.docs[0].id === 'q3', 'two wheres + orderBy desc (numeric order)');
  const q3 = await call('GET', '/api/collections/questions/documents?where=subject=chem', null, A);
  ok(q3.j.count === 1, 'legacy where=field=value works');
  ok((await call('GET', "/api/collections/questions/documents?where=subject'%3B%20DROP%20TABLE%20users--:eq:x", null, A)).s === 400, 'SQL injection in field name rejected');
  const inj = await call('GET', "/api/collections/questions/documents?where=subject:eq:x'%20OR%20'1'='1", null, A);
  ok(inj.s === 200 && inj.j.count === 0, 'SQL injection in value is harmless');
  ok((await db.query('SELECT COUNT(*)::int c FROM users')).rows[0].c === 3, 'users table intact');
  const t0 = new Date(Date.now() + 1000).toISOString();
  ok((await call('GET', '/api/collections/questions/documents?since=' + encodeURIComponent(t0), null, A)).j.count === 0, 'delta sync (since) returns nothing new');
  ok((await call('GET', '/api/collections/questions/documents?limit=1', null, A)).j.count === 1, 'limit works');

  console.log('OWNERSHIP (results: owner/owner)');
  ok((await call('POST', '/api/collections/results/documents', { docId: 'r1', data: { score: 80 } }, A)).s === 200, 'A creates result');
  ok((await call('POST', '/api/collections/results/documents', { docId: 'r1', data: { score: 100 } }, B)).s === 403, 'B cannot overwrite A doc');
  ok((await call('PATCH', '/api/collections/results/documents/r1', { data: { score: 1 } }, B)).s === 403, 'B cannot update A doc');
  ok((await call('DELETE', '/api/collections/results/documents/r1', null, B)).s === 403, 'B cannot delete A doc');
  ok((await call('GET', '/api/collections/results/documents/r1', null, B)).s === 403, 'B cannot read A doc');
  ok((await call('GET', '/api/collections/results/documents', null, B)).j.count === 0, 'B list shows only own docs');
  const pu = await call('PATCH', '/api/collections/results/documents/r1', { data: { grade: 'A' } }, A);
  ok(pu.s === 200 && pu.j.doc.data.score === 80 && pu.j.doc.data.grade === 'A', 'PATCH merges fields');
  ok((await call('GET', '/api/collections/results/documents', null, A)).j.count === 1, 'A sees own doc');
  ok((await call('GET', '/api/collections/results/documents', null, ADM)).j.count === 1, 'admin sees all');
  ok((await call('PATCH', '/api/collections/results/documents/nope', { data: { x: 1 } }, A)).s === 404, 'update missing -> 404');

  console.log('BATCH');
  const bt = await call('POST', '/api/batch', { ops: [
    { type: 'set', collection: 'results', docId: 'b1', data: { n: 1 } },
    { type: 'set', collection: 'results', docId: 'b2', data: { n: 2 } },
    { type: 'delete', collection: 'results', docId: 'b1' }] }, A);
  ok(bt.s === 200 && bt.j.count === 3, 'batch commits');
  const bad = await call('POST', '/api/batch', { ops: [
    { type: 'set', collection: 'results', docId: 'b3', data: { n: 3 } },
    { type: 'set', collection: 'questions', docId: 'x', data: {} }] }, A);
  ok(bad.s === 403, 'batch with forbidden op fails');
  ok((await call('GET', '/api/collections/results/documents/b3', null, A)).s === 404, 'batch rolled back (b3 not saved)');

  console.log('REALTIME');
  const sock = ioc(base, { transports: ['websocket'] });
  await new Promise(r => sock.on('connect', r));
  const got = new Promise(r => sock.on('update', r));
  sock.emit('subscribe', { collection: 'questions', token: A });
  await new Promise(r => setTimeout(r, 300));
  await call('POST', '/api/collections/questions/documents', { docId: 'q9', data: { text: 'live' } }, ADM);
  const ev = await Promise.race([got, new Promise(r => setTimeout(() => r(null), 2000))]);
  ok(ev && ev.docId === 'q9' && ev.action === 'set', 'subscriber receives live update');
  const sockB = ioc(base, { transports: ['websocket'] });
  await new Promise(r => sockB.on('connect', r));
  let leaked = false; sockB.on('update', () => leaked = true);
  sockB.emit('subscribe', { collection: 'results', token: B });
  await new Promise(r => setTimeout(r, 300));
  await call('POST', '/api/collections/results/documents', { docId: 'r9', data: { s: 1 } }, A);
  await new Promise(r => setTimeout(r, 400));
  ok(!leaked, "B does not receive A's private result updates");
  sock.close(); sockB.close();

  console.log('STORAGE');
  const fd = new FormData(); fd.append('file', new Blob([Buffer.from('%PDF-1.4 test')], { type: 'application/pdf' }), 'a.pdf');
  const up = await fetch(base + '/api/storage/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + A }, body: fd }).then(r => r.json());
  ok(up.success && up.file.url.includes('/uploads/'), 'PDF upload works');
  const dl = await fetch(up.file.url.replace(/^https?:\/\/[^/]+/, base));
  ok(dl.status === 200 && (await dl.text()).startsWith('%PDF'), 'uploaded file downloadable');
  const fd2 = new FormData(); fd2.append('file', new Blob(['<script>x</script>'], { type: 'text/html' }), 'x.html');
  ok((await fetch(base + '/api/storage/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + A }, body: fd2 })).status === 400, 'HTML upload rejected');
  const fd3 = new FormData(); fd3.append('file', new Blob(['x'], { type: 'application/pdf' }), 'a.pdf');
  ok((await fetch(base + '/api/storage/upload', { method: 'POST', body: fd3 })).status === 401, 'upload without login rejected');

  console.log('MISC');
  ok((await call('GET', '/api/health')).j.status === 'healthy', 'health ok');
  ok((await call('GET', '/api/ping')).j.ok === true, 'ping ok');
  ok((await call('GET', '/api/stats', null, A)).s === 403, 'stats admin only');
  ok((await call('GET', '/api/stats', null, ADM)).j.stats.users === 3, 'stats for admin');
  ok((await call('GET', '/api/collections/bad%20name/documents', null, A)).s === 400, 'bad collection name rejected');

  console.log(`\n${passed} passed, ${failed} failed`);
  io.close(); await db.end(); process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
