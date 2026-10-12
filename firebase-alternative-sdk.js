/**
 * 🎯 FIREBASE ALTERNATIVE SDK
 * 
 * Frontend library to use the self-hosted backend
 * Exactly like Firebase Firestore + Storage
 * 
 * Usage in your SnapTestPro app:
 * 
 * import Database from './firebase-alternative-sdk.js';
 * 
 * const db = new Database('http://localhost:3000');
 * 
 * // Auth
 * await db.auth().createUserWithEmailAndPassword(email, password);
 * await db.auth().signInWithEmailAndPassword(email, password);
 * 
 * // Firestore
 * await db.collection('questions').add({ question: 'What is 2+2?' });
 * await db.collection('tests').get();
 * 
 * // Real-time
 * db.collection('questions').onSnapshot(docs => console.log(docs));
 * 
 * // Storage
 * await db.storage().ref('uploads').put(file);
 */

class FirebaseAlternative {
  constructor(baseURL = 'http://localhost:3000') {
    this.baseURL = baseURL;
    this.token = localStorage.getItem('auth_token');
    this.currentUser = null;
    this.listeners = {};
    this.socket = null;
    this.initializeSocket();
  }

  // ============================================
  // 🔌 SOCKET.IO SETUP (Real-time)
  // ============================================

  initializeSocket() {
    const script = document.createElement('script');
    script.src = `${this.baseURL}/socket.io/socket.io.js`;
    script.onload = () => {
      this.socket = io(this.baseURL, {
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000
      });

      this.socket.on('connect', () => {
        console.log('✅ Real-time sync connected');
        this.resubscribeAll();
      });

      this.socket.on('update', (data) => {
        console.log('📢 Real-time update received:', data);
        this.notifyListeners(data);
      });

      this.socket.on('error', (error) => {
        console.error('❌ Socket error:', error);
      });
    };
    document.head.appendChild(script);
  }

  resubscribeAll() {
    if (!this.socket) return;
    for (const collection in this.listeners) {
      this.socket.emit('subscribe', { collection, token: this.token });
    }
  }

  // ============================================
  // 🔐 AUTHENTICATION
  // ============================================

  auth() {
    return {
      // Sign Up
      createUserWithEmailAndPassword: async (email, password, name) => {
        try {
          const response = await fetch(`${this.baseURL}/api/auth/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, name })
          });

          const data = await response.json();

          if (!response.ok) throw new Error(data.error);

          this.token = data.token;
          this.currentUser = data.user;
          localStorage.setItem('auth_token', this.token);

          return {
            user: data.user,
            token: data.token
          };
        } catch (err) {
          console.error('❌ Signup failed:', err.message);
          throw err;
        }
      },

      // Sign In
      signInWithEmailAndPassword: async (email, password) => {
        try {
          const response = await fetch(`${this.baseURL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
          });

          const data = await response.json();

          if (!response.ok) throw new Error(data.error);

          this.token = data.token;
          this.currentUser = data.user;
          localStorage.setItem('auth_token', this.token);

          // Subscribe to all listeners
          this.resubscribeAll();

          return {
            user: data.user,
            token: data.token
          };
        } catch (err) {
          console.error('❌ Login failed:', err.message);
          throw err;
        }
      },

      // Get current user
      currentUser: async () => {
        try {
          const response = await fetch(`${this.baseURL}/api/auth/me`, {
            headers: { 'Authorization': `Bearer ${this.token}` }
          });

          const data = await response.json();
          if (!response.ok) throw new Error(data.error);

          this.currentUser = data.user;
          return data.user;
        } catch (err) {
          console.error('❌ Get current user failed:', err.message);
          throw err;
        }
      },

      // Sign Out
      signOut: () => {
        this.token = null;
        this.currentUser = null;
        localStorage.removeItem('auth_token');
        console.log('✅ Signed out');
      }
    };
  }

  // ============================================
  // 📚 FIRESTORE (Collections & Documents)
  // ============================================

  collection(name) {
    return {
      // Add document (with auto ID)
      add: async (data) => {
        try {
          const response = await fetch(
            `${this.baseURL}/api/collections/${name}/documents`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.token}`
              },
              body: JSON.stringify({ data })
            }
          );

          const result = await response.json();
          if (!response.ok) throw new Error(result.error);

          return {
            id: result.doc.id,
            data: result.doc.data
          };
        } catch (err) {
          console.error(`❌ Add to ${name} failed:`, err.message);
          throw err;
        }
      },

      // Set document (with specific ID)
      doc: (docId) => ({
        set: async (data, options = {}) => {
          try {
            const response = await fetch(
              `${this.baseURL}/api/collections/${name}/documents`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({ docId, data })
              }
            );

            const result = await response.json();
            if (!response.ok) throw new Error(result.error);

            return {
              id: result.doc.id,
              data: result.doc.data
            };
          } catch (err) {
            console.error(`❌ Set ${name}/${docId} failed:`, err.message);
            throw err;
          }
        },

        get: async () => {
          try {
            const response = await fetch(
              `${this.baseURL}/api/collections/${name}/documents/${docId}`,
              {
                headers: { 'Authorization': `Bearer ${this.token}` }
              }
            );

            const result = await response.json();
            if (!response.ok) throw new Error(result.error);

            return {
              id: result.doc.id,
              data: result.doc.data,
              exists: true
            };
          } catch (err) {
            console.error(`❌ Get ${name}/${docId} failed:`, err.message);
            throw err;
          }
        },

        update: async (data) => {
          try {
            const response = await fetch(
              `${this.baseURL}/api/collections/${name}/documents/${docId}`,
              {
                method: 'PATCH',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({ data })
              }
            );

            const result = await response.json();
            if (!response.ok) throw new Error(result.error);

            return { success: true };
          } catch (err) {
            console.error(`❌ Update ${name}/${docId} failed:`, err.message);
            throw err;
          }
        },

        delete: async () => {
          try {
            const response = await fetch(
              `${this.baseURL}/api/collections/${name}/documents/${docId}`,
              {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${this.token}` }
              }
            );

            const result = await response.json();
            if (!response.ok) throw new Error(result.error);

            return { success: true };
          } catch (err) {
            console.error(`❌ Delete ${name}/${docId} failed:`, err.message);
            throw err;
          }
        }
      }),

      // Get all documents
      get: async () => {
        try {
          const response = await fetch(
            `${this.baseURL}/api/collections/${name}/documents`,
            {
              headers: { 'Authorization': `Bearer ${this.token}` }
            }
          );

          const result = await response.json();
          if (!response.ok) throw new Error(result.error);

          return {
            docs: result.docs,
            size: result.docs.length,
            empty: result.docs.length === 0
          };
        } catch (err) {
          console.error(`❌ Get ${name} failed:`, err.message);
          throw err;
        }
      },

      // Query documents
      where: (field, operator, value) => ({
        get: async () => {
          try {
            const response = await fetch(
              `${this.baseURL}/api/collections/${name}/documents?where=${field}=${value}`,
              {
                headers: { 'Authorization': `Bearer ${this.token}` }
              }
            );

            const result = await response.json();
            if (!response.ok) throw new Error(result.error);

            return {
              docs: result.docs,
              size: result.docs.length
            };
          } catch (err) {
            console.error(`❌ Query ${name} failed:`, err.message);
            throw err;
          }
        }
      }),

      // Real-time listener (onSnapshot)
      onSnapshot: async (callback) => {
        try {
          // Get initial data
          const response = await fetch(
            `${this.baseURL}/api/collections/${name}/documents`,
            {
              headers: { 'Authorization': `Bearer ${this.token}` }
            }
          );

          const result = await response.json();
          if (!response.ok) throw new Error(result.error);

          callback({
            docs: result.docs,
            size: result.docs.length
          });

          // Subscribe to real-time updates
          if (!this.listeners[name]) {
            this.listeners[name] = [];
          }
          this.listeners[name].push(callback);

          if (this.socket) {
            this.socket.emit('subscribe', { collection: name, token: this.token });
          }

          // Return unsubscribe function
          return () => {
            this.listeners[name] = this.listeners[name].filter(cb => cb !== callback);
            if (this.listeners[name].length === 0) {
              this.socket.emit('unsubscribe', name);
            }
          };
        } catch (err) {
          console.error(`❌ Subscribe to ${name} failed:`, err.message);
          throw err;
        }
      }
    };
  }

  // Notify all listeners of updates
  notifyListeners(update) {
    const { collection } = update;
    if (this.listeners[collection]) {
      this.listeners[collection].forEach(callback => {
        callback({
          docs: [update.data],
          size: 1,
          update: true,
          action: update.action
        });
      });
    }
  }

  // ============================================
  // 💾 STORAGE (File uploads)
  // ============================================

  storage() {
    return {
      ref: (path) => ({
        // Upload file
        put: async (file) => {
          try {
            const formData = new FormData();
            formData.append('file', file);

            const response = await fetch(`${this.baseURL}/api/storage/upload`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${this.token}` },
              body: formData
            });

            const result = await response.json();
            if (!response.ok) throw new Error(result.error);

            return {
              ref: result.file.id,
              name: result.file.name,
              url: result.file.url,
              size: result.file.size,
              metadata: {
                name: result.file.name,
                size: result.file.size,
                contentType: file.type
              }
            };
          } catch (err) {
            console.error('❌ Upload failed:', err.message);
            throw err;
          }
        },

        // Get download URL
        getDownloadURL: async () => {
          // In real implementation, generate signed URL
          return `${this.baseURL}/uploads/${path}`;
        }
      })
    };
  }

  // ============================================
  // 📊 UTILITIES
  // ============================================

  // Batch operations
  batch() {
    const operations = [];

    return {
      set: (reference, data) => {
        operations.push({ type: 'set', reference, data });
        return this.batch();
      },

      update: (reference, data) => {
        operations.push({ type: 'update', reference, data });
        return this.batch();
      },

      delete: (reference) => {
        operations.push({ type: 'delete', reference });
        return this.batch();
      },

      commit: async () => {
        try {
          const promises = operations.map(op => {
            if (op.type === 'set') {
              return op.reference.set(op.data);
            } else if (op.type === 'update') {
              return op.reference.update(op.data);
            } else if (op.type === 'delete') {
              return op.reference.delete();
            }
          });

          await Promise.all(promises);
          return { success: true };
        } catch (err) {
          console.error('❌ Batch commit failed:', err.message);
          throw err;
        }
      }
    };
  }

  // Server timestamp
  static serverTimestamp() {
    return new Date();
  }

  // Increment field value
  static increment(value) {
    return { _increment: value };
  }

  // Array union
  static arrayUnion(...elements) {
    return { _arrayUnion: elements };
  }
}

// Export for use
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FirebaseAlternative;
}
