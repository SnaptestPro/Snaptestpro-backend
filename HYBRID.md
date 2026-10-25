# HYBRID MODE — Firebase + apna free backend (SnapTest Pro)

**Idea:** app Firebase par hi rehta hai (login, students, tests, records). Sirf **question bank wali admin collections**
(`questionBank`, `deletedQuestions`, `seedExclusions`, `draftQuestions`, `pdfDrafts`) apne free backend par jati hain,
taaki unke reads Firebase ke 50K/din limit me na gine. **Koi terminal, VS Code ya coding nahi chahiye.**
Kuch bigde to ek file badalte hi sab wapas Firebase par.

## 1) Backend update (GitHub, drag & drop)
1. Backend repo me `snaptestpro-backend-v2.1-replace.zip` upload karo (auto-extract chalega, 1 minute).
2. Render > service > **Environment** me ye 3 variables jodo (aur `CORS_ORIGINS` badlo):

| Key | Value |
|---|---|
| `FIREBASE_PROJECT_ID` | `the-vishnu-sharma-test` |
| `OWNER_EMAILS` | `vishnu1234stm@gmail.com` |
| `EXTRA_ADMIN_EMAILS` | `vishnu1234stmp@gmail.com` |
| `CORS_ORIGINS` | `https://snaptestpro.github.io,https://localhost,capacitor://localhost` |

3. Save > Render redeploy kare > `https://snaptestpro-backend.onrender.com/api/health` me `healthy`.

## 2) App ki files upload (frontend repo, drag & drop)
`snaptestpro-frontend-hybrid-patch.zip` extract karo. **Frontend repo** > Add file > Upload files > in 7 files ko drag karo > Commit:

`own-backend.js`, `index.html`, `question-generator.html`, `firebase-config.js`, `app-config.js`, `migrate-to-own-backend.html`, `migrate-to-own-backend.js`
(`PATCH_NOTES.txt` upload nahi karni.) Isse app me kuch nahi badalta, kyunki switch abhi OFF hai.
Frontend repo me auto-extract workflow **mat** lagana (wahan `updates/` me purani zip hain).

## 3) Data copy — ek page, ek button
1. Browser me kholo: `https://snaptestpro.github.io/migrate-to-own-backend.html`
   (upload ke baad 1-2 baar refresh; app ka service worker purani copy pehle dikhata hai)
2. **Owner** email (`vishnu1234stm@gmail.com`) se login karo (email+password ya Google).
3. **Check karo** dabao: role `owner` dikhe.
4. **Copy shuru karo** dabao. Progress dikhega. Ruk gaya (Firebase ki roz ki free limit) to agle din phir dabao: wahin se aage badhega.
5. Neeche table me "Firebase se padhe" aur "Backend me ab" ke number barabar hon (tick).
Ye Firebase se **padhta** hai (kuch badalta/mitata nahi), isliye reads lagte hain (ek baar). Dobara chalana safe hai.

## 4) Switch ON (jab copy poori ho jaye)
`snaptestpro-switch.zip` extract karo > `ON` folder ki `app-config.js` ko frontend repo me upload karo (purani overwrite) > Commit.
App ko 2 baar refresh karo. Check: console me `SnapOwnBackend.status()` => `enabled: true`.
Pehle admin se ye jaanch lo: Question Bank khulna, question add/edit/delete, Recycle Bin restore, chapter move, PDF import drafts, student ka practice/test.

**Wapas Firebase par (kill-switch):** `OFF` folder ki `app-config.js` upload karo. Dhyan: ON ke dauran jo naye edits hue wo Firebase me nahi aate.
ON karne se pehle koi admin edit na kare; agar kare to page 3 ek baar aur chala lo.

## Problem aaye to

| Dikkat | Fix |
|---|---|
| Page me CORS error | Render `CORS_ORIGINS` me `https://snaptestpro.github.io` nahi hai |
| Check me role `admin` (owner nahi) | Owner email se login karo (`OWNER_EMAILS` wali) |
| Check me role `user` | Firestore App Check enforce ON ho sakta hai: Render me `TRUST_SNAPROLE=true` |
| "Backend tak pahunch nahi paye" | Render free server so raha tha; thodi der baad dobara dabao |
| "Firebase ki limit khatam" | Agle din phir "Copy shuru karo" dabao (resume tick rakho) |
| App me "Own backend: ... supported nahi" | Us collection par aisa feature use hua jo adapter me nahi; us collection ko `collections` list se hatao |

## Sachchai (zaroor padho)
- Ye sirf admin/question-bank wale reads hatata hai. **Students ke reads (tests, records...) abhi Firebase par hi hain.**
- Mere paas tumhara live app nahi tha: backend, adapter aur copy-page ke automatic tests (nakli browser + asli Firebase SDK classes) pass hain, par asli app me pehle test karo.
- `set(..., {merge:true})` backend par upar-upar merge karta hai; 400+ ops wala batch 2 requests me jata hai.
- Free Render/Neon ki limits badalti rehti hain. Cloudflare Worker, Storage, Push par kuch nahi badla.
- `scripts/import-firestore.js` (terminal wala tareeka) ab zaroori nahi; sirf advanced use ke liye.
