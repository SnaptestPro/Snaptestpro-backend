// Run:  DATABASE_URL=postgresql://... node test/dashboard-test.js   (jsdom chahiye: npm i --no-save jsdom)
let JSDOM; try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP: jsdom install nahi hai (npm i --no-save jsdom)'); process.exit(0); }
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-test-secret-test-secret';
process.env.ADMIN_EMAILS = 'owner@test.com';
process.env.NODE_ENV = 'test'; process.env.RULES_FILE = require('path').join(__dirname, 'rules.test.json');
const { server, db, initDb, io } = require('../server');
let base, passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  ✓', m); } else { failed++; console.log('  ✗ FAIL:', m); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await db.query('DROP TABLE IF EXISTS documents, file_storage, users, project_users, projects, usage_daily, audit_log, app_config CASCADE');
  await initDb();
  await new Promise(r => server.listen(0, r));
  base = 'http://localhost:' + server.address().port;
  await fetch(base + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@test.com', password: 'secret1' }) });
  const tk = (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@test.com', password: 'secret1' }) })).json()).token;
  await fetch(base + '/api/admin/documents/questions/q1', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk }, body: JSON.stringify({ data: { text: '<img src=x onerror=alert(1)>' } }) });

  const errors = [];
  const dom = await JSDOM.fromURL(base + '/dashboard', {
    runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w) {
      w.fetch = (u, o) => fetch(new URL(u, base).href, o);
      w.confirm = () => true; w.prompt = (m, d) => d || 'both';
      w.addEventListener('error', e => errors.push(e.message));
      w.navigator.clipboard = { writeText: async () => {} };
    }
  });
  const w = dom.window, d = w.document;
  const $ = s => d.querySelector(s);
  const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const text = () => d.body.textContent;

  console.log('LOGIN');
  await sleep(100);
  ok(!$('#login').classList.contains('hide'), 'login screen shown first');
  $('#lg-email').value = 'nobody@x.com'; $('#lg-pass').value = 'wrongpw'; click($('#lg-go')); await sleep(400);
  ok($('#lg-err').textContent.length > 0 && $('#app').classList.contains('hide'), 'wrong login shows error');
  $('#lg-email').value = 'normal@test.com'; $('#lg-pass').value = 'secret1'; click($('#lg-su')); await sleep(600);
  ok($('#lg-err').textContent.includes('admin nahi'), 'non-admin account gets clear message');
  $('#lg-email').value = 'owner@test.com'; $('#lg-pass').value = 'secret1'; click($('#lg-go')); await sleep(700);
  ok(!$('#app').classList.contains('hide') && $('#who').textContent === 'owner@test.com', 'owner login opens dashboard');

  console.log('TABS');
  ok(text().includes('Users (main)') && text().includes('questions'), 'overview shows stats + collections');
  const tabs = [...d.querySelectorAll('#nav button')];
  ok(tabs.length === 8, '8 tabs');
  for (const t of tabs) { click(t); await sleep(350); ok(!$('#main').textContent.includes('Dikkat'), 'tab "' + t.dataset.tab + '" loads without error'); }

  console.log('DATA');
  click(tabs[1]); await sleep(500);
  ok($('#d-res').textContent.includes('q1'), 'data tab lists doc q1');
  ok(!$('#d-res').querySelector('img'), 'XSS: HTML in data is escaped (no <img> injected)');
  click($('#d-res tr.click')); await sleep(100);
  ok($('#m-json') && $('#m-json').value.includes('onerror'), 'doc editor opens');
  $('#m-json').value = '{"text":"edited"}'; click($('#m-save')); await sleep(500);
  ok($('#d-res').textContent.includes('edited'), 'edit saved and list refreshed');
  click([...d.querySelectorAll('[data-act="new-doc"]')][0]); await sleep(100);
  $('#m-id').value = 'q2'; $('#m-json').value = '{"a":1}'; click($('#m-save')); await sleep(500);
  ok($('#d-res').textContent.includes('q2'), 'new doc created');

  console.log('PROJECTS');
  click(tabs[4]); await sleep(300);
  click([...d.querySelectorAll('[data-act="p-new"]')][0]); await sleep(100);
  $('#np-name').value = 'Raj Coaching'; $('#np-owner').value = 'raj@x.com'; $('#np-origins').value = 'https://raj.example.com';
  click($('#np-go')); await sleep(700);
  const keyInputs = [...d.querySelectorAll('#ov input[readonly]')].map(i => i.value);
  ok(keyInputs.length === 2 && keyInputs[0].startsWith('stp_pk_') && keyInputs[1].startsWith('stp_sk_'), 'keys shown once after create');
  ok(d.querySelector('#ov pre.code').textContent.includes(keyInputs[0]), 'integration snippet contains the new API key');
  const apiKey = keyInputs[0];
  click($('#k-x')); await sleep(300);
  ok($('#main').textContent.includes('Raj Coaching'), 'project card listed');
  // project actually works with that key
  const pr = await fetch(base + '/api/p/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey }, body: JSON.stringify({ email: 'raj@x.com', password: 'secret1' }) });
  ok(pr.status === 200, 'key from dashboard works on API');
  click($('#main [data-act="p-open"]')); await sleep(600);
  ok($('#ov') && $('#ov').textContent.includes('raj@x.com'), 'project modal shows project user');
  click($('#pm-toggle')); await sleep(500);
  ok((await fetch(base + '/api/p/info', { headers: { 'X-Api-Key': apiKey } })).status === 401, 'toggle OFF blocks key');
  click($('#main [data-act="p-open"]')); await sleep(500);
  click($('#pm-del')); await sleep(600); // prompt() returns default 'both' -> confirm mismatch, nothing deleted
  ok((await db.query('SELECT COUNT(*)::int c FROM projects')).rows[0].c === 1, 'delete needs exact id confirm');

  console.log('RULES / TOOLS');
  click(tabs[3]); await sleep(300);
  ok($('#r-json').value.includes('questions'), 'rules shown');
  click(tabs[7]); await sleep(200);
  $('#t-p').value = '/api/health'; click($('#t-go')); await sleep(500);
  ok($('#t-out').textContent.includes('healthy'), 'API tester works');

  ok(errors.length === 0, 'no JS errors in page (' + errors.join('; ') + ')');
  console.log(`\n${passed} passed, ${failed} failed`);
  dom.window.close(); io.close();
  await db.query('DROP TABLE IF EXISTS project_users, projects, usage_daily, audit_log, app_config CASCADE');
  await db.end(); process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
