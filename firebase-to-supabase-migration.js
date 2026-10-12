/**
 * Firebase to Supabase Migration Script
 * Run this in your browser console or as Node.js script
 * Migrates all data from Firebase Firestore to Supabase PostgreSQL
 */

// ============================================
// Configuration
// ============================================

const FIREBASE_CONFIG = {
  projectId: 'the-vishnu-sharma-test', // Your Firebase project ID
  apiKey: 'AIzaSy...', // Get from Firebase Console
};

const SUPABASE_CONFIG = {
  url: 'https://your-project.supabase.co',
  anonKey: 'eyJhbG...',
  backendUrl: 'https://your-backend.com' // Your deployed API
};

// ============================================
// Migration Engine
// ============================================

class FirebaseToSupabaseMigration {
  constructor(firebaseConfig, supabaseConfig) {
    this.firebaseConfig = firebaseConfig;
    this.supabaseConfig = supabaseConfig;
    this.migrationStats = {
      questions: 0,
      tests: 0,
      records: 0,
      errors: 0,
      startTime: null,
      endTime: null
    };
  }

  log(message, data = '') {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${message}`, data);
  }

  error(message, err) {
    console.error(`❌ ERROR: ${message}`, err);
    this.migrationStats.errors++;
  }

  // ============================================
  // 1️⃣ MIGRATE QUESTION BANK
  // ============================================
  async migrateQuestions(db) {
    this.log('🔄 Starting question bank migration...');

    try {
      const questionsSnapshot = await db.collection('questionBank').get();
      const questions = [];

      questionsSnapshot.forEach(doc => {
        questions.push({
          firestore_id: doc.id,
          chapter: doc.data().chapter || '',
          subject: doc.data().subject || '',
          question_text: doc.data().question || doc.data().questionText || '',
          options: JSON.stringify(doc.data().options || {}),
          correct_answer: doc.data().correct || doc.data().correctAnswer || '',
          explanation: doc.data().explanation || '',
          class_id: doc.data().class || doc.data().classId || '',
          institute_id: doc.data().instituteId || '',
          created_at: doc.data().createdAt ? new Date(doc.data().createdAt.seconds * 1000).toISOString() : new Date().toISOString(),
          updated_at: doc.data().updatedAt ? new Date(doc.data().updatedAt.seconds * 1000).toISOString() : new Date().toISOString()
        });
      });

      this.log(`📦 Uploading ${questions.length} questions to Supabase...`);

      // Upload in batches (Supabase has limits)
      const batchSize = 100;
      for (let i = 0; i < questions.length; i += batchSize) {
        const batch = questions.slice(i, i + batchSize);
        
        const response = await fetch(`${this.supabaseConfig.backendUrl}/api/sync/batch-upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            table: 'question_bank',
            records: batch
          })
        });

        const result = await response.json();
        if (!result.success) throw new Error(result.error);

        this.log(`  ✅ Batch ${Math.ceil(i / batchSize) + 1}/${Math.ceil(questions.length / batchSize)} done`);
      }

      this.migrationStats.questions = questions.length;
      this.log(`✅ Question bank migrated: ${questions.length} questions`);
      return true;

    } catch (err) {
      this.error('Question bank migration failed', err);
      return false;
    }
  }

  // ============================================
  // 2️⃣ MIGRATE TESTS
  // ============================================
  async migrateTests(db) {
    this.log('🔄 Starting tests migration...');

    try {
      const testsSnapshot = await db.collection('tests').get();
      const tests = [];
      const testQuestionsMap = {}; // Store test->questions mapping

      testsSnapshot.forEach(doc => {
        const testData = doc.data();
        
        tests.push({
          firestore_id: doc.id,
          test_name: testData.name || testData.testName || '',
          institute_id: testData.instituteId || '',
          class_id: testData.class || testData.classId || '',
          total_questions: testData.questions?.length || 0,
          duration_minutes: testData.duration || 0,
          passing_percentage: testData.passingPercentage || 40,
          is_published: !testData.isDraft,
          is_draft: testData.isDraft || false,
          created_at: testData.createdAt ? new Date(testData.createdAt.seconds * 1000).toISOString() : new Date().toISOString(),
          updated_at: testData.updatedAt ? new Date(testData.updatedAt.seconds * 1000).toISOString() : new Date().toISOString()
        });

        // Store questions mapping
        testQuestionsMap[doc.id] = testData.questions || [];
      });

      this.log(`📦 Uploading ${tests.length} tests to Supabase...`);

      // Upload tests in batches
      const batchSize = 50;
      for (let i = 0; i < tests.length; i += batchSize) {
        const batch = tests.slice(i, i + batchSize);
        
        const response = await fetch(`${this.supabaseConfig.backendUrl}/api/sync/batch-upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            table: 'tests',
            records: batch
          })
        });

        const result = await response.json();
        if (!result.success) throw new Error(result.error);

        this.log(`  ✅ Batch ${Math.ceil(i / batchSize) + 1}/${Math.ceil(tests.length / batchSize)} done`);
      }

      // Store test-questions mapping for next step
      this.testQuestionsMap = testQuestionsMap;
      this.migrationStats.tests = tests.length;
      this.log(`✅ Tests migrated: ${tests.length} tests`);
      return true;

    } catch (err) {
      this.error('Tests migration failed', err);
      return false;
    }
  }

  // ============================================
  // 3️⃣ MIGRATE STUDENT RECORDS
  // ============================================
  async migrateRecords(db) {
    this.log('🔄 Starting student records migration...');

    try {
      const recordsSnapshot = await db.collection('studentRecords').get();
      const records = [];

      recordsSnapshot.forEach(doc => {
        const recordData = doc.data();
        
        records.push({
          firestore_id: doc.id,
          student_mobile: recordData.mobile || recordData.studentMobile || '',
          student_name: recordData.name || recordData.studentName || '',
          test_id: recordData.testId || '',
          answers: JSON.stringify(recordData.answers || {}),
          score: recordData.score || 0,
          percentage: recordData.percentage || 0,
          passed: recordData.passed || false,
          time_taken_seconds: recordData.timeSpent || recordData.timeTaken || 0,
          submitted_at: recordData.submittedAt ? new Date(recordData.submittedAt.seconds * 1000).toISOString() : new Date().toISOString(),
          updated_at: recordData.updatedAt ? new Date(recordData.updatedAt.seconds * 1000).toISOString() : new Date().toISOString()
        });
      });

      this.log(`📦 Uploading ${records.length} student records to Supabase...`);

      // Upload in batches
      const batchSize = 100;
      for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        
        const response = await fetch(`${this.supabaseConfig.backendUrl}/api/sync/batch-upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            table: 'student_records',
            records: batch
          })
        });

        const result = await response.json();
        if (!result.success) throw new Error(result.error);

        this.log(`  ✅ Batch ${Math.ceil(i / batchSize) + 1}/${Math.ceil(records.length / batchSize)} done`);
      }

      this.migrationStats.records = records.length;
      this.log(`✅ Records migrated: ${records.length} student records`);
      return true;

    } catch (err) {
      this.error('Records migration failed', err);
      return false;
    }
  }

  // ============================================
  // 4️⃣ MIGRATE INSTITUTES & ADMINS
  // ============================================
  async migrateInstitutes(db) {
    this.log('🔄 Starting institutes migration...');

    try {
      const institutesSnapshot = await db.collection('institutes').get();
      const institutes = [];

      institutesSnapshot.forEach(doc => {
        institutes.push({
          name: doc.data().name || '',
          admin_mobile: doc.data().adminMobile || '',
          admin_name: doc.data().adminName || '',
          city: doc.data().city || '',
          created_at: doc.data().createdAt ? new Date(doc.data().createdAt.seconds * 1000).toISOString() : new Date().toISOString()
        });
      });

      if (institutes.length > 0) {
        const response = await fetch(`${this.supabaseConfig.backendUrl}/api/sync/batch-upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            table: 'institutes',
            records: institutes
          })
        });

        const result = await response.json();
        if (!result.success) throw new Error(result.error);

        this.log(`✅ Institutes migrated: ${institutes.length} institutes`);
      }

      return true;

    } catch (err) {
      this.error('Institutes migration failed', err);
      return false;
    }
  }

  // ============================================
  // RUN FULL MIGRATION
  // ============================================
  async runFullMigration() {
    this.migrationStats.startTime = new Date();
    this.log('🚀 Starting full Firebase → Supabase migration');
    this.log('===============================================');

    try {
      // Initialize Firebase (assuming you have it loaded)
      if (!window.firebase) {
        throw new Error('Firebase SDK not loaded. Please include Firebase in your page.');
      }

      const db = window.firebase.firestore();

      // Step 1: Migrate questions
      const q1 = await this.migrateQuestions(db);
      if (!q1) return this.printSummary();

      // Step 2: Migrate tests
      const q2 = await this.migrateTests(db);
      if (!q2) return this.printSummary();

      // Step 3: Migrate records
      const q3 = await this.migrateRecords(db);
      if (!q3) return this.printSummary();

      // Step 4: Migrate institutes
      const q4 = await this.migrateInstitutes(db);

      this.log('===============================================');
      this.log('✅ MIGRATION COMPLETE!');
      this.printSummary();

    } catch (err) {
      this.error('Migration failed', err);
      this.printSummary();
    }
  }

  printSummary() {
    this.migrationStats.endTime = new Date();
    const duration = (this.migrationStats.endTime - this.migrationStats.startTime) / 1000;

    console.log('\n📊 MIGRATION SUMMARY:');
    console.log('═══════════════════════════════════');
    console.log(`✅ Questions: ${this.migrationStats.questions}`);
    console.log(`✅ Tests: ${this.migrationStats.tests}`);
    console.log(`✅ Records: ${this.migrationStats.records}`);
    console.log(`❌ Errors: ${this.migrationStats.errors}`);
    console.log(`⏱️  Duration: ${duration.toFixed(2)} seconds`);
    console.log('═══════════════════════════════════\n');

    if (this.migrationStats.errors === 0) {
      console.log('🎉 All data successfully migrated to Supabase!');
      console.log('\n✅ Next steps:');
      console.log('1. Verify data in Supabase dashboard');
      console.log('2. Update frontend to use new API endpoints');
      console.log('3. Disable Firebase in your app');
      console.log('4. Delete Firebase project (or keep as backup)\n');
    } else {
      console.log('⚠️  Some data failed to migrate. Check errors above and retry.');
    }
  }
}

// ============================================
// USAGE IN BROWSER
// ============================================

/*
// 1. Load Firebase SDK in console
firebase.initializeApp({
  projectId: 'the-vishnu-sharma-test',
  // ... other config
});

// 2. Run migration
const migration = new FirebaseToSupabaseMigration(
  FIREBASE_CONFIG,
  SUPABASE_CONFIG
);

await migration.runFullMigration();
*/

// ============================================
// USAGE IN NODE.JS
// ============================================

/*
const admin = require('firebase-admin');
const serviceAccount = require('./path/to/serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Modify class to work with Node.js
class NodeMigration extends FirebaseToSupabaseMigration {
  async migrateQuestions(db) {
    // ... same as above
  }
}

const migration = new NodeMigration(FIREBASE_CONFIG, SUPABASE_CONFIG);
await migration.runFullMigration();

process.exit(0);
*/

// ============================================
// EXPORT FOR NODE.JS
// ============================================

if (typeof module !== 'undefined' && module.exports) {
  module.exports = FirebaseToSupabaseMigration;
}
