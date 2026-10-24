/**
 * SnapTestPro SDK — Firestore-jaisa API apne free backend ke liye
 *
 *   const stp = new SnapTestPro('https://your-backend.onrender.com');
 *
 *   await stp.auth().signInWithEmailAndPassword(email, password);
 *   const snap = await stp.collection('questions').where('subject', '==', 'math').orderBy('marks', 'desc').limit(20).get();
 *   snap.docs.forEach(d => console.log(d.id, d.data()));
 *   await stp.collection('results').doc('r1').set({ score: 80 });
 *   const unsub = stp.collection('tests').onSnapshot(snap => render(snap.docs));
 *
 * Reads bachane ke liye get() result localStorage me cache hota hai (default 5 minute).
 *   .get({ cache: 'reload' })  -> hamesha server se
 *   .get({ cache: 'only' })    -> sirf cache se (offline)
 */
(function (root) {
  'use strict';

  const OPS = { '==': 'eq', '!=': 'ne', '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte' };
  const CMP = {
    eq: (a, b) => JSON.stringify(a) === JSON.stringify(b), ne: (a, b) => JSON.stringify(a) !== JSON.stringify(b),
    lt: (a, b) => a < b, lte: (a, b) => a <= b, gt: (a, b) => a > b, gte: (a, b) => a >= b
  };
  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const mkDoc = d => ({ id: d.id, exists: true, data: () => d.data, createdAt: d.createdAt, updatedAt: d.updatedAt, _raw: d });
  const mkSnap = docs => ({ docs: docs.map(mkDoc), size: docs.length, empty: docs.length === 0, forEach(fn) { this.docs.forEach(fn); } });

  class SnapTestPro {
    constructor(baseURL, opts = {}) {
      this.baseURL = String(baseURL).replace(/\/$/, '');
      this.cacheTTL = opts.cacheTTL != null ? opts.cacheTTL : 5 * 60 * 1000; // ms
      this.token = this._ls('get', 'stp_token');
      const u = this._ls('get', 'stp_user');
      this.currentUser = u ? JSON.parse(u) : null;
      this._authCbs = [];
      this._listeners = {}; // collection -> [{cb, query, docs:Map}]
      this._socket = null;
    }

    // ------------------------------------------------ internals
    _ls(op, k, v) {
      try {
        if (typeof localStorage === 'undefined') return null;
        if (op === 'get') return localStorage.getItem(k);
        if (op === 'set') return localStorage.setItem(k, v);
        if (op === 'del') return localStorage.removeItem(k);
        if (op === 'keys') return Object.keys(localStorage);
      } catch (e) { return null; }
    }
    async _req(method, path, body, isForm) {
      const headers = {};
      if (this.token) headers.Authorization = 'Bearer ' + this.token;
      if (body && !isForm) headers['Content-Type'] = 'application/json';
      const res = await fetch(this.baseURL + path, { method, headers, body: body ? (isForm ? body : JSON.stringify(body)) : undefined });
      let json = {};
      try { json = await res.json(); } catch (e) { /* no body */ }
      if (!res.ok) {
        if (res.status === 401 && this.token) this._setUser(null, null); // token expire
        const err = new Error(json.error || ('HTTP ' + res.status)); err.status = res.status; throw err;
      }
      return json;
    }
    _setUser(user, token) {
      this.currentUser = user; this.token = token;
      if (user) { this._ls('set', 'stp_token', token); this._ls('set', 'stp_user', JSON.stringify(user)); }
      else { this._ls('del', 'stp_token'); this._ls('del', 'stp_user'); this.clearCache(); }
      this._authCbs.forEach(cb => { try { cb(user); } catch (e) { console.error(e); } });
      if (this._socket) Object.keys(this._listeners).forEach(c => this._subscribe(c));
    }
    _cacheKey(path) { return 'stp_c:' + (this.currentUser ? this.currentUser.uid : 'anon') + ':' + path; }
    _invalidate(collection) {
      (this._ls('keys') || []).forEach(k => { if (k.startsWith('stp_c:') && k.indexOf('/collections/' + collection + '/') !== -1) this._ls('del', k); });
    }
    clearCache() { (this._ls('keys') || []).forEach(k => { if (k.startsWith('stp_c:')) this._ls('del', k); }); }

    // ------------------------------------------------ auth
    auth() {
      const self = this;
      return {
        get currentUser() { return self.currentUser; },
        async createUserWithEmailAndPassword(email, password, name) {
          const r = await self._req('POST', '/api/auth/signup', { email, password, name });
          self._setUser(r.user, r.token); return { user: r.user };
        },
        async signInWithEmailAndPassword(email, password) {
          const r = await self._req('POST', '/api/auth/login', { email, password });
          self._setUser(r.user, r.token); return { user: r.user };
        },
        async signOut() { self._setUser(null, null); },
        async changePassword(oldPassword, newPassword) { return self._req('POST', '/api/auth/change-password', { oldPassword, newPassword }); },
        onAuthStateChanged(cb) { self._authCbs.push(cb); setTimeout(() => cb(self.currentUser), 0); return () => { self._authCbs = self._authCbs.filter(f => f !== cb); }; }
      };
    }

    // ------------------------------------------------ firestore-like
    collection(name) { return new Query(this, name); }

    batch() {
      const ops = []; const self = this; const touched = new Set();
      const b = {
        set(ref, data, o) { ops.push({ type: 'set', collection: ref.collection, docId: ref.id, data, merge: !!(o && o.merge) }); touched.add(ref.collection); return b; },
        update(ref, data) { ops.push({ type: 'update', collection: ref.collection, docId: ref.id, data }); touched.add(ref.collection); return b; },
        delete(ref) { ops.push({ type: 'delete', collection: ref.collection, docId: ref.id }); touched.add(ref.collection); return b; },
        async commit() {
          if (!ops.length) return { success: true };
          const r = await self._req('POST', '/api/batch', { ops });
          touched.forEach(c => self._invalidate(c)); return r;
        }
      };
      return b;
    }

    // ------------------------------------------------ storage
    storage() {
      const self = this;
      return {
        ref(path) {
          let url = null;
          const r = {
            async put(file) {
              const fd = new FormData(); fd.append('file', file);
              const res = await self._req('POST', '/api/storage/upload', fd, true);
              url = res.file.url;
              return { url, name: res.file.name, size: res.file.size, id: res.file.id, ref: r };
            },
            async getDownloadURL() { if (!url) throw new Error('Pehle put() karo'); return url; }
          };
          return r;
        }
      };
    }

    // ------------------------------------------------ realtime
    _ensureSocket() {
      if (this._socket || this._socketLoading) return;
      const start = () => {
        this._socket = root.io(this.baseURL, { reconnection: true });
        this._socket.on('connect', () => Object.keys(this._listeners).forEach(c => this._subscribe(c)));
        this._socket.on('update', ev => this._onUpdate(ev));
      };
      if (typeof root.io !== 'undefined') return start();
      this._socketLoading = true;
      const s = document.createElement('script');
      s.src = this.baseURL + '/socket.io/socket.io.js';
      s.onload = () => { this._socketLoading = false; start(); };
      s.onerror = () => { this._socketLoading = false; console.warn('Realtime load nahi hua, sirf normal reads chalenge'); };
      document.head.appendChild(s);
    }
    _subscribe(collection) { if (this._socket && this._socket.connected) this._socket.emit('subscribe', { collection, token: this.token }); }
    _onUpdate(ev) {
      (this._listeners[ev.collection] || []).forEach(l => {
        if (ev.action === 'delete') l.docs.delete(ev.docId);
        else {
          const prev = l.docs.get(ev.docId);
          const full = ev.action === 'update' && prev ? Object.assign({}, prev.data, ev.data) : ev.data;
          const doc = { id: ev.docId, data: full };
          if (l.query._matches(doc)) l.docs.set(ev.docId, doc); else l.docs.delete(ev.docId);
        }
        l.emit();
      });
    }
  }

  class Query {
    constructor(sdk, collection, wheres, order, lim) {
      this.sdk = sdk; this.name = collection;
      this._where = wheres || []; this._order = order || null; this._limit = lim || null;
    }
    _clone(p) { return new Query(this.sdk, this.name, p.where || this._where, p.order || this._order, p.limit || this._limit); }
    where(field, op, value) {
      if (!OPS[op]) throw new Error('Operator ' + op + ' supported nahi (use ==, !=, <, <=, >, >=)');
      return this._clone({ where: this._where.concat([[field, OPS[op], value]]) });
    }
    orderBy(field, dir) { return this._clone({ order: [field, dir === 'desc' ? 'desc' : 'asc'] }); }
    limit(n) { return this._clone({ limit: n }); }

    _path() {
      const q = [];
      this._where.forEach(w => q.push('where=' + encodeURIComponent(w[0] + ':' + w[1] + ':' + JSON.stringify(w[2]))));
      if (this._order) q.push('orderBy=' + encodeURIComponent(this._order[0] + ':' + this._order[1]));
      q.push('limit=' + (this._limit || 1000));
      return '/api/collections/' + this.name + '/documents?' + q.join('&');
    }
    _matches(doc) { return this._where.every(w => CMP[w[1]](getPath(doc.data, w[0]), w[2])); }
    _sortLimit(docs) {
      if (this._order) {
        const [f, d] = this._order;
        docs.sort((a, b) => { const x = getPath(a.data, f), y = getPath(b.data, f); return (x > y ? 1 : x < y ? -1 : 0) * (d === 'desc' ? -1 : 1); });
      }
      return this._limit ? docs.slice(0, this._limit) : docs;
    }

    async get(opts = {}) {
      const mode = opts.cache || 'default';
      const path = this._path(); const key = this.sdk._cacheKey(path);
      if (mode !== 'reload') {
        const raw = this.sdk._ls('get', key);
        if (raw) {
          try {
            const c = JSON.parse(raw);
            if (mode === 'only' || Date.now() - c.t < this.sdk.cacheTTL) return mkSnap(c.docs);
          } catch (e) { /* ignore */ }
        }
        if (mode === 'only') return mkSnap([]);
      }
      const r = await this.sdk._req('GET', path);
      try { this.sdk._ls('set', key, JSON.stringify({ t: Date.now(), docs: r.docs })); } catch (e) { /* quota */ }
      return mkSnap(r.docs);
    }

    doc(id) {
      const sdk = this.sdk, c = this.name;
      const base = '/api/collections/' + c + '/documents/' + encodeURIComponent(id);
      return {
        id, collection: c,
        async get() {
          try { const r = await sdk._req('GET', base); return mkDoc(r.doc); }
          catch (e) { if (e.status === 404) return { id, exists: false, data: () => undefined }; throw e; }
        },
        async set(data, o) {
          const r = await sdk._req('POST', '/api/collections/' + c + '/documents', { docId: id, data, merge: !!(o && o.merge) });
          sdk._invalidate(c); return mkDoc(r.doc);
        },
        async update(data) { const r = await sdk._req('PATCH', base, { data }); sdk._invalidate(c); return mkDoc(r.doc); },
        async delete() { await sdk._req('DELETE', base); sdk._invalidate(c); return { success: true }; }
      };
    }
    async add(data) {
      const r = await this.sdk._req('POST', '/api/collections/' + this.name + '/documents', { data });
      this.sdk._invalidate(this.name); return mkDoc(r.doc);
    }

    onSnapshot(cb, errCb) {
      const sdk = this.sdk, name = this.name; let alive = true;
      const l = { query: this, docs: new Map(), cb, emit() { if (alive) cb(mkSnap(this.query._sortLimit(Array.from(this.docs.values())))); } };
      (async () => {
        try {
          const r = await sdk._req('GET', this._path());
          r.docs.forEach(d => l.docs.set(d.id, d));
          if (!alive) return;
          (sdk._listeners[name] = sdk._listeners[name] || []).push(l);
          sdk._ensureSocket(); sdk._subscribe(name);
          l.emit();
        } catch (e) { if (errCb) errCb(e); else console.error('onSnapshot error:', e.message); }
      })();
      return function unsubscribe() {
        alive = false;
        sdk._listeners[name] = (sdk._listeners[name] || []).filter(x => x !== l);
        if (!sdk._listeners[name].length) { delete sdk._listeners[name]; if (sdk._socket) sdk._socket.emit('unsubscribe', name); }
      };
    }
  }

  SnapTestPro.serverTimestamp = () => new Date().toISOString();
  if (typeof module !== 'undefined' && module.exports) module.exports = SnapTestPro;
  root.SnapTestPro = SnapTestPro;
})(typeof window !== 'undefined' ? window : globalThis);
