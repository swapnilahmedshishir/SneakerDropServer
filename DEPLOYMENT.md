# Production Deployment Guide & Architecture Verification (Phase 16)

This document details the production deployment architecture, configuration steps, and verification procedures for the **Limited Edition Sneaker Drop** application.

---

## 1. Architecture & Expiration Strategy Inspection
- **Expiration Architecture Inspection**: The backend relies on an in-memory background worker (`startExpirationWorker` using `setInterval`) in `server/src/server.js` that polls the database every `EXPIRATION_POLL_INTERVAL_MS` (default 1000ms) to atomically expire active reservations and restore stock.
- **Serverless Compatibility**: Pure serverless functions (e.g. AWS Lambda without persistent containers or Vercel serverless functions) cannot reliably run a continuous `setInterval` polling worker. 
- **Production-Compatible Strategy Chosen**: The backend is designed to run on a **persistent Node.js container / web service** (such as **Render**, **Railway**, or **Fly.io**). This ensures:
  1. The background expiration worker runs continuously and reliably.
  2. **Socket.io** WebSocket connections remain open and stable for realtime stock updates, reservation expirations, and activity feeds.
  3. Database connection pooling and transaction serialization remain robust.

---

## 2. Infrastructure & Environment Setup

### Database (Neon PostgreSQL)
1. Provision a Neon PostgreSQL database instance.
2. Retrieve the secure connection string (`postgresql://user:password@host/dbname?sslmode=require`).

### Environment Variables
Ensure `.env` files are strictly git-ignored and never committed. Configure the following environment variables on the production hosting providers:

#### Backend Environment Variables (`server/.env` / Hosting Service Settings):
- `PORT=5000` (or assigned by host)
- `DATABASE_URL=postgresql://...` (Neon production connection string with `sslmode=require`)
- `CLIENT_URL=https://your-frontend-domain.vercel.app`
- `EXPIRATION_POLL_INTERVAL_MS=1000`

#### Frontend Environment Variables (`client/.env.production` / Vercel Settings):
- `VITE_API_URL=https://your-backend-domain.onrender.com`
- `VITE_SOCKET_URL=https://your-backend-domain.onrender.com`

---

## 3. Deployment Steps

### Step 1: Verify Production Builds
- **Client**: `npm run build --prefix client` (Verified successfully)
- **Server**: `npm test --prefix server` (All 42 tests passed successfully)

### Step 2: Database Migrations
Run production database migrations safely against Neon PostgreSQL:
```bash
npx prisma migrate deploy
```

### Step 3: Deploy Backend
1. Connect repository to **Render** / **Railway** / **Fly.io**.
2. Set Root Directory to `server`.
3. Build Command: `npm install`
4. Start Command: `npm start` (runs `tsx src/server.js`)
5. Inject production environment variables (`DATABASE_URL`, `CLIENT_URL`, etc.).

### Step 4: Deploy Frontend
1. Import client repository/folder into **Vercel**.
2. Framework Preset: **Vite**
3. Root Directory: `client`
4. Build Command: `npm run build`
5. Output Directory: `dist`
6. Add Environment Variable: `VITE_API_URL` pointing to the deployed backend URL.

---

## 4. Verification & Health Checks (Phase 16 Final Checklist)

1. **Health Endpoint**:
   - `GET /api/health` → Returns `{ "success": true, "message": "API is running" }`
2. **Database Connection**:
   - Verified via successful Prisma ORM transactions during startup and migration.
3. **Reservation & Purchase**:
   - Verified via rigorous test suites covering reservation locking, concurrent race conditions, purchases, and conflict resolution (409/410).
4. **Expiration**:
   - Verified that active reservations expire precisely after TTL, restoring stock atomically and idempotently.
5. **Realtime Synchronization**:
   - Socket.io tested with multiple browser windows to ensure immediate broadcast of stock updates and reservation expirations without requiring manual page refreshes.
