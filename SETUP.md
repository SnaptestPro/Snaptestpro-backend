# SnapTestPro Backend v2 — Setup Guide (Hinglish)

Ye Firebase ki jagah ek **free backend** hai: Node.js + PostgreSQL. Isme Login, Database (Firestore jaisa),
Live updates (onSnapshot jaisa) aur File upload hai. Firebase ke daily read/write limit ka tension nahi.

```
Tumhara App (browser)
   │  snaptestpro-sdk.js  (Firestore jaisa API + cache)
   ▼
Render.com (free) ── Node.js server ── Neon.tech (free PostgreSQL)
```

## 0. Pehle local par chala ke dekho (optional)

```bash
npm install
cp .env.example .env        # DATABASE_URL, JWT_SECRET, ADMIN_EMAILS bharo
npm start
curl http://localhost:3000/api/health
```
Test chalane ke liye: `DATABASE_URL=postgresql://... npm test`

## 1. Free Database — Neon

1. https://neon.tech par sign up karo, naya project banao.
2. **Connection string** copy karo (`postgresql://...neon.tech/...?sslmode=require`).
3. Tables server khud bana leta hai, kuch manually nahi karna.

(Supabase ka PostgreSQL bhi chalega, bas uska connection string use karo.)

## 2. Code GitHub par daalo

Ye folder ek **private** GitHub repo me push karo. `.env` aur `serviceAccount.json` kabhi push mat karna (`.gitignore` me hain).

## 3. Free Hosting — Render

1. https://render.com → **New → Web Service** → apna repo chuno.
   (Ya **Blueprint** chuno, `render.yaml` apne aap settings bhar dega.)
2. Build: `npm install --omit=dev`, Start: `npm start`, Plan: **Free**.
3. **Environment variables** daalo:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Neon ka connection string |
| `JWT_SECRET` | lamba random text (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
| `ADMIN_EMAILS` | tumhari email, jisse admin banna hai |
| `CORS_ORIGINS` | tumhari site ka URL, jaise `https://yourname.github.io` |
| `BASE_URL` | Render ka URL, jaise `https://snaptestpro-backend.onrender.com` |

4. Deploy ke baad `https://<tumhara-url>/api/health` kholo. `"healthy"` aana chahiye.

### Free server so jata hai
Render free service kuch der idle rehne par sleep ho jati hai, aur pehli request me kuch second lagte hain.
Isse bachne ke liye https://uptimerobot.com (free) par ek monitor lagao jo har 5 minute me
`https://<tumhara-url>/api/ping` ko hit kare. `/api/ping` database ko nahi chhuta, to DB ke free hours bhi nahi khate.

## 4. Admin account

`ADMIN_EMAILS` wali email se **signup** karo, wo automatically `admin` ban jata hai.
Admin hi `questions` aur `tests` jaisi collections me likh sakta hai (rules.json dekho).

## 5. Rules (Firebase Security Rules ki jagah) — `rules.json`

```json
{
  "default": { "read": "owner", "write": "owner" },
  "collections": {
    "questions": { "read": "auth",  "write": "admin" },
    "results":   { "read": "owner", "write": "owner" }
  }
}
```
- `public` = bina login ke koi bhi
- `auth` = koi bhi logged-in user
- `owner` = sirf jisne document banaya (admin sab dekh sakta hai)
- `admin` = sirf admin
- `none` = koi nahi

**Apni collections ke hisaab se isko zaroor badlo.** Jo collection list me nahi hai uspe `default` lagta hai.

## 6. App me Firebase hatao, SDK lagao

```html
<script src="snaptestpro-sdk.js"></script>
<script>
  const stp = new SnapTestPro('https://snaptestpro-backend.onrender.com');
</script>
```

| Firebase | Naya |
|---|---|
| `auth.createUserWithEmailAndPassword(e, p)` | `stp.auth().createUserWithEmailAndPassword(e, p, name)` |
| `auth.signInWithEmailAndPassword(e, p)` | `stp.auth().signInWithEmailAndPassword(e, p)` |
| `auth.signOut()` | `stp.auth().signOut()` |
| `auth.onAuthStateChanged(cb)` | `stp.auth().onAuthStateChanged(cb)` |
| `db.collection('x').doc(id).set(data)` | `stp.collection('x').doc(id).set(data)` |
| `db.collection('x').add(data)` | `stp.collection('x').add(data)` |
| `.doc(id).get()` → `doc.exists`, `doc.data()` | same |
| `.where('f','==',v).orderBy('f').limit(n).get()` | same (`==, !=, <, <=, >, >=`) |
| `.onSnapshot(snap => ...)` | same, `snap.docs[i].data()` |
| `db.batch()` | `stp.batch()` |
| `storage.ref(path).put(file)` | `stp.storage().ref(path).put(file)` → `{ url }` |

Ye Firestore ka sab kuch nahi hai. `in`, `array-contains`, `FieldValue.increment`, transactions, sub-collections abhi nahi hain.
`firebase.firestore.FieldValue.serverTimestamp()` ki jagah `SnapTestPro.serverTimestamp()` use karo.

### Reads bachane ke tareeke (limit ki asli wajah yahi hoti hai)
- `get()` ka result **5 minute cache** hota hai (localStorage). `get({ cache: 'reload' })` se fresh data.
- Apni likhi hui collection me write karte hi uska cache khud saaf ho jata hai.
- `onSnapshot` sirf **ek baar** poora data laata hai, uske baad sirf badlav (live) aate hain. Use sirf wahi jagah karo jaha zaroori ho (jaise live leaderboard), baaki jagah `get()`.
- Question bank jaisa data jo kam badalta hai uske liye `new SnapTestPro(url, { cacheTTL: 24*60*60*1000 })`.

## 7. Purana Firebase data laana

```bash
npm i --no-save firebase-admin
# Firebase Console > Project settings > Service accounts > Generate new private key
# file ko serviceAccount.json naam se is folder me rakho
DATABASE_URL="neon-wala-url" node scripts/import-firestore.js questions tests
```
- Sirf top-level collections aati hain, sub-collections nahi.
- Imported docs ka koi owner nahi hota. `owner` rule wali collection sirf admin ko dikhegi. Aise collections ko `auth` read karo.
- **Firebase Auth ke users aur unke passwords migrate nahi hote.** Students ko dobara signup karna padega.
  Firebase password hash alag format me hai, aur is backend me "forgot password" email bhi nahi hai (agle version me jod sakte hain).
- Ye import script maine test nahi ki (mere paas Firebase credentials nahi hain). Sirf uska conversion/insert logic fake data par check hua hai. Pehle ek chhoti collection se try karo.

## 8. Free ki sachchai (zaroor padho)

- **Free tiers badalte rehte hain.** Neon/Render ki current limits unki site par dekh lo. DB ka free storage chhota hota hai (aksar sirf kuch सौ MB se 1 GB), purane records archive karte rehna.
- **File upload Render free par permanent nahi hai.** Wahan disk redeploy/restart par saaf ho jati hai. Images/PDF ke liye free Cloudinary ya Supabase Storage jaisi service use karo aur sirf unka URL database me rakho. Is backend ka upload abhi sirf local/dev ya paid disk ke liye theek hai.
- **Koi guarantee nahi** ki lakhon students par free me chalega. Jab traffic badhe to Render ka sasta paid plan lena padega, phir bhi Firebase ke per-read billing se aksar sasta rehta hai.
- Backup khud lena: Neon me point-in-time restore hota hai, lekin uski free limit check karo, ya mahine me ek baar `pg_dump` chala lo.
- Is code me abhi **email verification, forgot password, aur Firestore ke advanced queries** nahi hain.

## API (agar SDK ke bina use karna ho)

```
POST   /api/auth/signup | /api/auth/login | /api/auth/change-password   GET /api/auth/me
GET    /api/collections/:c/documents?where=field:op:value&orderBy=f:desc&limit=100&offset=0&since=ISO
POST   /api/collections/:c/documents        { docId?, data, merge? }
GET|PATCH|DELETE /api/collections/:c/documents/:id
POST   /api/batch                           { ops:[{type,collection,docId,data}] }  (max 400, ek transaction)
POST   /api/storage/upload (form-data: file) · GET /api/storage/files · DELETE /api/storage/files/:id
GET    /api/ping · /api/health · /api/stats (admin)
WebSocket: emit 'subscribe' {collection, token} -> 'update' events
```
`since=<ISO time>` se sirf naye/badle documents milte hain (delta sync). Delete hue docs isme nahi aate.
