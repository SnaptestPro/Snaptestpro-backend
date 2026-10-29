'use strict';
/**
 * SnapTest Clipper backend (v1)
 *   Phone ka Clipper ek screen-photo bhejta hai -> Claude (vision) usse sawal banata hai -> "pdfDrafts" me
 *   status:"pending" draft ban jaata hai (ye wahi PDF Drafts list hai jo app me pehle se hai: Edit / Bank / Test / Delete).
 *
 *   POST   /api/clip              (body = raw image/jpeg|png|webp)  header: X-Clip-Key  YA admin Bearer token
 *   POST   /api/clip/keys         admin: naya Clipper key (plain key sirf ek baar dikhta hai)
 *   GET    /api/clip/keys         admin: apne keys + aaj ka usage
 *   DELETE /api/clip/keys/:id     admin: key band karo
 *   GET    /api/clip/image/:id    admin: draft ki original photo
 *
 *   Env: ANTHROPIC_API_KEY (zaroori), CLIP_MODEL (default claude-sonnet-5-5), CLIP_DAILY_LIMIT (default 150 / admin / din)
 */
const crypto = require('crypto');
const express = require('express');

const MAX_IMG = 5 * 1024 * 1024;
const MAX_QUESTIONS = 10;
const model = () => process.env.CLIP_MODEL || 'claude-sonnet-5-5';
const dailyLimit = () => parseInt(process.env.CLIP_DAILY_LIMIT || '150', 10) || 150;
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

const SYSTEM_PROMPT = `Tum ek expert ho jo screenshot se exam ke sawal nikalte ho, ek Indian coaching institute ke liye (Hindi + English, Class 6-12, Board / JEE / NEET / SSC / Railway).
Tumhara jawab SIRF ek valid JSON object hona chahiye. Koi bhi aur text, markdown ya code-fence nahi.

Niyam:
1. Image me jitne POORE sawal dikhein (max ${MAX_QUESTIONS}) sab nikalo. Jo sawal kata/adhura dikhe use incomplete:true karo, apni taraf se mat banao.
2. Bhasha jaisi hai waisi hi rakho: Hindi Devanagari me, English English me. Translate mat karo. Sawal ka number (Q1., 12. waghera) hata do.
3. MCQ: chaar options. (a)(b)(c)(d), A-D, 1-4, (i)-(iv), ①-④ sab ko A,B,C,D me map karo. Option ke aage ka label hata do.
   Agar chaar se kam/zyada options hon to jo hain unhe do (max 4) aur confidence kam rakho.
4. Sawal me options nahi hon to qType "subjective", options khali.
5. Sahi uttar:
   - Agar image me uttar dikhe (answer key, tick, dark option, "Ans: b") to answerIndex do aur answerSource "image".
   - Nahi dikhe aur tum pakke ho (hisaab ya pakka tathya) to khud hal karke answerIndex do, answerSource "solved".
   - Pakka na ho to answerIndex null, answerSource "unknown". ANDAZA MAT LAGAO.
6. explanation: image me ho to wahi; nahi ho aur tumne hal kiya ho to 1-3 line ka seedha hal; warna khali string.
7. Ganit/Science: sirf plain text + Unicode (x², x³, √, π, ½, ≤, ≥, ×, ÷, θ, α, β, °). Fraction a/b likho. LaTeX ($, \\frac), markdown ya HTML mat likho.
8. Agar sawal kisi figure/chitra/graph par nirbhar hai jo text me nahi aa sakta: hasFigure true aur figureNote me ek line me batao ki chitra me kya hai.
9. Assertion-Reason, match-the-following, statement-based sawal: pura statement sawal me rakho (naye line se).
10. subject aur chapter ka chhota andaza do (jaise "Maths", "Arithmetic Progression"); pakka na ho to khali.

JSON ka shape:
{"questions":[{"qType":"mcq"|"subjective","question":"...","options":["A","B","C","D"],"answerIndex":0|1|2|3|null,"answerSource":"image"|"solved"|"unknown","explanation":"...","hasFigure":false,"figureNote":"","incomplete":false,"confidence":0.0-1.0,"subject":"","chapter":""}],"notes":"ek line agar kuch khaas ho, warna khali"}
Agar image me koi sawal hi nahi hai to {"questions":[],"notes":"Image me sawal nahi mila"}.`;

/* ---------------- pure helpers (unit-testable) ---------------- */
function parseAiJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('AI ne valid JSON nahi diya');
  const j = JSON.parse(t.slice(a, b + 1));
  if (!j || !Array.isArray(j.questions)) throw new Error('AI ke jawab me questions nahi the');
  return j;
}
const str = (v, n) => (typeof v === 'string' ? v : v == null ? '' : String(v)).trim().slice(0, n);
function normalizeQuestion(q) {
  if (!q || typeof q !== 'object') return null;
  const text = str(q.question, 4000);
  if (text.length < 3) return null;
  let options = Array.isArray(q.options) ? q.options.map(o => str(o, 500)).filter((o, i) => i < 4) : [];
  const subjective = q.qType === 'subjective' || options.filter(Boolean).length < 2;
  const fewOptions = !subjective && options.filter(Boolean).length < 4;
  if (subjective) options = ['', '', '', ''];
  while (options.length < 4) options.push('');
  let answerIndex = Number.isInteger(q.answerIndex) && q.answerIndex >= 0 && q.answerIndex <= 3 ? q.answerIndex : null;
  if (subjective || (answerIndex != null && !options[answerIndex])) answerIndex = null;
  let answerSource = ['image', 'solved', 'unknown'].includes(q.answerSource) ? q.answerSource : 'unknown';
  if (answerIndex == null) answerSource = 'unknown';
  const conf = typeof q.confidence === 'number' && q.confidence >= 0 && q.confidence <= 1 ? q.confidence : null;
  return {
    qType: subjective ? 'subjective' : 'mcq', text, options, answerIndex, answerSource,
    explanation: str(q.explanation, 2000), hasFigure: !!q.hasFigure, figureNote: str(q.figureNote, 300),
    incomplete: !!q.incomplete, fewOptions, confidence: conf, subject: str(q.subject, 60), chapter: str(q.chapter, 80),
  };
}
function buildDraftDoc(nq, ctx) {
  const tag = nq.answerSource === 'image' ? '✅ Uttar image me tha'
    : nq.answerSource === 'solved' ? '🤖 Uttar AI ne nikala — check karein'
    : '⚠️ Uttar nahi mila — Edit me set karein';
  const parts = ['Clip', tag];
  if (nq.incomplete) parts.push('⚠️ sawal adhura');
  if (nq.fewOptions) parts.push('⚠️ options kam');
  if (nq.hasFigure) parts.push('🖼️ chitra wala');
  if (ctx.sourceNote) parts.push(ctx.sourceNote);
  let explanation = nq.explanation;
  if (nq.hasFigure && nq.figureNote) explanation = ('[Chitra: ' + nq.figureNote + '] ' + explanation).trim();
  return {
    status: 'pending', section: 'Clip', sourcePdf: parts.join(' • ').slice(0, 200),
    qType: nq.qType, text: nq.text, textHI: nq.text, textEN: nq.text,
    options: nq.options, optionsHI: nq.options, optionsEN: nq.options,
    answer: nq.answerIndex == null ? 0 : nq.answerIndex,
    explanation, explanationHI: explanation, explanationEN: explanation,
    importedAt: new Date().toISOString(), createdBy: ctx.email || null, needsReview: nq.answerSource !== 'image' || nq.incomplete || nq.fewOptions,
    clipMeta: {
      answerSource: nq.answerSource, confidence: nq.confidence, hasFigure: nq.hasFigure, incomplete: nq.incomplete,
      aiSubject: nq.subject, aiChapter: nq.chapter, model: ctx.model, imageId: ctx.imageId || null,
    },
  };
}
function sniffMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/* ---------------- Claude call ---------------- */
async function askClaude(buf, mime) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { const e = new Error('AI key set nahi hai (Render me ANTHROPIC_API_KEY daalein)'); e.status = 503; throw e; }
  if (typeof fetch !== 'function') { const e = new Error('Server ka Node purana hai (18+ chahiye)'); e.status = 500; throw e; }
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 75000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: model(), max_tokens: 4000, temperature: 0, system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: buf.toString('base64') } },
          { type: 'text', text: 'Is image ke sawal JSON me nikalo.' },
        ] }],
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error('AI error: ' + ((j && j.error && j.error.message) || ('HTTP ' + res.status)).slice(0, 200));
      e.status = res.status === 429 || res.status === 529 ? 503 : 502; throw e;
    }
    const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    return { text, usage: j.usage || {} };
  } catch (e) {
    if (e.name === 'AbortError') { const x = new Error('AI ne bahut der lagayi, dobara try karein'); x.status = 504; throw x; }
    throw e;
  } finally { clearTimeout(timer); }
}

/* ---------------- routes ---------------- */
function mountClip({ app, db, wrap, HttpError, isAdmin, uidOf, broadcast }) {
  let ready = null;
  const ensure = () => ready || (ready = db.query(`
    CREATE TABLE IF NOT EXISTS clip_keys (
      id SERIAL PRIMARY KEY, key_hash TEXT UNIQUE NOT NULL, label TEXT,
      owner_uid TEXT, owner_email TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ, uses INT NOT NULL DEFAULT 0, revoked BOOLEAN NOT NULL DEFAULT FALSE);
    CREATE TABLE IF NOT EXISTS clip_usage (scope TEXT NOT NULL, day DATE NOT NULL, n INT NOT NULL DEFAULT 0, in_tok BIGINT NOT NULL DEFAULT 0, out_tok BIGINT NOT NULL DEFAULT 0, PRIMARY KEY (scope, day));
    CREATE TABLE IF NOT EXISTS clip_images (id TEXT PRIMARY KEY, owner_uid TEXT, mime TEXT, img BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
  `).catch(e => { ready = null; throw e; }));
  ensure().catch(e => console.warn('[clip] tables:', e.message));

  const needAdmin = req => { if (!isAdmin(req.user)) throw new HttpError(403, 'Sirf admin / owner'); };
  const isOwnerRole = u => !!u && (u.role === 'owner' || u.superAdmin === true);

  async function identify(req) {
    if (isAdmin(req.user)) return { scope: 'uid:' + uidOf(req.user), uid: uidOf(req.user), email: req.user.email || null, userId: req.user.id || null, keyId: null };
    const raw = (req.get('x-clip-key') || '').trim();
    if (!raw) throw new HttpError(401, 'Clip key ya admin login chahiye');
    const r = (await db.query('SELECT * FROM clip_keys WHERE key_hash = $1', [sha256(raw)])).rows[0];
    if (!r || r.revoked) throw new HttpError(401, 'Clip key galat ya band hai');
    db.query('UPDATE clip_keys SET last_used_at = NOW(), uses = uses + 1 WHERE id = $1', [r.id]).catch(() => {});
    return { scope: 'uid:' + r.owner_uid, uid: r.owner_uid, email: r.owner_email, userId: null, keyId: r.id };
  }

  app.post('/api/clip/keys', wrap(async (req, res) => {
    needAdmin(req); await ensure();
    const uid = uidOf(req.user);
    const active = (await db.query('SELECT COUNT(*)::int AS n FROM clip_keys WHERE owner_uid = $1 AND NOT revoked', [uid])).rows[0].n;
    if (active >= 10) throw new HttpError(400, 'Zyada keys ho gaye (max 10). Purane band karein.');
    const label = str(req.body && req.body.label, 60) || 'Mera phone';
    const key = 'clp_' + crypto.randomBytes(24).toString('base64url');
    const r = (await db.query('INSERT INTO clip_keys (key_hash, label, owner_uid, owner_email) VALUES ($1,$2,$3,$4) RETURNING id, created_at', [sha256(key), label, uid, req.user.email || null])).rows[0];
    res.json({ id: r.id, key, label, createdAt: r.created_at });
  }));

  app.get('/api/clip/keys', wrap(async (req, res) => {
    needAdmin(req); await ensure();
    const uid = uidOf(req.user);
    const rows = (await db.query(
      isOwnerRole(req.user) ? 'SELECT id, label, owner_email, created_at, last_used_at, uses, revoked FROM clip_keys ORDER BY id DESC LIMIT 50'
        : 'SELECT id, label, owner_email, created_at, last_used_at, uses, revoked FROM clip_keys WHERE owner_uid = $1 ORDER BY id DESC LIMIT 50',
      isOwnerRole(req.user) ? [] : [uid])).rows;
    const day = new Date().toISOString().slice(0, 10);
    const u = (await db.query('SELECT n FROM clip_usage WHERE scope = $1 AND day = $2', ['uid:' + uid, day])).rows[0];
    res.json({ keys: rows, usedToday: u ? u.n : 0, dailyLimit: dailyLimit(), model: model(), aiConfigured: !!process.env.ANTHROPIC_API_KEY });
  }));

  app.delete('/api/clip/keys/:id', wrap(async (req, res) => {
    needAdmin(req); await ensure();
    const id = parseInt(req.params.id, 10); if (!id) throw new HttpError(400, 'id galat');
    const r = isOwnerRole(req.user)
      ? await db.query('UPDATE clip_keys SET revoked = TRUE WHERE id = $1', [id])
      : await db.query('UPDATE clip_keys SET revoked = TRUE WHERE id = $1 AND owner_uid = $2', [id, uidOf(req.user)]);
    if (!r.rowCount) throw new HttpError(404, 'Key nahi mili');
    res.json({ success: true });
  }));

  app.get('/api/clip/image/:id', wrap(async (req, res) => {
    needAdmin(req); await ensure();
    const r = (await db.query('SELECT mime, img, owner_uid FROM clip_images WHERE id = $1', [String(req.params.id).slice(0, 60)])).rows[0];
    if (!r || (!isOwnerRole(req.user) && r.owner_uid !== uidOf(req.user))) throw new HttpError(404, 'Photo nahi mili (14 din baad hat jaati hai)');
    res.set('Content-Type', r.mime || 'image/jpeg').set('Cache-Control', 'private, max-age=3600').send(r.img);
  }));

  app.post('/api/clip', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: MAX_IMG }), wrap(async (req, res) => {
    await ensure();
    const who = await identify(req);
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || buf.length < 1000) throw new HttpError(400, 'Photo nahi mili (Content-Type image/jpeg rakhein)');
    const mime = sniffMime(buf);
    if (!mime) throw new HttpError(400, 'Sirf JPEG / PNG / WEBP photo chalti hai');

    const day = new Date().toISOString().slice(0, 10);
    const used = (await db.query(
      `INSERT INTO clip_usage (scope, day, n) VALUES ($1, $2, 1) ON CONFLICT (scope, day) DO UPDATE SET n = clip_usage.n + 1 RETURNING n`, [who.scope, day])).rows[0].n;
    if (used > dailyLimit()) {
      db.query('UPDATE clip_usage SET n = n - 1 WHERE scope = $1 AND day = $2', [who.scope, day]).catch(() => {});
      throw new HttpError(429, 'Aaj ki Clip limit (' + dailyLimit() + ') poori ho gayi');
    }

    let ai;
    try { ai = await askClaude(buf, mime); } catch (e) {
      db.query('UPDATE clip_usage SET n = n - 1 WHERE scope = $1 AND day = $2', [who.scope, day]).catch(() => {});
      throw new HttpError(e.status || 502, e.message);
    }
    let parsed;
    try { parsed = parseAiJson(ai.text); } catch (e) { throw new HttpError(502, 'AI ka jawab samajh nahi aaya, dobara try karein'); }
    db.query('UPDATE clip_usage SET in_tok = in_tok + $3, out_tok = out_tok + $4 WHERE scope = $1 AND day = $2',
      [who.scope, day, ai.usage.input_tokens || 0, ai.usage.output_tokens || 0]).catch(() => {});

    const qs = parsed.questions.slice(0, MAX_QUESTIONS).map(normalizeQuestion).filter(Boolean);
    if (!qs.length) return res.json({ ok: true, count: 0, drafts: [], notes: str(parsed.notes, 200) || 'Image me sawal nahi mila' });

    const imageId = 'img-' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
    await db.query('INSERT INTO clip_images (id, owner_uid, mime, img) VALUES ($1,$2,$3,$4)', [imageId, who.uid, mime, buf]);
    if (Math.random() < 0.05) db.query(`DELETE FROM clip_images WHERE created_at < NOW() - INTERVAL '14 days'`).catch(() => {});

    const sourceNote = str(decodeURIComponent((req.get('x-clip-source') || '').replace(/[^\x20-\x7e%]/g, '')), 60);
    const drafts = [];
    for (const nq of qs) {
      const docId = 'clip-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
      const data = buildDraftDoc(nq, { email: who.email, sourceNote, imageId, model: model() });
      const r = (await db.query(
        `INSERT INTO documents (collection_name, doc_id, data, user_id, owner_uid) VALUES ('pdfDrafts', $1, $2::jsonb, $3, $4) RETURNING *`,
        [docId, JSON.stringify(data), who.userId, who.uid])).rows[0];
      try { broadcast('pdfDrafts', r, 'create'); } catch (_) { /* live update best-effort */ }
      drafts.push({ id: docId, question: nq.text.slice(0, 80), answerSource: nq.answerSource });
    }
    res.json({ ok: true, count: drafts.length, drafts, imageId, notes: str(parsed.notes, 200) });
  }));
}

module.exports = mountClip;
module.exports._internals = { parseAiJson, normalizeQuestion, buildDraftDoc, sniffMime, sha256, SYSTEM_PROMPT };
