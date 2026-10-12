# 📚 API Reference - Complete Endpoint Documentation

**Firebase-compatible REST API + WebSocket Real-time**

---

## 🔐 Authentication Endpoints

### **POST /api/auth/signup**
Create a new user account

**Request:**
```json
{
  "email": "user@example.com",
  "password": "password123",
  "name": "User Name"
}
```

**Response:**
```json
{
  "success": true,
  "user": {
    "uid": "user_1234567890",
    "email": "user@example.com",
    "name": "User Name"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**cURL Example:**
```bash
curl -X POST http://localhost:3000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "password123",
    "name": "User Name"
  }'
```

---

### **POST /api/auth/login**
Sign in with email and password

**Request:**
```json
{
  "email": "user@example.com",
  "password": "password123"
}
```

**Response:**
```json
{
  "success": true,
  "user": {
    "uid": "user_1234567890",
    "email": "user@example.com",
    "name": "User Name"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**cURL Example:**
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "password123"
  }'
```

---

### **GET /api/auth/me**
Get current logged-in user

**Headers:**
```
Authorization: Bearer YOUR_TOKEN_HERE
```

**Response:**
```json
{
  "success": true,
  "user": {
    "id": 1,
    "uid": "user_1234567890",
    "email": "user@example.com",
    "name": "User Name"
  }
}
```

**cURL Example:**
```bash
curl http://localhost:3000/api/auth/me \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## 📚 Collections (Firestore) Endpoints

### **POST /api/collections**
Create a new collection

**Headers:**
```
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json
```

**Request:**
```json
{
  "name": "tests",
  "schema": {
    "name": "string",
    "duration": "number",
    "questions": "array"
  }
}
```

**Response:**
```json
{
  "success": true,
  "collection": {
    "id": 1,
    "name": "tests",
    "schema": {...},
    "created_at": "2024-01-10T10:00:00Z"
  }
}
```

---

### **GET /api/collections**
List all collections

**Headers:**
```
Authorization: Bearer YOUR_TOKEN
```

**Response:**
```json
{
  "success": true,
  "collections": [
    {
      "id": 1,
      "name": "tests",
      "created_at": "2024-01-10T10:00:00Z"
    },
    {
      "id": 2,
      "name": "students",
      "created_at": "2024-01-10T10:05:00Z"
    }
  ]
}
```

---

### **POST /api/collections/:collection/documents**
Add a document (with auto ID or custom ID)

**Headers:**
```
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json
```

**Request:**
```json
{
  "data": {
    "name": "Math Test",
    "duration": 60,
    "totalQuestions": 20
  },
  "docId": "test_123"  // Optional - if not provided, auto ID is generated
}
```

**Response:**
```json
{
  "success": true,
  "doc": {
    "id": "test_123",
    "data": {
      "name": "Math Test",
      "duration": 60,
      "totalQuestions": 20
    },
    "createdAt": "2024-01-10T10:00:00Z",
    "updatedAt": "2024-01-10T10:00:00Z"
  }
}
```

---

### **GET /api/collections/:collection/documents**
Get all documents from a collection

**Headers:**
```
Authorization: Bearer YOUR_TOKEN
```

**Query Parameters:**
```
?limit=100
?where=fieldName=value
?orderBy=fieldName:desc
```

**Response:**
```json
{
  "success": true,
  "docs": [
    {
      "id": "test_123",
      "data": {...},
      "createdAt": "...",
      "updatedAt": "..."
    }
  ],
  "count": 5
}
```

**Examples:**

```bash
# Get all tests
curl http://localhost:3000/api/collections/tests/documents \
  -H "Authorization: Bearer TOKEN"

# Get with limit
curl "http://localhost:3000/api/collections/tests/documents?limit=50" \
  -H "Authorization: Bearer TOKEN"

# Get with where clause
curl "http://localhost:3000/api/collections/tests/documents?where=duration=60" \
  -H "Authorization: Bearer TOKEN"

# Get and order
curl "http://localhost:3000/api/collections/tests/documents?orderBy=createdAt:desc" \
  -H "Authorization: Bearer TOKEN"
```

---

### **GET /api/collections/:collection/documents/:docId**
Get a specific document

**Headers:**
```
Authorization: Bearer YOUR_TOKEN
```

**Response:**
```json
{
  "success": true,
  "doc": {
    "id": "test_123",
    "data": {
      "name": "Math Test",
      "duration": 60
    },
    "createdAt": "2024-01-10T10:00:00Z",
    "updatedAt": "2024-01-10T10:00:00Z"
  }
}
```

---

### **PATCH /api/collections/:collection/documents/:docId**
Update a document

**Headers:**
```
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json
```

**Request:**
```json
{
  "data": {
    "name": "Updated Math Test",
    "duration": 90
  }
}
```

**Response:**
```json
{
  "success": true,
  "doc": {
    "id": "test_123",
    "data": {
      "name": "Updated Math Test",
      "duration": 90
    }
  }
}
```

---

### **DELETE /api/collections/:collection/documents/:docId**
Delete a document

**Headers:**
```
Authorization: Bearer YOUR_TOKEN
```

**Response:**
```json
{
  "success": true,
  "message": "Document deleted"
}
```

---

## 💾 File Storage Endpoints

### **POST /api/storage/upload**
Upload a file

**Headers:**
```
Authorization: Bearer YOUR_TOKEN
Content-Type: multipart/form-data
```

**Request:**
```
Form Data:
  file: <binary file data>
```

**Response:**
```json
{
  "success": true,
  "file": {
    "id": "file_1234567890",
    "name": "document.pdf",
    "url": "http://localhost:3000/uploads/uniquename.pdf",
    "size": 2048
  }
}
```

**cURL Example:**
```bash
curl -X POST http://localhost:3000/api/storage/upload \
  -H "Authorization: Bearer TOKEN" \
  -F "file=@/path/to/file.pdf"
```

---

### **GET /uploads/:filename**
Download a file

**Response:** Binary file data

**Example:**
```
http://localhost:3000/uploads/uniquename.pdf
```

---

### **GET /api/storage/files**
List user's uploaded files

**Headers:**
```
Authorization: Bearer YOUR_TOKEN
```

**Response:**
```json
{
  "success": true,
  "files": [
    {
      "id": "file_123",
      "name": "document.pdf",
      "url": "http://localhost:3000/uploads/file1.pdf",
      "size": 2048
    }
  ]
}
```

---

## 📊 Monitoring Endpoints

### **GET /api/health**
Server health check

**Response:**
```json
{
  "success": true,
  "status": "healthy",
  "timestamp": "2024-01-10T10:00:00Z"
}
```

---

### **GET /api/stats**
Get server statistics

**Headers:**
```
Authorization: Bearer YOUR_TOKEN
```

**Response:**
```json
{
  "success": true,
  "stats": {
    "users": 1250,
    "documents": 15000,
    "files": 3500,
    "storageUrl": "http://localhost:3000/uploads"
  }
}
```

---

## 🔌 WebSocket Events (Real-time Sync)

### **Subscribe to Collection**

**Client sends:**
```javascript
socket.emit('subscribe', {
  collection: 'tests',
  token: 'YOUR_JWT_TOKEN'
});
```

**Server responds:**
```javascript
socket.on('update', (data) => {
  // {
  //   collection: 'tests',
  //   docId: 'test_123',
  //   data: { name: 'Updated Test' },
  //   action: 'set' | 'update' | 'delete',
  //   timestamp: '2024-01-10T10:00:00Z'
  // }
});
```

---

### **Unsubscribe from Collection**

**Client sends:**
```javascript
socket.emit('unsubscribe', 'tests');
```

---

### **Real-time Update Events**

When a document is created/updated/deleted:

```json
{
  "collection": "tests",
  "docId": "test_123",
  "data": {
    "name": "Math Test",
    "duration": 60
  },
  "action": "update",
  "timestamp": "2024-01-10T10:00:00Z"
}
```

---

## 🧪 Testing with Postman/cURL

### **1. Sign Up**
```bash
curl -X POST http://localhost:3000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "test123",
    "name": "Test User"
  }'

# Save the token from response
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

### **2. Create Collection**
```bash
curl -X POST http://localhost:3000/api/collections \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "tests"
  }'
```

### **3. Add Document**
```bash
curl -X POST http://localhost:3000/api/collections/tests/documents \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "name": "Math Test",
      "duration": 60
    }
  }'
```

### **4. Get All Documents**
```bash
curl http://localhost:3000/api/collections/tests/documents \
  -H "Authorization: Bearer $TOKEN"
```

### **5. Upload File**
```bash
curl -X POST http://localhost:3000/api/storage/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/path/to/file.pdf"
```

---

## ⚠️ Error Responses

### **401 Unauthorized**
```json
{
  "error": "No token provided"
}
```

### **403 Forbidden**
```json
{
  "error": "Invalid token"
}
```

### **404 Not Found**
```json
{
  "error": "Document not found"
}
```

### **400 Bad Request**
```json
{
  "error": "Invalid input"
}
```

### **500 Server Error**
```json
{
  "error": "Internal server error",
  "message": "Detailed error message"
}
```

---

## 🔐 Authentication

All protected endpoints require:

```
Authorization: Bearer YOUR_JWT_TOKEN
```

**How to get token:**
1. Sign up: `POST /api/auth/signup`
2. Get token from response
3. Include in all future requests

**Token format:**
```
Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwidWlkIjoiXHUwMDIwdXNlcl8xMjM0NTY3ODkwIiwiaWF0IjoxNjczNDU2MDAwfQ.signature
```

---

## 📈 Rate Limiting

Currently: **No rate limiting** (unlimited requests)

Future: Can be added if needed
```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1673500000
```

---

## 🔄 Pagination

For large datasets:

```
GET /api/collections/tests/documents?limit=50&offset=0
```

---

## 📝 Notes

- All timestamps are in ISO 8601 format
- All IDs are strings (UUID or custom)
- JWT tokens expire in 30 days
- Database auto-creates tables on first run
- WebSocket connection required for real-time updates

---

## 🎯 SDK vs REST

**Use REST API when:**
- Making simple HTTP calls
- Testing endpoints
- Server-to-server communication

**Use SDK when:**
- Building frontend
- Need real-time sync
- Want Firebase-like syntax

---

## 📞 Support

- Check logs: `pm2 logs`
- Test health: `curl /api/health`
- Enable debug: `DEBUG=* npm start`
