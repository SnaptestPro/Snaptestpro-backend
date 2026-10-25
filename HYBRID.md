# HYBRID MODE — Firebase + apna free backend (SnapTest Pro)

**Idea:** app Firebase par hi rehta hai (login, students, tests, records sab). Sirf **question bank wali
admin collections** apne free backend par jati hain, taaki unke reads Firebase ke 50K/din limit me na gine jayein.
Kuch bhi bigde to ek switch (`enabled:false`) se sab wapas Firebase par.

## Kya shift hota hai (aur kya nahi)

| Apne backend par (free) | Firebase par hi rehta hai |
|---|---|
| `questionBank`, `deletedQuestions`, `seedExclusions`, `draftQuestions`, `pdfDrafts` | `tests`, `studentRecords`, `students`, `institutes`, `admins`, `batches`, `doubts`, `examRegistrations`, ... sab baaki, login/Auth, Storage, Push |

Ye 5 collections **ek saath** shift hoti hain, kyunki app ke batches (recycle bin, restore, move) inme ek saath likhte hain.
Admin kaun hai, ye backend Firebase ke `admins/{email}` document se hi dekhta hai (firestore.rules jaisa). Alag admin list nahi banti.

## Step 1 — Backend update (GitHub)
1. Backend repo me `snaptestpro-backend-v2.1-replace.zip` upload karo (auto-extract chalega). Pichhla `.env`/Render settings nahi badalte.
2. Render > service > **Environment** me 3 naye variables jodo:

| Key | Value |
|---|---|
| `FIREBASE_PROJECT_ID` | `the-vishnu-sharma-test` (Firebase Console > Project settings me "Project ID" dekh lo) |
| `OWNER_EMAILS` | `vishnu1234stm@gmail.com` |
| `EXTRA_ADMIN_EMAILS` | `vishnu1234stmp@gmail.com` |

3. `CORS_ORIGINS` badlo (comma se, bina space ke): `https://snaptestpro.github.io,https://localhost,capacitor://localhost`
   (agar app custom domain par hai to wo bhi jodo). Save karo, Render redeploy karega.
4. Check: `https://<render-url>/api/health` => healthy.

## Step 2 — Firebase login backend ko dikh raha hai? (test)
1. App ko **admin** se login karke kholo. Browser me F12 > Console.
2. Ye chalao (frontend patch lagne ke baad `SnapOwnBackend` milega; usse pehle ye manual version):
```javascript
(async()=>{ const t=await firebase.auth().currentUser.getIdToken();
  const r=await fetch('https://<render-url>/api/auth/whoami',{headers:{Authorization:'Bearer '+t}}); console.log(await r.json()); })()
```
3. Result me `"role":"admin"` (owner ke liye `"owner"`) aur `"via":"firebase"` aana chahiye. Student (anonymous) ke liye `"role":"user"`.
   - `signedIn:false` => `FIREBASE_PROJECT_ID` galat hai ya token expire.
   - Admin hote hue `role:"user"` => niche "Problem aaye to" dekho.

## Step 3 — Purana data copy karo (Firestore -> backend)
PC par (Node.js chahiye), backend repo clone karke:
```bash
npm install
npm i --no-save firebase-admin
# Firebase Console > Project settings > Service accounts > Generate new private key => serviceAccount.json (GitHub par kabhi mat daalna)
DATABASE_URL="neon-wali-string" node scripts/import-firestore.js questionBank deletedQuestions seedExclusions draftQuestions pdfDrafts
```
- Ye Firestore se **padhta** hai (reads lagte hain, ek baar) aur Neon me likhta hai. Firebase ka data nahi badalta.
- Pehle sirf `deletedQuestions` se try karo, phir baaki. Dobara chalane par wahi docs overwrite hote hain (safe).
- **Last baar migration wale din chalao** (jab koi admin edit na kar raha ho), warna beech ke edits copy nahi honge.

## Step 4 — App me 5 files badlo (frontend repo)
`snaptestpro-frontend-hybrid-patch.zip` ko apne PC par extract karo. GitHub me **frontend repo** kholo > Add file > Upload files >
ye 5 files drag karo (repo ke root me, purani overwrite hongi) > Commit:

`own-backend.js` (nayi) · `index.html` · `question-generator.html` · `firebase-config.js` · `app-config.js`

Har file me sirf 1-8 line badli hai (diff `PATCH_NOTES.txt` me). Agar tumne in files me apne badlav kiye hain to poori file mat badlo,
`PATCH_NOTES.txt` ke hisaab se wo chhoti lines haath se jodo.
**Frontend repo me auto-extract workflow mat lagao** (wahan `updates/` me purani zip files hain).
Ye patch abhi **band** hai (`enabled:false`), isliye upload karne se app me kuch nahi badalta.

## Step 5 — Chalu karna (pehle test copy par, phir live)
1. `app-config.js` me:
```js
ownBackend: { enabled: true, url: "https://<render-url>", collections: ["questionBank","deletedQuestions","seedExclusions","draftQuestions","pdfDrafts"] },
```
2. Pehle ek **test jagah** par (jaise alag branch/ya local) check karo, Admin se:
   - Question Bank khulta hai, questions dikhte hain
   - Naya question add / edit / delete
   - Delete ke baad Recycle Bin me dikhta hai, restore ho jata hai
   - Chapter move, bulk delete
   - PDF import ke drafts
   - Student ka practice / test normal chalta hai
3. Sab theek ho to live repo me wahi `enabled:true` wali `app-config.js` upload karo.
4. **Kuch bhi galat lage** => `enabled:false` karke upload karo. App turant pehle jaisa. (Backend wale naye docs Firebase me wapas nahi aate; us case me Step 3 ulta nahi hota, isliye migration se pehle test zaroor karo.)

## Problem aaye to

| Dikkat | Matlab / Fix |
|---|---|
| Admin hote hue `role:"user"` | Backend Firestore se `admins/<email>` nahi padh pa raha. Check: `FIREBASE_PROJECT_ID` sahi? Firestore **App Check enforcement ON** to nahi? Agar ON hai: Render me `TRUST_SNAPROLE=true` karo (tab sirf wahi admin chalenge jinke token me `snapRole=admin` custom claim hai, `scripts/migrate-admin-claims.js` se lagta hai) |
| Console me CORS error | `CORS_ORIGINS` me app ka exact origin nahi hai |
| `permission-denied` | rules.json / admin role dekho |
| Pehli request bahut slow | Render free so gaya tha (UptimeRobot `/api/ping`) |
| "Own backend: ... supported nahi" | Us collection par aisa feature use hua jo adapter me nahi (increment, dotted update, 'in' query). Us collection ko `collections` list se hata do |

## Sachchai (zaroor padho)
- Ye **sirf admin/question-bank wale reads** apne backend par bhejta hai. **Students ke reads** (tests, records, results, batches...) abhi bhi Firebase par hain. 1 lakh students ke liye asli number tab dikhega jab student ke reads naap lo (pichhli baat).
- Ye adapter maine **asli SnapTest app browser me chala kar nahi dekha** (mere paas tumhara live Firebase/app nahi hai). Backend aur adapter ke 136 automatic tests pass hain (asli Firebase SDK ke Timestamp/FieldValue ke saath), par pehle test copy par zaroor check karo.
- Do chhote farak: `set(..., {merge:true})` backend par **upar-upar (shallow)** merge karta hai, Firestore nested map ko gehra merge karta hai. Aur batch jisme 400 se zyada question ho wo 2 requests me jata hai (poora atomic nahi).
- Free Render/Neon ki limits badalti rehti hain. Neon ka free storage chhota hota hai; bahut bada question bank ho to size check karte raho (`/api/stats`, admin ke liye).
- Cloudflare Worker (bank + push) aur Storage/Push par ye kuch nahi badalta.
