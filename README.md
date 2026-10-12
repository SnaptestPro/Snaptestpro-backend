# 🚀 SnapTestPro - Self-Hosted Firebase Alternative

**Unlimited Reads | Real-time Sync | Authentication | File Storage | 100% FREE**

एक ही solution में सब कुछ जो Firebase देता है - **UNLIMITED और बिना कोई limit!**

---

## ✨ Features

| Feature | Firebase | Our Backend |
|---------|----------|-------------|
| **Read Limit** | 50K/day (paid) | ♾️ **Unlimited** |
| **Write Limit** | 20K/day (paid) | ♾️ **Unlimited** |
| **Real-time Sync** | ✅ Yes | ✅ **Yes (WebSocket)** |
| **Authentication** | ✅ Yes | ✅ **Yes (JWT)** |
| **File Storage** | ✅ Yes | ✅ **Yes** |
| **Cost** | ₹2,700+/month | **₹0-500/month** |
| **Control** | Cloud (Firebase) | **100% Yours** |

---

## 📦 What's Included

### **Backend Files:**
- `complete-firebase-alternative.js` - Main server (1 file में सब कुछ!)
- `firebase-alternative-sdk.js` - Frontend SDK (exactly like Firebase)
- `package.json` - All dependencies
- `.env.example` - Configuration template

### **Documentation:**
- `README.md` (यह file) - Overview
- `DEPLOYMENT-GUIDE.md` - Complete deployment instructions
- `FRONTEND-INTEGRATION.md` - How to integrate with your app

---

## 🎯 Quick Start (5 मिनट)

### **Step 1: Clone/Download Project**

```bash
# Option A: Using Git
git clone https://github.com/YOUR_USERNAME/snaptestpro-backend.git
cd snaptestpro-backend

# Option B: Manual Download
# Download all files and put in a folder
```

### **Step 2: Install Dependencies**

```bash
npm install
```

### **Step 3: Setup Environment**

```bash
# Copy example to .env
cp .env.example .env

# Edit .env with your values
nano .env

# Minimum required:
# DATABASE_URL=postgresql://user:pass@localhost:5432/snaptestpro
# JWT_SECRET=your-random-secret-key
# PORT=3000
```

### **Step 4: Setup Database (PostgreSQL)**

**Quick way - Using local PostgreSQL:**

```bash
# Install PostgreSQL first
# Windows: https://www.postgresql.org/download/windows/
# Mac: brew install postgresql@15
# Linux: sudo apt install postgresql

# Create database
psql -U postgres

# In psql prompt:
CREATE DATABASE snaptestpro;
CREATE USER snaptestpro_user WITH PASSWORD 'password123';
GRANT ALL PRIVILEGES ON DATABASE snaptestpro TO snaptestpro_user;
\q

# Update .env
DATABASE_URL=postgresql://snaptestpro_user:password123@localhost:5432/snaptestpro
```

**Or use free cloud DB:**
- **Neon**: https://neon.tech (recommended, free)
- **ElephantSQL**: https://elephantsql.com (free)
- **Supabase**: https://supabase.com (free)

### **Step 5: Start Server**

```bash
# Development (with auto-reload)
npm run dev

# Production
npm start
```

**Output should show:**
```
╔════════════════════════════════════════╗
║  🚀 FIREBASE ALTERNATIVE SERVER        ║
╠════════════════════════════════════════╣
║  Status: Running                       ║
║  URL: http://localhost:3000            ║
║  API: http://localhost:3000/api        ║
║  WebSocket: ws://localhost:3000        ║
╚════════════════════════════════════════╝
```

### **Step 6: Test API**

```bash
# In another terminal
curl http://localhost:3000/api/health

# Should return:
{"success":true,"status":"healthy","timestamp":"..."}
```

### **Step 7: Use from Frontend**

```html
<!-- In your HTML -->
<script src="http://localhost:3000/socket.io/socket.io.js"></script>
<script src="/firebase-alternative-sdk.js"></script>

<script>
  // Initialize
  const db = new FirebaseAlternative('http://localhost:3000');

  // Sign up
  await db.auth().createUserWithEmailAndPassword(
    'user@example.com',
    'password123',
    'User Name'
  );

  // Add document
  await db.collection('tests').add({
    name: 'Test 1',
    duration: 60,
    totalQuestions: 20
  });

  // Real-time updates
  db.collection('tests').onSnapshot(snapshot => {
    console.log('Tests:', snapshot.docs);
  });
</script>
```

---

## 📡 API Endpoints

### **Authentication**
```javascript
POST   /api/auth/signup                          // Create account
POST   /api/auth/login                           // Login
GET    /api/auth/me                              // Get current user
```

### **Collections (Firestore)**
```javascript
POST   /api/collections                          // Create collection
GET    /api/collections                          // List collections
POST   /api/collections/:collection/documents    // Add document
GET    /api/collections/:collection/documents    // Get all documents
GET    /api/collections/:collection/documents/:docId  // Get specific doc
PATCH  /api/collections/:collection/documents/:docId  // Update document
DELETE /api/collections/:collection/documents/:docId  // Delete document
```

### **File Storage**
```javascript
POST   /api/storage/upload                       // Upload file
GET    /api/storage/files                        // List files
GET    /uploads/:filename                        // Download file
```

### **Monitoring**
```javascript
GET    /api/health                               // Server health check
GET    /api/stats                                // Statistics
```

---

## 🔌 WebSocket Events (Real-time)

```javascript
// Subscribe to collection
socket.emit('subscribe', {
  collection: 'tests',
  token: auth_token
});

// Listen for updates
socket.on('update', (data) => {
  console.log(data);
  // {
  //   collection: 'tests',
  //   docId: 'doc_123',
  //   data: { name: 'Updated' },
  //   action: 'update',
  //   timestamp: '2024-01-10T10:00:00Z'
  // }
});
```

---

## 📚 SDK Usage (Frontend)

### **Authentication**

```javascript
const db = new FirebaseAlternative('http://localhost:3000');

// Sign Up
const { user, token } = await db.auth().createUserWithEmailAndPassword(
  'email@example.com',
  'password123',
  'Full Name'
);

// Sign In
const { user, token } = await db.auth().signInWithEmailAndPassword(
  'email@example.com',
  'password123'
);

// Get Current User
const user = await db.auth().currentUser();

// Sign Out
db.auth().signOut();
```

### **Database Operations**

```javascript
// Add document (with auto ID)
const docRef = await db.collection('tests').add({
  name: 'Math Test',
  duration: 60
});

// Set document (with specific ID)
await db.collection('tests').doc('test_123').set({
  name: 'Science Test'
});

// Get document
const doc = await db.collection('tests').doc('test_123').get();
console.log(doc.data);

// Update document
await db.collection('tests').doc('test_123').update({
  name: 'Updated Test'
});

// Delete document
await db.collection('tests').doc('test_123').delete();

// Get all documents
const snapshot = await db.collection('tests').get();
console.log(snapshot.docs);

// Query documents
const snapshot = await db.collection('tests')
  .where('duration', '>', 60)
  .get();

// Real-time listener
const unsubscribe = db.collection('tests').onSnapshot(snapshot => {
  console.log('Tests updated:', snapshot.docs);
});

// Unsubscribe when done
unsubscribe();
```

### **File Storage**

```javascript
// Upload file
const fileInput = document.getElementById('file-input');
const file = fileInput.files[0];

const result = await db.storage().ref('uploads').put(file);
console.log('File URL:', result.url);

// Get file URL
const url = await db.storage().ref('uploads/filename.pdf').getDownloadURL();

// List files
const files = await db.storage().ref('uploads').list();
```

### **Batch Operations**

```javascript
const batch = db.batch();

batch.set(db.collection('tests').doc('test_1'), { name: 'Test 1' });
batch.set(db.collection('tests').doc('test_2'), { name: 'Test 2' });
batch.update(db.collection('tests').doc('test_3'), { name: 'Updated' });

await batch.commit();
```

---

## 🚀 Deployment

### **Quick Deploy on Railway.app (Recommended)**

1. Sign up on https://railway.app (with GitHub)
2. New Project → GitHub Repo → snaptestpro-backend
3. Add PostgreSQL database
4. Set environment variables
5. Done! Your app is live

**See DEPLOYMENT-GUIDE.md for detailed steps**

---

## 📊 Database Schema

Automatically created tables:

```sql
-- Users
users (id, uid, email, password, name, role, created_at)

-- Collections metadata
collections (id, name, schema, created_at)

-- Documents (data storage)
documents (id, doc_id, collection_name, data, user_id, created_at, updated_at)

-- File storage
file_storage (id, file_id, filename, size, mimetype, path, user_id, created_at)

-- Real-time listeners
listeners (id, collection_name, user_id, socket_id, created_at)
```

---

## 🔐 Security

### **Best Practices**

1. **Change JWT_SECRET**
   ```bash
   openssl rand -hex 32
   ```

2. **Use HTTPS in production**
   - Railway/Render provide free HTTPS
   - Self-hosted: Use certbot + Nginx

3. **Set CORS correctly**
   ```javascript
   CORS_ORIGINS=https://your-domain.com,https://www.your-domain.com
   ```

4. **Database credentials**
   - Never commit .env to GitHub
   - Use .gitignore (already included)
   - Use environment variables

5. **Rate limiting (Optional)**
   - Add express-rate-limit for protection
   - Implement authentication checks

---

## 📈 Scaling

| Users | Action | Cost |
|-------|--------|------|
| < 1L | Free tier (Railway) | ₹0 |
| 1L-10L | Paid plan (Railway) | ₹500-2000 |
| 10L+ | Self-hosted VPS | ₹500-1000 |

---

## 🔧 Configuration

### **Environment Variables**

```bash
# Required
PORT=3000
DATABASE_URL=postgresql://...
JWT_SECRET=your-secret

# Optional
NODE_ENV=production
BASE_URL=https://your-domain.com
CORS_ORIGINS=https://your-domain.com
STORAGE_TYPE=local
UPLOAD_DIR=./uploads
```

### **Database Connection String Format**

```
postgresql://[user]:[password]@[host]:[port]/[database]

Example:
postgresql://snaptestpro_user:password123@localhost:5432/snaptestpro
```

---

## 🆘 Troubleshooting

### **"Cannot connect to database"**
- Check DATABASE_URL is correct
- Verify PostgreSQL is running
- Test: `psql $DATABASE_URL`

### **"Port already in use"**
- Change PORT in .env
- Or kill process: `lsof -i :3000`

### **"Real-time updates not working"**
- Check socket.io is loaded
- Verify token is passed correctly
- Check browser console for errors

### **"CORS error"**
- Add your frontend URL to CORS_ORIGINS
- Restart server

### **"File upload fails"**
- Check uploads folder exists
- Verify file size limit (100MB default)
- Check disk space

---

## 📖 Full Documentation

1. **DEPLOYMENT-GUIDE.md** - Complete deployment guide
2. **FRONTEND-INTEGRATION.md** - Integration with SnapTestPro
3. **DATABASE-SCHEMA.md** - Detailed database structure

---

## 🎯 Next Steps

1. ✅ Read this README
2. ✅ Follow Quick Start above
3. ✅ Read DEPLOYMENT-GUIDE.md
4. ✅ Deploy to Railway/Render
5. ✅ Integrate with SnapTestPro app
6. ✅ Test everything works

---

## 💡 Use Cases

### ✅ Perfect For:
- Education apps (exams, tests)
- Social networks
- Real-time collaboration
- CMS platforms
- Chat applications
- Data dashboards

### ✅ What You Get:
- Zero Firebase costs
- Unlimited reads/writes
- Full control
- Real-time sync
- PostgreSQL reliability
- Scale to millions

---

## 📞 Support & Issues

- 📝 Check troubleshooting section
- 🔍 Enable DEBUG: `DEBUG=* npm start`
- 📊 Check logs: `pm2 logs`
- 🌐 Test health: `curl /api/health`

---

## 📄 License

MIT License - Use freely in your projects!

---

## 🎉 Summary

```
✅ Backend: Complete (Node.js + Express)
✅ Database: PostgreSQL (unlimited)
✅ API: Firebase-compatible
✅ Real-time: WebSocket
✅ Authentication: JWT
✅ File Storage: Built-in
✅ Free: Yes (₹0 forever)
✅ Scalable: Yes (1 crore+ users)
✅ Documentation: Complete
✅ Ready to Deploy: Yes
```

**You're ready to launch your app!** 🚀

---

## 🔗 Quick Links

- GitHub: https://github.com/YOUR_USERNAME/snaptestpro-backend
- Documentation: See files in repo
- Deploy: https://railway.app or https://render.com
- Frontend SDK: firebase-alternative-sdk.js

---

**Built with ❤️ for SnapTestPro**

Made to replace Firebase with 100% control and unlimited everything! 🎯
