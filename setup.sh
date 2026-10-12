#!/bin/bash

# ============================================
# 🚀 QUICK SETUP SCRIPT
# Run this to set up everything automatically
# ============================================

echo "╔════════════════════════════════════════════╗"
echo "║  🚀 SnapTestPro Backend Setup              ║"
echo "╚════════════════════════════════════════════╝"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not installed"
    echo "📥 Install from: https://nodejs.org/"
    exit 1
fi
echo "✅ Node.js found: $(node --version)"

# Check PostgreSQL
if ! command -v psql &> /dev/null; then
    echo "⚠️  PostgreSQL not found (optional)"
    echo "📥 Install from: https://www.postgresql.org/download/"
else
    echo "✅ PostgreSQL found"
fi

echo ""
echo "📦 Installing dependencies..."
npm install

echo ""
echo "📝 Creating .env file..."
if [ ! -f .env ]; then
    cp .env.example .env
    echo "✅ .env file created"
    echo "⚠️  Edit .env and add your database credentials:"
    echo "   nano .env"
else
    echo "ℹ️  .env file already exists"
fi

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║  ✅ Setup Complete!                        ║"
echo "╚════════════════════════════════════════════╝"
echo ""
echo "📝 Next steps:"
echo "  1. Edit .env file with your config"
echo "  2. Start database (PostgreSQL)"
echo "  3. Run: npm start"
echo "  4. Check: curl http://localhost:3000/api/health"
echo ""
echo "📚 Documentation:"
echo "  - README.md - Overview"
echo "  - DEPLOYMENT-GUIDE.md - How to deploy"
echo "  - FRONTEND-INTEGRATION.md - How to integrate with app"
echo ""
