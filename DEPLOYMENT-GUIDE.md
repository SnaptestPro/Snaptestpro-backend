# 🚀 Complete Deployment Guide - Self-Hosted Firebase Alternative

## 📋 Table of Contents
1. [GitHub Upload](#github)
2. [Database Setup (PostgreSQL)](#database)
3. [Backend Deployment](#backend-deployment)
4. [Frontend Integration](#frontend)
5. [Domain & SSL](#domain)
6. [Monitoring & Scaling](#monitoring)

---

## 🐙 GitHub Upload

### **Step 1: Create GitHub Repository**

```bash
# Create account if you don't have one
# Go to https://github.com/new

# Repository name: snaptestpro-backend
# Description: Self-hosted Firebase alternative for SnapTestPro
# Visibility: Public (optional)

# Copy the HTTPS URL: https://github.com/YOUR_USERNAME/snaptestpro-backend.git
```

### **Step 2: Initialize Git Locally**

```bash
# Create project folder
mkdir snaptestpro-backend
cd snaptestpro-backend

# Initialize git
git init

# Add files
# (copy complete-firebase-alternative.js, firebase-alternative-sdk.js here)

# Create .gitignore
cat > .gitignore << EOF
node_modules/
.env
.env.local
uploads/*
*.log
.DS_Store
EOF

# Stage files
git add .
git commit -m "Initial commit: Firebase alternative backend"

# Add remote repository
git remote add origin https://github.com/YOUR_USERNAME/snaptestpro-backend.git

# Push to GitHub
git branch -M main
git push -u origin main
```

### **Step 3: Verify on GitHub**

- Go to https://github.com/YOUR_USERNAME/snaptestpro-backend
- Check that files are uploaded ✅

---

## 🗄️ Database Setup (PostgreSQL)

### **Option A: PostgreSQL Locally (Windows/Mac/Linux)**

#### **Windows:**
```bash
# Download from https://www.postgresql.org/download/windows/
# Run installer
# Default password: postgres
# Port: 5432

# Open Command Prompt
psql -U postgres

# Create database
CREATE DATABASE snaptestpro;
CREATE USER snaptestpro_user WITH PASSWORD 'strong_password_here';
ALTER ROLE snaptestpro_user WITH CREATEDB;
GRANT ALL PRIVILEGES ON DATABASE snaptestpro TO snaptestpro_user;
\q
```

#### **Mac (using Homebrew):**
```bash
brew install postgresql@15

# Start PostgreSQL
brew services start postgresql@15

# Create database
createdb snaptestpro

# Create user
psql snaptestpro -c "CREATE USER snaptestpro_user WITH PASSWORD 'strong_password_here';"
```

#### **Linux (Ubuntu):**
```bash
sudo apt update
sudo apt install postgresql postgresql-contrib

# Start service
sudo systemctl start postgresql

# Create database and user
sudo -u postgres psql -c "CREATE DATABASE snaptestpro;"
sudo -u postgres psql -c "CREATE USER snaptestpro_user WITH PASSWORD 'strong_password_here';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE snaptestpro TO snaptestpro_user;"
```

### **Option B: Cloud Database (FREE)**

#### **1. Heroku PostgreSQL (Deprecated - Check alternatives)**

#### **2. ElephantSQL (FREE tier)**

1. Go to https://www.elephantsql.com
2. Sign up (free)
3. Create new instance
   - Name: `snaptestpro`
   - Plan: Tiny Turtle (Free - 20MB)
4. Get connection URL:
   ```
   postgresql://[user]:[password]@[host]:5432/[database]
   ```

#### **3. Neon (Highly Recommended - FREE)**

1. Go to https://neon.tech
2. Sign up with GitHub
3. Create project: `snaptestpro`
4. Get connection string from dashboard

#### **4. Supabase PostgreSQL (FREE)**

1. Go to https://supabase.com
2. Create new project
3. Get connection URL from Settings → Database

---

## 🖥️ Backend Deployment

### **Option 1: Heroku (Simplest - 🆓 Free Tier Deprecated)**

**Current alternative: Railway.app or Render.com**

### **Option 2: Railway.app (RECOMMENDED - FREE)**

#### **Step 1: Create Account**
```
Go to https://railway.app
Sign up with GitHub
```

#### **Step 2: Connect GitHub Repository**

```
Dashboard → New Project → GitHub Repo
Select: snaptestpro-backend
```

#### **Step 3: Add PostgreSQL Database**

```
In Railway dashboard:
+ New → Database → PostgreSQL
```

#### **Step 4: Configure Environment Variables**

```
In Railway → Variables:

DATABASE_URL = (auto-filled from PostgreSQL)
PORT = 3000
JWT_SECRET = your-super-secret-key-change-this-value-NOW
NODE_ENV = production
BASE_URL = https://your-railway-domain.com
```

#### **Step 5: Deploy**

```
Railway automatically deploys on git push
Watch deployment logs
```

#### **Step 6: Get Your URL**

```
Railway gives you: https://snaptestpro-backend-production.up.railway.app
Use this as BASE_URL in frontend
```

---

### **Option 3: Render.com (FREE with generous limits)**

#### **Step 1: Create Account**
```
Go to https://render.com
Sign up with GitHub
```

#### **Step 2: Create PostgreSQL Database**

```
Dashboard → New → PostgreSQL
- Name: snaptestpro
- Region: Singapore (nearest to India)
```

#### **Step 3: Create Web Service**

```
Dashboard → New → Web Service
- Connect GitHub repo
- Select: snaptestpro-backend
- Runtime: Node
- Build command: npm install
- Start command: node complete-firebase-alternative.js
```

#### **Step 4: Set Environment Variables**

```
Environment:
DATABASE_URL = (from PostgreSQL connection string)
PORT = 3000
JWT_SECRET = your-super-secret-key
NODE_ENV = production
BASE_URL = https://your-render-domain.onrender.com
```

#### **Step 5: Deploy**

```
Render automatically deploys
Your URL: https://snaptestpro-backend.onrender.com
```

---

### **Option 4: Self-Host on VPS (Most Control - ₹100-500/month)**

#### **Providers:**
- Linode (₹200/month - good)
- DigitalOcean (₹200/month - best support)
- Hetzner (₹100/month - cheapest)
- AWS EC2 (₹300+/month)

#### **Setup Steps:**

```bash
# SSH into your VPS
ssh root@your-vps-ip

# Update system
apt update && apt upgrade -y

# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
apt install -y nodejs

# Install PostgreSQL
apt install -y postgresql postgresql-contrib

# Clone your GitHub repo
git clone https://github.com/YOUR_USERNAME/snaptestpro-backend.git
cd snaptestpro-backend

# Install dependencies
npm install

# Create .env file
nano .env

# Add:
DATABASE_URL=postgresql://user:pass@localhost:5432/snaptestpro
JWT_SECRET=your-secret-key
PORT=3000
BASE_URL=https://your-domain.com
NODE_ENV=production

# Install PM2 (keeps app running)
npm install -g pm2

# Start app
pm2 start complete-firebase-alternative.js --name snaptestpro

# Make it auto-start
pm2 startup
pm2 save

# Install Nginx (reverse proxy)
apt install -y nginx

# Create Nginx config
sudo nano /etc/nginx/sites-available/snaptestpro

# Add:
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    location /socket.io {
        proxy_pass http://localhost:3000/socket.io;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
    }
}

# Enable site
ln -s /etc/nginx/sites-available/snaptestpro /etc/nginx/sites-enabled/

# Test Nginx
nginx -t

# Restart Nginx
systemctl restart nginx

# Install SSL (Let's Encrypt - FREE)
apt install -y certbot python3-certbot-nginx
certbot --nginx -d your-domain.com

# Auto-renew SSL
systemctl enable certbot.timer
```

---

## 🌐 Frontend Integration

### **Step 1: Add SDK to Your HTML**

```html
<!-- In your index.html or app.html -->

<script src="https://cdn.socket.io/4.5.4/socket.io.min.js"></script>
<script src="/firebase-alternative-sdk.js"></script>

<script>
  // Initialize database
  const db = new FirebaseAlternative('https://your-backend-url.com');
  // or for local: 'http://localhost:3000'
</script>
```

### **Step 2: Replace Firebase Code**

#### **Before (Firebase):**
```javascript
firebase.auth().createUserWithEmailAndPassword(email, password);

db.collection('tests').onSnapshot(snapshot => {
  snapshot.forEach(doc => console.log(doc.data()));
});

db.collection('tests').add({ name: 'Test 1' });
```

#### **After (Our Backend):**
```javascript
// Auth
await db.auth().createUserWithEmailAndPassword(email, password, name);

// Real-time listener
db.collection('tests').onSnapshot(snapshot => {
  snapshot.docs.forEach(doc => console.log(doc.data));
});

// Add document
await db.collection('tests').add({ name: 'Test 1' });
```

### **Step 3: Update Your script.js**

```javascript
// At top of script.js
const db = new FirebaseAlternative('https://your-backend-url.com');

// Your existing syncBank function becomes:
async function syncBank() {
  try {
    const snapshot = await db.collection('questionBank').get();
    window.questionBank = snapshot.docs;
    renderBank();
  } catch (err) {
    console.error('Error syncing:', err);
  }
}

// Your syncTests becomes:
async function syncTests() {
  try {
    db.collection('tests').onSnapshot(snapshot => {
      window.tests = snapshot.docs;
      renderTests();
    });
  } catch (err) {
    console.error('Error syncing:', err);
  }
}

// Your saveRecordOnline becomes:
async function saveRecordOnline(record) {
  try {
    const docRef = await db.collection('studentRecords').add({
      mobile: record.mobile,
      testId: record.testId,
      answers: record.answers,
      score: record.score
    });
    
    console.log('Record saved:', docRef.id);
  } catch (err) {
    console.error('Error saving:', err);
  }
}
```

---

## 🔒 Domain & SSL

### **Option 1: Free Domain from Freenom**

```
Go to https://www.freenom.com
Register free .tk, .ml, .ga domain
(Not recommended for production)
```

### **Option 2: Cheap Domain**

```
Namecheap: ₹100/year (.com)
GoDaddy: ₹80/year first year
Route53: ₹120/year
```

### **Step 1: Point Domain to Your App**

#### **For Railway/Render:**
```
In Railway/Render dashboard, you get a subdomain
Or add custom domain and update DNS
```

#### **For Self-Hosted VPS:**
```
In your domain registrar:
DNS Records:
  A Record: your-vps-ip-address

Then in VPS:
certbot --nginx -d your-domain.com
(Automatic SSL setup)
```

### **Step 2: Update Frontend**

```javascript
// Change base URL to your domain
const db = new FirebaseAlternative('https://your-domain.com');
```

---

## 📊 Monitoring & Scaling

### **Monitor Your Backend**

#### **Check Status:**
```bash
# API health check
curl https://your-domain.com/api/health

# Should return:
{
  "success": true,
  "status": "healthy",
  "timestamp": "2024-01-10T10:30:00Z"
}
```

#### **View Logs:**

**Railway:**
```
Dashboard → Deployments → View Logs
```

**Render:**
```
Service → Logs
```

**VPS:**
```bash
pm2 logs snaptestpro
```

### **Database Optimization**

```sql
-- Add indexes for faster queries
CREATE INDEX idx_documents_collection ON documents(collection_name);
CREATE INDEX idx_documents_updated ON documents(updated_at);
CREATE INDEX idx_documents_user ON documents(user_id);

-- Vacuum database (cleanup)
VACUUM ANALYZE;
```

### **Scaling When You Hit Limits**

| Scale | Action |
|-------|--------|
| < 1 Lakh users | Free tier (Railway/Render) |
| 1-10 Lakh | Upgrade to paid plan |
| 10+ Lakh | Self-hosted VPS |

---

## ✅ Verification Checklist

After deployment, verify everything:

- [ ] Backend is running (`/api/health` returns 200)
- [ ] Can sign up new user
- [ ] Can login
- [ ] Can create collection
- [ ] Can add document
- [ ] Can get documents
- [ ] Real-time sync works (onSnapshot)
- [ ] File upload works
- [ ] SSL certificate works (green lock)
- [ ] CORS works (no errors in browser)

---

## 🆘 Troubleshooting

### **Problem: "Cannot connect to database"**
```
Solution: Check DATABASE_URL is correct
Test: psql $DATABASE_URL
```

### **Problem: "Port already in use"**
```
Solution: Change PORT env variable
Or kill existing process: lsof -i :3000
```

### **Problem: "CORS error in browser"**
```
Solution: Update CORS in backend:
const cors = require('cors');
app.use(cors({
  origin: ['https://your-domain.com', 'http://localhost:3000']
}));
```

### **Problem: "Real-time updates not working"**
```
Solution: Check socket.io script is loaded
Check WebSocket connection in DevTools → Network
Make sure subscribed with correct token
```

### **Problem: "File upload fails"**
```
Solution: Check uploads folder exists
Check file size limit
Check disk space on server
```

---

## 🎉 You're Done!

Your self-hosted Firebase alternative is now live!

**What you have:**
✅ Unlimited reads/writes (no limits!)
✅ Real-time data sync
✅ User authentication
✅ File storage
✅ PostgreSQL database
✅ 100% control
✅ ₹0-500/month cost (instead of ₹2,700+)

**Next: Integrate with SnapTestPro App**

See: FRONTEND-INTEGRATION.md

---

## 📞 Support

If you get stuck:
1. Check logs: `pm2 logs` or Railway/Render console
2. Test API: `curl http://localhost:3000/api/health`
3. Check database: `psql -d snaptestpro -c "SELECT * FROM users;"`
4. Enable debug: Add `DEBUG=*` before starting
