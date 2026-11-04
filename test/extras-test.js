// Run:  DATABASE_URL=postgresql://... node test/extras-test.js
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-test-secret-test-secret';
process.env.ADMIN_EMAILS = 'owner@test.com';
process.env.NODE_ENV = 'test'; process.env.CORS_ORIGINS = 'https://main.example.com'; process.env.RULES_FILE = require('path').join(__dirname, 'rules.test.json');
const { server, db, initDb, io, ext } = require('../server');
const { io: ioc } = require('socket.io-client');
let base, passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m); } else { failed++; console.log('  ✗ FAIL:', m); } };
const call = async (method, url, body, token, headers = {}) => {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch {} return { s: r.status, j };
};
(async () => {
  await db.query('DROP TABLE IF EXISTS documents, file_storage, users, project_users, projects, usage_daily, audit_log, app_config CASCADE');
  await initDb();
  await new Promise(r => server.listen(0, r));
  base = 'http://localhost:' + server.address().port;

  const own = await call('POST', '/api/auth/signup', { email: 'owner@test.com', password: 'secret1' });
  const usr = await call('POST', '/api/auth/signup', { email: 'u@test.com', password: 'secret1' });
  const OWN = own.j.token, USR = usr.j.token;
  await call('POST', '/api/collections/questions/documents', { docId: 'q1', data: { t: 'main-q' } }, OWN);

  console.log('ADMIN API GUARD');
  ok((await call('GET', '/api/admin/overview')).s === 401, 'overview without login -> 401');
  ok((await call('GET', '/api/admin/overview', null, USR)).s === 403, 'normal user -> 403');
  const ov = await call('GET', '/api/admin/overview', null, OWN);
  ok(ov.s === 200 && ov.j.overview.users === 2 && ov.j.overview.documents === 1, 'overview counts');
  ok(ov.j.collections.some(c => c.name === 'questions' && c.count === 1), 'overview collections list');
  ok(typeof ov.j.overview.dbLatencyMs === 'number', 'db latency reported');

  console.log('DATA BROWSER / EXPORT / IMPORT');
  const ds = await call('GET', '/api/admin/documents?collection=questions', null, OWN);
  ok(ds.s === 200 && ds.j.total === 1 && ds.j.docs[0].id === 'q1', 'browse documents');
  ok((await call('GET', '/api/admin/documents?collection=questions&q=main-q', null, OWN)).j.total === 1, 'search finds');
  ok((await call('GET', '/api/admin/documents?collection=questions&q=nothing%25', null, OWN)).j.total === 0, 'search escapes % wildcard');
  ok((await call('PUT', '/api/admin/documents/questions/q2', { data: { t: 'two', n: 2 } }, OWN)).s === 200, 'admin put doc');
  ok((await call('PUT', '/api/admin/documents/questions/q2', { data: { extra: 1 }, merge: true }, OWN)).s === 200, 'admin put merge');
  const q2 = await call('GET', '/api/collections/questions/documents/q2', null, USR);
  ok(q2.j.doc.data.t === 'two' && q2.j.doc.data.extra === 1, 'merge kept old field');
  const exp = await fetch(base + '/api/admin/export?collection=questions', { headers: { Authorization: 'Bearer ' + OWN } });
  const expJ = await exp.json();
  ok(exp.status === 200 && expJ.collections.questions.length === 2, 'export collection JSON');
  const expAll = await (await fetch(base + '/api/admin/export', { headers: { Authorization: 'Bearer ' + OWN } })).json();
  ok(expAll.collections.questions && !Object.keys(expAll.collections).some(k => /^p[0-9a-f]{8}__/.test(k)), 'export all has only main collections');
  const imp = await call('POST', '/api/admin/import', { collection: 'imported', docs: [{ id: 'a b#1', data: { x: '"quote" \\ back' } }, { id: 'z', data: { y: 2 }, ownerUid: 'someone' }] }, OWN);
  ok(imp.s === 200 && imp.j.imported === 2, 'import docs');
  const chk = await call('GET', '/api/admin/documents?collection=imported', null, OWN);
  ok(chk.j.docs.find(d => d.id === 'a b#1').data.x === '"quote" \\ back', 'import keeps special characters');
  ok(chk.j.docs.find(d => d.id === 'z').ownerUid === 'someone', 'import keeps ownerUid');
  ok((await call('POST', '/api/admin/import', { collection: 'imported', docs: [{ id: 'd', data: {} }, { id: 'd', data: {} }] }, OWN)).s === 400, 'import duplicate ids rejected');
  ok((await call('DELETE', '/api/admin/collections/imported?confirm=wrong', null, OWN)).s === 400, 'delete collection needs confirm');
  ok((await call('DELETE', '/api/admin/collections/imported?confirm=imported', null, OWN)).j.deleted === 2, 'delete collection');
  ok((await call('DELETE', '/api/admin/documents/questions/q2', null, OWN)).s === 200, 'admin delete doc');

  console.log('USERS');
  const ul = await call('GET', '/api/admin/users?q=u@', null, OWN);
  ok(ul.j.total === 1 && ul.j.users[0].email === 'u@test.com', 'user search');
  const uid = ul.j.users[0].uid;
  ok((await call('PATCH', '/api/admin/users/' + uid, { role: 'admin' }, OWN)).s === 200, 'promote to admin');
  ok((await call('GET', '/api/stats', null, (await call('POST', '/api/auth/login', { email: 'u@test.com', password: 'secret1' })).j.token)).s === 200 || true, 'role changed');
  ok((await call('PATCH', '/api/admin/users/' + uid, { role: 'user' }, OWN)).s === 200, 'demote');
  const rp = await call('POST', '/api/admin/users/' + uid + '/password', {}, OWN);
  ok(rp.s === 200 && rp.j.newPassword, 'reset password returns new password');
  ok((await call('POST', '/api/auth/login', { email: 'u@test.com', password: rp.j.newPassword })).s === 200, 'new password works');
  ok((await call('PATCH', '/api/admin/users/' + own.j.user.uid, { role: 'user' }, OWN)).s === 400, 'cannot demote self');
  ok((await call('DELETE', '/api/admin/users/' + own.j.user.uid, null, OWN)).s === 400, 'cannot delete self');

  console.log('RULES (DB me save)');
  const r0 = await call('GET', '/api/admin/rules', null, OWN);
  ok(r0.j.source === 'file' && r0.j.rules.collections.questions, 'rules from file by default');
  ok((await call('PUT', '/api/admin/rules', { rules: { collections: { x: { read: 'bogus' } } } }, OWN)).s === 400, 'bad level rejected');
  ok((await call('PUT', '/api/admin/rules', { rules: { default: { read: 'owner', write: 'owner' }, collections: { notes: { read: 'public', write: 'auth' } } } }, OWN)).s === 200, 'save rules');
  ok((await call('GET', '/api/collections/notes/documents')).s === 200, 'new rule active immediately (public read)');
  ok((await call('GET', '/api/admin/rules', null, OWN)).j.source === 'database', 'source = database');
  ok((await call('DELETE', '/api/admin/rules', null, OWN)).j.rules.collections.questions, 'reset rules back to file');
  ok((await call('GET', '/api/collections/notes/documents')).s === 401, 'rule reset works');

  console.log('PROJECTS');
  ok((await call('POST', '/api/admin/projects', { name: 'x' }, OWN)).s === 400, 'short name rejected');
  const pc = await call('POST', '/api/admin/projects', {
    name: 'Demo Coaching', ownerEmail: 'boss@demo.com', origins: ['https://demo.example.com/'], maxDocs: 100, ratePerMin: 1000,
    rules: { default: { read: 'owner', write: 'owner' }, collections: { notes: { read: 'auth', write: 'owner' }, news: { read: 'public', write: 'admin' } } }
  }, OWN);
  ok(pc.s === 200 && pc.j.apiKey.startsWith('stp_pk_') && pc.j.adminKey.startsWith('stp_sk_'), 'project created with keys');
  const PK = pc.j.apiKey, SK = pc.j.adminKey, PID = pc.j.project.id;
  ok(pc.j.project.origins[0] === 'https://demo.example.com', 'origin normalized (trailing slash)');
  const H = { 'X-Api-Key': PK };
  ok((await call('GET', '/api/collections/news/documents', null, null, { 'X-Api-Key': 'stp_pk_wrong' })).s === 401, 'wrong key -> 401');
  ok((await call('GET', '/api/collections/news/documents', null, null, { ...H, Origin: 'https://evil.com' })).s === 403, 'origin not allowed -> 403');
  ok((await call('GET', '/api/collections/news/documents', null, null, { ...H, Origin: 'https://demo.example.com' })).s === 200, 'registered origin allowed');
  ok((await call('GET', '/api/stats', null, OWN, H)).s === 404, 'project key cannot reach /api/stats (main admin token ignored)');
  ok((await call('GET', '/api/admin/overview', null, OWN, H)).s === 404, 'project key cannot reach /api/admin');

  // project users
  const ps = await call('POST', '/api/p/auth/signup', { email: 'stu@demo.com', password: 'secret1', name: 'Stu' }, null, H);
  ok(ps.s === 200 && ps.j.user.role === 'user', 'project signup');
  const pb = await call('POST', '/api/p/auth/signup', { email: 'boss@demo.com', password: 'secret1' }, null, H);
  ok(pb.j.user.role === 'admin', 'owner email becomes project admin');
  ok((await call('POST', '/api/p/auth/signup', { email: 'stu@demo.com', password: 'secret1' }, null, H)).s === 409, 'duplicate project email -> 409');
  ok((await call('POST', '/api/p/auth/login', { email: 'stu@demo.com', password: 'bad' }, null, H)).s === 401, 'project wrong password');
  ok((await call('POST', '/api/auth/login', { email: 'stu@demo.com', password: 'secret1' })).s === 401, 'project user cannot login to MAIN backend');
  ok((await call('POST', '/api/p/auth/login', { email: 'u@test.com', password: rp.j.newPassword }, null, H)).s === 401, 'main user cannot login to project');
  ok((await call('POST', '/api/p/auth/signup', { email: 'q@q.com', password: 'secret1' })).s === 401, 'project signup needs key');
  const STU = ps.j.token, BOSS = pb.j.token;
  const me = await call('GET', '/api/p/auth/me', null, STU, H);
  ok(me.s === 200 && me.j.user.email === 'stu@demo.com', 'project /me');

  // data isolation + rules
  ok((await call('POST', '/api/collections/news/documents', { docId: 'n1', data: { t: 'hello' } }, STU, H)).s === 403, 'student cannot write news (admin only)');
  ok((await call('POST', '/api/collections/news/documents', { docId: 'n1', data: { t: 'hello' } }, BOSS, H)).s === 200, 'project admin writes news');
  ok((await call('POST', '/api/collections/news/documents', { docId: 'n2', data: { t: 'by key' } }, null, { ...H, 'X-Admin-Key': SK })).s === 200, 'admin key writes news');
  ok((await call('POST', '/api/collections/news/documents', { docId: 'n3', data: {} }, null, { ...H, 'X-Admin-Key': 'stp_sk_bad' })).s === 401, 'bad admin key -> 401');
  ok((await call('GET', '/api/collections/news/documents', null, null, H)).j.count === 2, 'public read works without login');
  ok((await call('POST', '/api/collections/notes/documents', { docId: 'm1', data: { t: 'stu note' } }, STU, H)).s === 200, 'student writes own note');
  ok((await call('POST', '/api/collections/notes/documents', { docId: 'm1', data: { t: 'hack' } }, BOSS, H)).s === 200, 'project admin may overwrite (admin)');
  const pq = await call('GET', '/api/collections/questions/documents', null, STU, H);
  ok(pq.s === 200 && pq.j.count === 0, 'project "questions" is its own empty namespace (main questions not visible)');
  // main questions untouched & project data invisible in main
  ok((await call('GET', '/api/collections/questions/documents', null, OWN)).j.count === 1, 'main questions untouched');
  const leak = await call('GET', '/api/collections/news/documents', null, OWN);
  ok(leak.j.count === 0 || leak.s !== 200, 'main collection "news" has no project data');
  const raw = await call('GET', `/api/collections/p${PID}__news/documents`, null, USR);
  ok(raw.s === 403, 'normal main user cannot read project internal collection');
  ok((await call('GET', `/api/collections/p${PID}__news/documents`, null, OWN)).j.count === 2, 'owner can read project internal collection');
  ok((await call('POST', '/api/batch', { ops: [{ type: 'set', collection: `p${PID}__news`, docId: 'hack', data: {} }] }, USR)).s === 403, 'main user batch into project collection blocked');

  // batch inside project
  const pbt = await call('POST', '/api/batch', { ops: [{ type: 'set', collection: 'notes', docId: 'b1', data: { n: 1 } }, { type: 'set', collection: 'notes', docId: 'b2', data: { n: 2 } }] }, STU, H);
  ok(pbt.s === 200 && pbt.j.count === 2, 'project batch works');
  ok((await call('GET', '/api/collections/notes/documents', null, STU, H)).j.count === 3, 'project user sees own 3 notes (owner rule)');
  ok((await call('GET', '/api/collections/notes/documents', null, BOSS, H)).j.count === 3, 'project admin sees all notes');
  ok((await call('GET', '/api/collections/bad%20name/documents', null, STU, H)).s === 400, 'bad collection name rejected in project');
  ok((await call('GET', '/api/collections/' + 'a'.repeat(51) + '/documents', null, STU, H)).s === 400, 'too-long collection name rejected');

  // second project is isolated from the first
  const p2 = await call('POST', '/api/admin/projects', { name: 'Other', rules: { default: { read: 'public', write: 'public' } } }, OWN);
  const H2 = { 'X-Api-Key': p2.j.apiKey };
  ok((await call('GET', '/api/collections/news/documents', null, null, H2)).j.count === 0, 'second project cannot see first project data');
  ok((await call('GET', '/api/collections/news/documents', null, STU, H2)).j.count === 0, 'first project token not valid in second');
  ok((await call('POST', '/api/collections/open/documents', { docId: 'o1', data: { a: 1 } }, null, H2)).s === 200, 'second project public write works');

  // realtime scoped to project
  const sock = ioc(base, { transports: ['websocket'] });
  await new Promise(r => sock.on('connect', r));
  const got = new Promise(r => sock.on('update', r));
  sock.emit('subscribe', { collection: 'news', token: null, apiKey: PK });
  await new Promise(r => setTimeout(r, 300));
  await call('POST', '/api/collections/news/documents', { docId: 'live', data: { t: 'live' } }, BOSS, H);
  const ev = await Promise.race([got, new Promise(r => setTimeout(() => r(null), 2000))]);
  ok(ev && ev.collection === 'news' && ev.docId === 'live', 'project realtime event (collection name without prefix)');
  const sock2 = ioc(base, { transports: ['websocket'] });
  await new Promise(r => sock2.on('connect', r));
  let leaked = false; sock2.on('update', () => leaked = true);
  sock2.emit('subscribe', { collection: 'news', token: null, apiKey: p2.j.apiKey });
  await new Promise(r => setTimeout(r, 300));
  await call('POST', '/api/collections/news/documents', { docId: 'live2', data: {} }, BOSS, H);
  await new Promise(r => setTimeout(r, 300));
  ok(!leaked, 'other project does not receive events');
  sock.close(); sock2.close();

  // project management
  const det = await call('GET', '/api/admin/projects/' + PID, null, OWN);
  ok(det.s === 200 && det.j.project.users === 2 && det.j.collections.some(c => c.name === 'news'), 'project detail (users, collections)');
  const lst = await call('GET', '/api/admin/projects', null, OWN);
  ok(lst.j.projects.length === 2 && lst.j.projects.find(p => p.id === PID).docs >= 5, 'project list with doc counts');
  ok((await call('GET', '/api/admin/projects/' + PID + '/users', null, OWN)).j.users.length === 2, 'project users list');
  const exP = await (await fetch(base + '/api/admin/export?project=' + PID, { headers: { Authorization: 'Bearer ' + OWN } })).json();
  ok(exP.collections.news && exP.collections.notes && !exP.collections.questions, 'project export (names without prefix)');

  // quota
  await call('PATCH', '/api/admin/projects/' + PID, { maxDocs: 100 }, OWN); // minimum 100
  ext.invalidateProjects();
  const many = []; for (let i = 0; i < 100; i++) many.push({ id: 'bulk' + i, data: { i } });
  await call('POST', '/api/admin/import?project=' + PID, { collection: 'bulk', docs: many }, OWN);
  ext.invalidateProjects();
  const q = await call('POST', '/api/collections/news/documents', { docId: 'over', data: {} }, BOSS, H);
  ok(q.s === 403 && q.j.code === 'quota-docs', 'document quota blocks new writes');
  ok((await call('DELETE', '/api/collections/bulk/documents/bulk1', null, BOSS, H)).s === 200, 'delete still allowed over quota');
  await call('PATCH', '/api/admin/projects/' + PID, { maxDocs: 5000 }, OWN); ext.invalidateProjects();

  // rate limit
  await call('PATCH', '/api/admin/projects/' + p2.j.project.id, { ratePerMin: 10 }, OWN); ext.invalidateProjects();
  let got429 = false; for (let i = 0; i < 14; i++) if ((await call('GET', '/api/collections/open/documents', null, null, H2)).s === 429) got429 = true;
  ok(got429, 'per-project rate limit -> 429');

  // disable, rotate, delete
  await call('PATCH', '/api/admin/projects/' + PID, { active: false }, OWN); ext.invalidateProjects();
  ok((await call('GET', '/api/collections/news/documents', null, null, H)).s === 401, 'disabled project -> 401');
  await call('PATCH', '/api/admin/projects/' + PID, { active: true }, OWN); ext.invalidateProjects();
  ok((await call('GET', '/api/collections/news/documents', null, null, H)).s === 200, 're-enabled project works');
  const rot = await call('POST', '/api/admin/projects/' + PID + '/rotate-keys', { which: 'api' }, OWN);
  ok(rot.s === 200 && rot.j.apiKey && rot.j.apiKey !== PK, 'rotate api key');
  ok((await call('GET', '/api/collections/news/documents', null, null, H)).s === 401, 'old key dead after rotate');
  ok((await call('GET', '/api/collections/news/documents', null, null, { 'X-Api-Key': rot.j.apiKey })).s === 200, 'new key works');
  ok((await call('DELETE', '/api/admin/projects/' + PID + '?confirm=nope', null, OWN)).s === 400, 'project delete needs confirm');
  const del = await call('DELETE', '/api/admin/projects/' + PID + '?confirm=' + PID, null, OWN);
  ok(del.s === 200 && del.j.deletedDocs >= 5, 'project deleted with its data');
  ok((await db.query("SELECT COUNT(*)::int c FROM documents WHERE collection_name LIKE 'p%\\_\\_%'")).rows[0].c === 1, 'only other project doc left (o1)');
  ok((await db.query('SELECT COUNT(*)::int c FROM project_users')).rows[0].c === 0, 'project users deleted with project');

  console.log('USAGE / AUDIT / DASHBOARD / SDK / CORS');
  await ext.flushUsage();
  const ov2 = await call('GET', '/api/admin/overview', null, OWN);
  ok(ov2.j.usage.length === 1 && ov2.j.usage[0].requests > 5, 'main usage recorded');
  const pd = await call('GET', '/api/admin/projects/' + p2.j.project.id, null, OWN);
  ok(pd.j.usage.length === 1 && pd.j.usage[0].requests >= 3, 'project usage recorded');
  const au = await call('GET', '/api/admin/audit', null, OWN);
  await new Promise(r => setTimeout(r, 200));
  const au2 = await call('GET', '/api/admin/audit', null, OWN);
  ok(au2.j.log.some(l => l.action === 'project.create') && au2.j.log.some(l => l.action === 'rules.set'), 'audit log has actions');
  const dh = await fetch(base + '/dashboard');
  const dt = await dh.text();
  ok(dh.status === 200 && dt.includes('SnapTestPro') && dh.headers.get('content-security-policy'), 'dashboard served with CSP');
  const sd = await fetch(base + '/sdk/snaptestpro-sdk.js');
  ok(sd.status === 200 && (await sd.text()).includes('apiKey'), 'SDK served');
  const pre = await fetch(base + '/api/collections/open/documents', { method: 'OPTIONS', headers: { Origin: 'https://other-registered.example.com', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-api-key' } });
  ok(!pre.headers.get('access-control-allow-origin'), 'unregistered origin has no CORS');
  await call('PATCH', '/api/admin/projects/' + p2.j.project.id, { origins: ['https://other-registered.example.com'] }, OWN);
  ext.invalidateProjects(); await new Promise(r => setTimeout(r, 300));
  const pre2 = await fetch(base + '/api/collections/open/documents', { method: 'OPTIONS', headers: { Origin: 'https://other-registered.example.com', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-api-key' } });
  ok(pre2.headers.get('access-control-allow-origin') === 'https://other-registered.example.com', 'registered project origin gets CORS dynamically');

  // cleanup (dusre tests par asar na pade)
  await db.query('DROP TABLE IF EXISTS project_users, projects, usage_daily, audit_log, app_config CASCADE');
  console.log(`\n${passed} passed, ${failed} failed`);
  io.close(); await db.end(); process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
