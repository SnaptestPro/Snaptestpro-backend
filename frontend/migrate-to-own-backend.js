/* Firestore -> apna backend: browser me, owner login ke saath. Koi terminal/service-account nahi chahiye.
 * Sirf PADHTA hai Firebase se (kuch badalta/mitata nahi) aur backend par likhta hai. Dobara chalana safe hai. */
(function (W) {
  'use strict';
  var DEFAULT_COLLS = ['questionBank', 'deletedQuestions', 'seedExclusions', 'draftQuestions', 'pdfDrafts'];
  var PAGE = 300, MAX_OPS = 300, MAX_BYTES = 900000;
  var $ = function (id) { return document.getElementById(id); };
  var cfg = (W.SNAP_CONFIG && W.SNAP_CONFIG.ownBackend) || {};
  var colls = (Array.isArray(cfg.collections) && cfg.collections.length ? cfg.collections : DEFAULT_COLLS).slice();
  var state = { role: null, email: null, running: false };

  function log(msg, cls) {
    var el = $('log'); if (!el) return;
    if (el.dataset.init !== '1') { el.textContent = ''; el.dataset.init = '1'; }
    el.textContent += (cls ? '[' + cls + '] ' : '') + msg + '\n'; el.scrollTop = el.scrollHeight;
  }
  function backend() { return String(($('url') && $('url').value) || cfg.url || '').trim().replace(/\/+$/, ''); }
  function auth() { return (W.vishnuFirebase && W.vishnuFirebase.auth) || W.firebase.auth(); }
  function token() { var u = auth().currentUser; return u ? u.getIdToken() : Promise.resolve(''); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ---------- Firestore value -> backend JSON (own-backend.js jaisa format)
  function conv(v) {
    if (v === undefined) return undefined;
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof Date) return { __ts: v.getTime() };
    if (typeof v.toMillis === 'function' && typeof v.toDate === 'function') return { __ts: v.toMillis() };      // Timestamp
    if (typeof v.toBase64 === 'function') return v.toBase64();                                                    // Blob/Bytes
    if (typeof v.latitude === 'number' && typeof v.longitude === 'number' && Object.keys(v).length <= 4) return { lat: v.latitude, lng: v.longitude }; // GeoPoint
    if (v.path && v.firestore) return v.path;                                                                     // DocumentReference
    if (Array.isArray(v)) return v.map(function (x) { var c = conv(x); return c === undefined ? null : c; });
    var o = {}; Object.keys(v).forEach(function (k) { var c = conv(v[k]); if (c !== undefined) o[k] = c; }); return o;
  }

  function api(method, path, body, tries) {
    tries = tries == null ? 3 : tries;
    return token().then(function (t) {
      return fetch(backend() + path, { method: method, headers: Object.assign({ Authorization: 'Bearer ' + t }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        if (res.ok) return j;
        var e = new Error((j && j.error) || ('HTTP ' + res.status)); e.status = res.status; throw e;
      });
    }, function (netErr) { var e = new Error('Backend tak pahunch nahi paye (server so raha ho sakta hai): ' + netErr.message); e.net = true; throw e; })
    .catch(function (e) {
      if ((e.net || e.status === 429 || e.status >= 500) && tries > 0) { log('Dobara koshish... (' + e.message + ')', 'warn'); return sleep(4000).then(function () { return api(method, path, body, tries - 1); }); }
      throw e;
    });
  }

  function whoami() { return api('GET', '/api/auth/whoami', null, 4); }
  function count(name) { return api('GET', '/api/collections/' + encodeURIComponent(name) + '/count', null, 1).then(function (r) { return r.count; }); }

  // ---------- ek collection copy
  var KEY = function (n) { return 'snapMigrate:' + n; };
  function copyCollection(name, opts) {
    opts = opts || {};
    var fs = W.firebase.firestore(), FP = W.firebase.firestore.FieldPath;
    var lastId = opts.resume ? (W.localStorage.getItem(KEY(name)) || null) : null;
    if (!opts.resume) W.localStorage.removeItem(KEY(name));
    var total = 0, skipped = 0;
    if (lastId) log(name + ': pichhli baar "' + lastId + '" tak ho chuka tha, uske baad se', 'info');

    function sendOps(ops) {
      var chunks = [], cur = [], bytes = 0;
      ops.forEach(function (op) {
        var b = new TextEncoder().encode(JSON.stringify(op)).length;
        if (cur.length && (cur.length >= MAX_OPS || bytes + b > MAX_BYTES)) { chunks.push(cur); cur = []; bytes = 0; }
        cur.push(op); bytes += b;
      });
      if (cur.length) chunks.push(cur);
      return chunks.reduce(function (p, c) { return p.then(function () { return api('POST', '/api/batch', { ops: c }); }); }, Promise.resolve());
    }
    function nextPage() {
      var q = fs.collection(name).orderBy(FP.documentId()).limit(PAGE);
      if (lastId) q = q.startAfter(lastId);
      return q.get({ source: 'server' }).then(function (snap) {
        if (snap.empty) return { total: total, skipped: skipped };
        var ops = [];
        snap.docs.forEach(function (d) {
          if (d.id === '.' || d.id === '..') { skipped++; log(name + ': id "' + d.id + '" chhoda gaya (invalid)', 'warn'); return; }
          ops.push({ type: 'set', collection: name, docId: d.id, data: conv(d.data()) });
        });
        var pageLast = snap.docs[snap.docs.length - 1].id;
        return sendOps(ops).then(function () {
          total += ops.length; lastId = pageLast; W.localStorage.setItem(KEY(name), lastId);
          if (opts.onProgress) opts.onProgress(name, total);
          if (snap.docs.length < PAGE) return { total: total, skipped: skipped };
          return nextPage();
        });
      });
    }
    return nextPage().then(function (r) { W.localStorage.removeItem(KEY(name)); return r; });
  }

  // ---------- UI
  function renderColls(counts) {
    $('colls').innerHTML = colls.map(function (n) {
      var c = counts && counts[n] != null ? ' &middot; backend me abhi: <b>' + counts[n] + '</b>' : '';
      return '<div class="coll"><label style="display:flex;gap:8px;align-items:center;margin:0;color:inherit"><input type="checkbox" class="cc" value="' + n + '" checked> <b>' + n + '</b></label><span id="st-' + n + '" class="sub">' + c + '</span></div>';
    }).join('');
  }
  function setStatus(msg, cls) { var s = $('status'); s.textContent = msg; s.className = 'sub ' + (cls || ''); }
  function friendly(e) {
    var code = e && (e.code || ''), msg = (e && e.message) || String(e);
    if (code === 'resource-exhausted') return 'Firebase ki aaj ki free reads limit khatam. Kal (ya limit reset hone ke baad) dobara "Copy shuru karo" dabao, wahin se aage badhega.';
    if (code === 'permission-denied') return 'Firebase ne padhne se mana kiya (permission). Owner/admin se login ho? ' + msg;
    if (code === 'unavailable') return 'Internet ya Firebase se connection nahi bana: ' + msg;
    return msg;
  }
  function refreshUser() {
    var u = auth().currentUser;
    if (!u || u.isAnonymous) { state.role = null; $('who').innerHTML = '<span class="warn">Abhi login nahi hai.</span> Neeche Owner ki email/password se login karo.'; $('loginBox').style.display = ''; $('btnLogout').style.display = 'none'; $('btnCopy').disabled = true; return Promise.resolve(); }
    $('who').innerHTML = 'Login: <b>' + (u.email || u.uid) + '</b>'; $('loginBox').style.display = 'none'; $('btnLogout').style.display = '';
    return Promise.resolve();
  }
  function runCheck() {
    $('checkOut').textContent = 'Check ho raha hai... (Render pehli baar 30-60 second le sakta hai)';
    return whoami().then(function (w) {
      state.role = w.role; state.email = w.email;
      var good = w.role === 'owner';
      $('checkOut').innerHTML = (w.signedIn ? '<span class="pill">' + (w.email || '') + '</span><span class="pill">role: <b>' + w.role + '</b></span>' : '<span class="bad">Backend ko login nahi dikha (FIREBASE_PROJECT_ID check karo)</span>') +
        (good ? '<div class="ok" style="margin-top:6px">Sab theek hai, copy kar sakte ho.</div>' : '<div class="bad" style="margin-top:6px">Copy ke liye <b>Owner</b> email se login chahiye (abhi role: ' + w.role + '). Owner = Render me OWNER_EMAILS wali email.</div>');
      return Promise.all(colls.map(function (n) { return count(n).then(function (c) { return [n, c]; }, function () { return [n, null]; }); }));
    }).then(function (pairs) {
      var counts = {}; pairs.forEach(function (p) { counts[p[0]] = p[1]; }); renderColls(counts);
      $('btnCopy').disabled = state.role !== 'owner';
      log('Check ho gaya. role=' + state.role, state.role === 'owner' ? 'ok' : 'warn');
    }).catch(function (e) { $('checkOut').innerHTML = '<span class="bad">' + friendly(e) + '</span>'; log('Check fail: ' + friendly(e), 'bad'); });
  }
  function runCopy() {
    if (state.running) return; state.running = true; $('btnCopy').disabled = true;
    var sel = Array.prototype.map.call(document.querySelectorAll('.cc:checked'), function (x) { return x.value; });
    var resume = $('resume').checked, done = 0, copied = {}, problems = [];
    setStatus('Copy chal raha hai... page band mat karna'); $('bar').style.width = '2%';
    return sel.reduce(function (p, name) {
      return p.then(function () {
        setStatus(name + ' copy ho rahi hai...'); log(name + ': shuru', 'info');
        return copyCollection(name, { resume: resume, onProgress: function (n, t) { $('st-' + n).textContent = t + ' docs copy hue...'; } }).then(function (r) {
          copied[name] = r; done++; $('bar').style.width = Math.round(done / sel.length * 100) + '%';
          log(name + ': ' + r.total + ' docs copy hue' + (r.skipped ? ' (' + r.skipped + ' chhode)' : ''), 'ok');
        }, function (e) { problems.push(name + ': ' + friendly(e)); log(name + ' ruk gaya: ' + friendly(e), 'bad'); throw e; });
      });
    }, Promise.resolve()).then(function () {
      return Promise.all(sel.map(function (n) { return count(n).then(function (c) { return [n, c]; }); }));
    }).then(function (pairs) {
      var html = '<table style="width:100%;font-size:14px;border-collapse:collapse"><tr><th align=left>Collection</th><th align=right>Firebase se padhe</th><th align=right>Backend me ab</th></tr>';
      pairs.forEach(function (p) { var r = copied[p[0]]; var same = r.total === p[1]; html += '<tr><td>' + p[0] + '</td><td align=right>' + r.total + '</td><td align=right class="' + (same ? 'ok' : 'warn') + '">' + p[1] + (same ? ' &check;' : ' (alag hai)') + '</td></tr>'; });
      html += '</table><p class="sub">Dono number barabar hon to copy sahi hai. Backend me pehle se aur docs hon to number zyada ho sakta hai.</p><p><b>Aage:</b> app me switch ON karna hai (guide ka last step). Switch ON se pehle koi admin question na badle, warna ye page ek baar aur chala lo.</p>';
      $('done').innerHTML = html; $('c4').style.display = ''; setStatus('Sab collections copy ho gayi.', 'ok'); $('bar').style.width = '100%';
    }).catch(function (e) { setStatus('Ruk gaya: ' + friendly(e), 'bad'); }).then(function () { state.running = false; $('btnCopy').disabled = state.role !== 'owner'; });
  }

  function init() {
    $('url').value = (cfg.url || 'https://snaptestpro-backend.onrender.com'); renderColls(null);
    $('btnCheck').onclick = runCheck; $('btnCopy').onclick = runCopy;
    $('btnLogin').onclick = function () {
      auth().signInWithEmailAndPassword($('em').value.trim(), $('pw').value).then(function () { return refreshUser().then(runCheck); })
        .catch(function (e) { log('Login fail: ' + (e.code || e.message), 'bad'); $('who').innerHTML = '<span class="bad">Login fail: ' + (e.code || e.message) + '</span>'; });
    };
    $('btnGoogle').onclick = function () {
      auth().signInWithPopup(new W.firebase.auth.GoogleAuthProvider()).then(function () { return refreshUser().then(runCheck); })
        .catch(function (e) { log('Google login fail: ' + (e.code || e.message), 'bad'); });
    };
    $('btnLogout').onclick = function () { auth().signOut().then(refreshUser); };
    Promise.resolve(W.vishnuFirebase && W.vishnuFirebase.authReady).then(refreshUser).then(function () { if (auth().currentUser && !auth().currentUser.isAnonymous) return runCheck(); });
  }
  W.SnapMigrate = { copyCollection: copyCollection, conv: conv, count: count, whoami: whoami };
  if (document.getElementById('btnCopy')) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init(); }
})(typeof window !== 'undefined' ? window : globalThis);
