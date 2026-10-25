/**
 * Firestore -> is backend (PostgreSQL) me data import
 *
 * Use:
 *   npm i --no-save firebase-admin
 *   # Firebase Console > Project settings > Service accounts > "Generate new private key"
 *   # file ko serviceAccount.json naam se is folder me rakho (GIT me mat daalna!)
 *   DATABASE_URL=postgresql://... node scripts/import-firestore.js questions tests records
 *   # collection naam nahi doge to saari top-level collections import hongi
 *
 * Dhyan: imported documents ka owner khali rehta hai. rules.json me "owner" read wali collections ko sirf
 * admin dekh payega (hybrid mode ki collections questionBank/deletedQuestions... "auth"/"admin" hain, unpar asar nahi).
 * Sub-collections import nahi hoti (sirf top-level). Timestamp {__ts: ms} ban kar jata hai.
 * Dobara chalane par wahi doc overwrite hota hai (safe), isliye migration ke din last baar chalao.
 */
require('dotenv').config();
const { Pool } = require('pg');

function convert(v) {
  if (v === null || v === undefined) return null;
  if (typeof v.toDate === 'function' && typeof v.toMillis === 'function') return { __ts: v.toMillis() }; // Timestamp (own-backend.js isi format ko wapas Timestamp banata hai)
  if (typeof v.latitude === 'number' && typeof v.longitude === 'number') return { lat: v.latitude, lng: v.longitude }; // GeoPoint
  if (v.path && v.firestore) return v.path;                                        // DocumentReference
  if (Buffer.isBuffer(v)) return v.toString('base64');
  if (Array.isArray(v)) return v.map(convert);
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, convert(x)]));
  return v;
}

async function importDocs(db, collection, docs, chunk = 500) {
  let n = 0;
  for (let i = 0; i < docs.length; i += chunk) {
    const part = docs.slice(i, i + chunk);
    await db.query(
      `INSERT INTO documents (collection_name, doc_id, data)
       SELECT $1, t.id, t.data::jsonb FROM unnest($2::text[], $3::text[]) AS t(id, data)
       ON CONFLICT (collection_name, doc_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [collection, part.map(d => d.id), part.map(d => JSON.stringify(convert(d.data)))]);
    n += part.length;
  }
  return n;
}

async function main() {
  // firebase-admin ke naye versions (12+) me admin.credential nahi hai, isliye modular import
  const { initializeApp, cert } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const keyPath = process.cwd() + '/serviceAccount.json';
  if (!require('fs').existsSync(keyPath)) { console.error('serviceAccount.json nahi mili: ' + keyPath + '\nFirebase Console > Project settings > Service accounts > Generate new private key, aur file ka naam serviceAccount.json rakho.'); process.exit(1); }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL set nahi hai (PowerShell: $env:DATABASE_URL="postgresql://...")'); process.exit(1); }
  initializeApp({ credential: cert(require(keyPath)) });
  const fs = getFirestore();
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const { initDb } = require('../server'); await initDb();
  let names = process.argv.slice(2);
  if (!names.length) names = (await fs.listCollections()).map(c => c.id);
  for (const name of names) {
    const snap = await fs.collection(name).get();
    const n = await importDocs(db, name, snap.docs.map(d => ({ id: d.id, data: d.data() })));
    console.log(`${name}: ${n} documents imported`);
  }
  await db.end(); process.exit(0);
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { importDocs, convert };
