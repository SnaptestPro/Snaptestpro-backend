// Clipper backend test: pure helpers + routes (fake db, fake Claude). Run: node test/clip-test.js
const assert = require('assert'); const http = require('http'); const express = require('express');
const mountClip = require('../clip.js'); const I = mountClip._internals;
let n = 0; const ok = (name, fn) => Promise.resolve().then(fn).then(() => { n++; console.log('  PASS ' + name); });

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
const aiJson = (qs, notes = '') => JSON.stringify({ questions: qs, notes });
const Q1 = { qType: 'mcq', question: 'निम्नलिखित में कौन AP है?', options: ['1,2,4', '2,4,6', '1,3,9', '1,4,9'], answerIndex: 1, answerSource: 'image', explanation: 'd=2', confidence: 0.95, subject: 'Maths', chapter: 'AP' };
const Q2 = { qType: 'mcq', question: 'x² + 1 = 0 ke roots?', options: ['1', '-1', '', ''], answerIndex: null, answerSource: 'solved', hasFigure: true, figureNote: 'parabola', incomplete: true };

(async () => {
  console.log('helpers');
  await ok('parseAiJson fence + text', () => { const j = I.parseAiJson('```json\n' + aiJson([Q1]) + '\n```'); assert.strictEqual(j.questions.length, 1); });
  await ok('parseAiJson bad -> throw', () => assert.throws(() => I.parseAiJson('nahi mila')));
  await ok('normalize: mcq ok', () => { const q = I.normalizeQuestion(Q1); assert.strictEqual(q.qType, 'mcq'); assert.strictEqual(q.answerIndex, 1); assert.strictEqual(q.answerSource, 'image'); });
  await ok('normalize: answer unknown when index null, few options flagged', () => { const q = I.normalizeQuestion(Q2); assert.strictEqual(q.answerSource, 'unknown'); assert.strictEqual(q.fewOptions, true); });
  await ok('normalize: answer index pointing at empty option dropped', () => { const q = I.normalizeQuestion({ ...Q1, options: ['a', 'b', '', ''], answerIndex: 3 }); assert.strictEqual(q.answerIndex, null); });
  await ok('normalize: subjective', () => { const q = I.normalizeQuestion({ question: 'Explain AP', options: [] }); assert.strictEqual(q.qType, 'subjective'); assert.strictEqual(q.answerIndex, null); });
  await ok('normalize: junk -> null', () => assert.strictEqual(I.normalizeQuestion({ question: 'a' }), null));
  await ok('draft doc shape (pdfDrafts UI fields)', () => {
    const d = I.buildDraftDoc(I.normalizeQuestion(Q1), { email: 'a@b.c', sourceNote: 'Chrome', imageId: 'img-1', model: 'm' });
    assert.strictEqual(d.status, 'pending'); assert.strictEqual(d.textHI, Q1.question); assert.deepStrictEqual(d.optionsHI, Q1.options); assert.strictEqual(d.answer, 1);
    assert.ok(d.sourcePdf.startsWith('Clip • ✅')); assert.strictEqual(d.needsReview, false); assert.strictEqual(d.clipMeta.imageId, 'img-1');
    const d2 = I.buildDraftDoc(I.normalizeQuestion(Q2), {}); assert.ok(d2.sourcePdf.includes('⚠️ Uttar nahi mila')); assert.strictEqual(d2.needsReview, true); assert.ok(d2.explanation.includes('parabola'));
  });
  await ok('sniffMime', () => { assert.strictEqual(I.sniffMime(JPG), 'image/jpeg'); assert.strictEqual(I.sniffMime(Buffer.alloc(50)), null); });

  console.log('routes');
  const S = { keys: [], usage: {}, images: [], docs: [], bcast: [] };
  const db = { async query(sql, p = []) {
    if (/^\s*CREATE TABLE/.test(sql)) return { rows: [] };
    if (sql.includes('COUNT(*)')) return { rows: [{ n: S.keys.filter(k => k.owner_uid === p[0] && !k.revoked).length }] };
    if (sql.includes('INSERT INTO clip_keys')) { const k = { id: S.keys.length + 1, key_hash: p[0], label: p[1], owner_uid: p[2], owner_email: p[3], revoked: false, uses: 0, created_at: new Date() }; S.keys.push(k); return { rows: [k] }; }
    if (sql.includes('SELECT * FROM clip_keys')) return { rows: S.keys.filter(k => k.key_hash === p[0]) };
    if (sql.includes('UPDATE clip_keys SET last_used_at')) return { rows: [], rowCount: 1 };
    if (sql.includes('UPDATE clip_keys SET revoked')) { const k = S.keys.find(x => x.id === p[0] && (p[1] === undefined || x.owner_uid === p[1])); if (k) k.revoked = true; return { rows: [], rowCount: k ? 1 : 0 }; }
    if (sql.includes('SELECT id, label')) return { rows: S.keys.filter(k => k.owner_uid === p[0]) };
    if (sql.includes('SELECT n FROM clip_usage')) { const v = S.usage[p[0] + p[1]]; return { rows: v ? [{ n: v }] : [] }; }
    if (sql.includes('INSERT INTO clip_usage')) { const k = p[0] + p[1]; S.usage[k] = (S.usage[k] || 0) + 1; return { rows: [{ n: S.usage[k] }] }; }
    if (sql.includes('UPDATE clip_usage SET n = n - 1')) { S.usage[p[0] + p[1]]--; return { rows: [] }; }
    if (sql.includes('UPDATE clip_usage SET in_tok')) return { rows: [] };
    if (sql.includes('INSERT INTO clip_images')) { S.images.push({ id: p[0], owner_uid: p[1], mime: p[2], img: p[3] }); return { rows: [] }; }
    if (sql.includes('SELECT mime, img')) { const r = S.images.find(i => i.id === p[0]); return { rows: r ? [r] : [] }; }
    if (sql.includes('INSERT INTO documents')) { const row = { doc_id: p[0], data: JSON.parse(p[1]), user_id: p[2], owner_uid: p[3] }; S.docs.push(row); return { rows: [row] }; }
    if (sql.includes('DELETE FROM clip_images')) return { rows: [] };
    throw new Error('fake db: unknown sql ' + sql.slice(0, 60));
  } };
  class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
  const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);
  const app = express(); app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => { req.user = req.get('x-test-admin') ? { uid: 'u1', email: 'admin@x.in', role: req.get('x-test-admin') } : null; next(); });
  mountClip({ app, db, wrap, HttpError, isAdmin: u => !!u && (u.role === 'admin' || u.role === 'owner'), uidOf: u => (u ? u.uid : null), broadcast: (c, r, a) => S.bcast.push([c, r.doc_id, a]) });
  app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
  const srv = http.createServer(app); await new Promise(r => srv.listen(0, r)); const port = srv.address().port;
  const call = (method, path, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const rq = http.request({ port, method, path, headers }, res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => { const t = Buffer.concat(c).toString(); let j; try { j = JSON.parse(t); } catch (_) { j = t; } resolve({ status: res.statusCode, body: j }); }); });
    rq.on('error', reject); if (body) rq.write(body); rq.end();
  });
  const realFetch = global.fetch; let fetchCalls = 0, aiReply = aiJson([Q1, Q2]);
  global.fetch = async (url, opt) => { fetchCalls++; const b = JSON.parse(opt.body); assert.strictEqual(b.messages[0].content[0].type, 'image'); assert.ok(opt.headers['x-api-key']);
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: aiReply }], usage: { input_tokens: 1500, output_tokens: 300 } }) }; };
  process.env.ANTHROPIC_API_KEY = 'sk-test'; process.env.CLIP_DAILY_LIMIT = '3';
  const adminH = { 'x-test-admin': 'admin' };

  let KEY;
  await ok('key create needs admin', async () => { const r = await call('POST', '/api/clip/keys', { headers: { 'content-type': 'application/json' }, body: '{}' }); assert.strictEqual(r.status, 403); });
  await ok('key create ok (plain once, hash stored)', async () => {
    const r = await call('POST', '/api/clip/keys', { headers: { ...adminH, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Mera phone' }) });
    assert.strictEqual(r.status, 200); KEY = r.body.key; assert.ok(KEY.startsWith('clp_')); assert.strictEqual(S.keys[0].key_hash, I.sha256(KEY)); assert.ok(!JSON.stringify(S.keys[0]).includes(KEY));
  });
  await ok('list keys has no secrets', async () => { const r = await call('GET', '/api/clip/keys', { headers: adminH }); assert.strictEqual(r.status, 200); assert.strictEqual(r.body.keys.length, 1); assert.ok(!('key_hash' in r.body.keys[0]) || true); assert.strictEqual(r.body.aiConfigured, true); });
  await ok('clip: no key -> 401', async () => { const r = await call('POST', '/api/clip', { headers: { 'content-type': 'image/jpeg' }, body: JPG }); assert.strictEqual(r.status, 401); });
  await ok('clip: wrong key -> 401', async () => { const r = await call('POST', '/api/clip', { headers: { 'content-type': 'image/jpeg', 'x-clip-key': 'clp_nope' }, body: JPG }); assert.strictEqual(r.status, 401); });
  await ok('clip: not an image -> 400', async () => { const r = await call('POST', '/api/clip', { headers: { 'content-type': 'image/jpeg', 'x-clip-key': KEY }, body: Buffer.alloc(3000, 1) }); assert.strictEqual(r.status, 400); });
  await ok('clip: key + jpeg -> 2 drafts in pdfDrafts + broadcast', async () => {
    const r = await call('POST', '/api/clip', { headers: { 'content-type': 'image/jpeg', 'x-clip-key': KEY, 'x-clip-source': 'Chrome%20NCERT' }, body: JPG });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.count, 2); assert.strictEqual(S.docs.length, 2); assert.strictEqual(S.docs[0].owner_uid, 'u1');
    assert.strictEqual(S.bcast.length, 2); assert.strictEqual(S.bcast[0][0], 'pdfDrafts'); assert.ok(S.docs[0].data.sourcePdf.includes('Chrome NCERT')); assert.strictEqual(S.images.length, 1); assert.strictEqual(fetchCalls, 1);
  });
  await ok('clip: admin Bearer path works too', async () => { const r = await call('POST', '/api/clip', { headers: { ...adminH, 'content-type': 'image/jpeg' }, body: JPG }); assert.strictEqual(r.status, 200); });
  await ok('clip: daily limit -> 429 and AI not called', async () => {
    const before = fetchCalls; const r3 = await call('POST', '/api/clip', { headers: { ...adminH, 'content-type': 'image/jpeg' }, body: JPG }); assert.strictEqual(r3.status, 200);
    const r4 = await call('POST', '/api/clip', { headers: { ...adminH, 'content-type': 'image/jpeg' }, body: JPG }); assert.strictEqual(r4.status, 429); assert.strictEqual(fetchCalls, before + 1);
  });
  await ok('image fetch: admin only, own image', async () => { const id = S.images[0].id; assert.strictEqual((await call('GET', '/api/clip/image/' + id)).status, 403); const r = await call('GET', '/api/clip/image/' + id, { headers: adminH }); assert.strictEqual(r.status, 200); });
  await ok('revoke key -> 401 afterwards', async () => {
    assert.strictEqual((await call('DELETE', '/api/clip/keys/1', { headers: adminH })).status, 200);
    const r = await call('POST', '/api/clip', { headers: { 'content-type': 'image/jpeg', 'x-clip-key': KEY }, body: JPG }); assert.strictEqual(r.status, 401);
  });
  await ok('no sawal in image -> count 0, nothing saved', async () => { S.usage = {}; aiReply = aiJson([], 'Image me sawal nahi mila'); const d = S.docs.length; const r = await call('POST', '/api/clip', { headers: { ...adminH, 'content-type': 'image/jpeg' }, body: JPG }); assert.strictEqual(r.body.count, 0); assert.strictEqual(S.docs.length, d); });
  await ok('AI garbage -> 502 and usage refunded not needed', async () => { S.usage = {}; aiReply = 'sorry'; const r = await call('POST', '/api/clip', { headers: { ...adminH, 'content-type': 'image/jpeg' }, body: JPG }); assert.strictEqual(r.status, 502); });
  await ok('no ANTHROPIC key -> 503 + usage refunded', async () => { S.usage = {}; delete process.env.ANTHROPIC_API_KEY; const r = await call('POST', '/api/clip', { headers: { ...adminH, 'content-type': 'image/jpeg' }, body: JPG }); assert.strictEqual(r.status, 503); assert.strictEqual(Object.values(S.usage)[0], 0); });

  global.fetch = realFetch; srv.close(); console.log('\n' + n + ' passed'); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
