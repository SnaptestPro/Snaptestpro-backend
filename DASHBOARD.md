# v2.2 — Dashboard + Projects (dusre ko backend dena)

## Kholna
`https://<tumhara-render-url>/dashboard` → Owner email (ADMIN_EMAILS wali) se login.
Pehli baar account nahi hai to **Signup** dabao (sirf ADMIN_EMAILS wali email admin banti hai).

## Dashboard me kya hai
| Tab | Kaam |
|---|---|
| Overview | users, docs, DB size, DB speed, uptime, 7 din ka usage, poora backup download |
| Data | kisi bhi collection ke docs dekho/search/edit/delete, Export, Import, collection delete |
| Users | main users: admin banao, password reset, delete |
| Rules | rules.json ko yahi se badlo (DB me save, restart par bhi rehta hai) |
| Projects | dusre logon ko alag backend (neeche) |
| Files | uploaded files |
| Audit | admin ne kya badla |
| Tools | API tester |

## Dusre ko backend dena (Projects)
1. Dashboard → Projects → **Naya project** (naam, unka email, unki website, limits, rules template).
2. **API key** aur **Admin key** ek hi baar dikhengi — copy karke unhe do.
3. Wo apni website me:
```html
<script src="https://<backend>/sdk/snaptestpro-sdk.js"></script>
<script>const stp = new SnapTestPro('https://<backend>', { apiKey: 'stp_pk_...' });</script>
```
Baaki sab Firestore jaisa (`stp.collection('x').add(...)`, `stp.auth()...`). REST ke liye header `X-Api-Key`.

Har project me: alag data, alag users (main users se mix nahi), alag rules, max docs / users / requests-per-minute limit, sirf unki website (origin) allowed, key badalna/band karna, delete (data ke saath).
`Admin key` = server-side secret (header `X-Admin-Key`), browser/APK me kabhi nahi.

## Naye API (sab `/api/admin/*`, sirf owner)
overview · documents (GET/PUT/DELETE) · collections/:c (DELETE) · export · import · users · rules · files · audit · projects (+ users, rotate-keys)
Project public: `/api/p/info`, `/api/p/auth/signup|login|me|change-password`

## Sachchai
- Project ki file-upload (storage) abhi nahi; sirf data + login.
- Document limit ~60 second ke cache se check hoti hai (thoda upar-neeche ho sakta hai).
- Registered project websites ka CORS khud khulta hai; ye `CORS_ORIGINS` env ko nahi badalta.
- Purane routes ka behavior same hai (purane saare tests pass).
