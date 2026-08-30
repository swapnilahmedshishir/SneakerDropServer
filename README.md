# Limited Edition Sneaker Drop — Server

The backend for the Limited Edition Sneaker Drop assessment: a REST API + Socket.io gateway that owns all inventory truth. Reservation, purchase, and expiration each resolve on a single atomic conditional SQL statement, so overselling and double-selling are impossible by construction rather than by luck.

> Verified with 42 automated tests, including a 100-concurrent-request overselling stress test and expiration/purchase race proofs. See [Testing](#testing).

## Overview

- **Owns the source of truth.** React, Redux, and Socket.io on the client only ever _display_ what this server decides. No stock or reservation state is trusted from anywhere else.
- **Layered architecture.** `routes → controllers → services → Prisma → PostgreSQL`, with business logic and transactions living entirely in the services layer.
- **Background worker.** A 1-second poll expires due reservations and restores stock — but correctness never depends on the worker running; every request re-validates against the database row itself.
- **Real-time.** Socket.io broadcasts `stock_updated` and `reservation_expired` to every connected client, always _after_ the driving transaction has committed, never before.

## Tech Stack

| Concern        | Technology               | Notes                                                                                  |
| -------------- | ------------------------ | -------------------------------------------------------------------------------------- |
| Runtime        | Node.js (ESM)            | developed on Node 24, requires 20+                                                     |
| HTTP framework | Express 5                | routes → controllers → services                                                        |
| Realtime       | Socket.io 4.8.3          | server → client push only; clients cannot mutate state via sockets                     |
| ORM            | Prisma (contract-driven) | typed client generated from `src/prisma/contract.prisma`                               |
| Database       | PostgreSQL 15+           | developed against 18; CHECK constraints, partial unique indexes, row-lock transactions |
| Testing        | `node:test` via `tsx`    | 7 suites / 42 tests against a real PostgreSQL instance                                 |

## Architecture

```text
                         REST: /api/drops, /api/reservations
                         Socket.io: stock_updated, reservation_expired
                                    (server → client push only)
Client (React/Vite) ───────────────────────────────────────────▶ Express API + Socket.io
                                                                        │
                                                     services layer: reservation · drop
                                                     · expiration · socket
                                                                        │
                                                                        ▼
                                                                  Prisma ORM
                                                                        │
                                                                        ▼
                                                                  PostgreSQL
                                                                        ▲
                                                                        │
                                                     expiration worker: 1s poll
                                                     (the DB clock decides what expires,
                                                      the timer only wakes the loop)
```

Request lifecycle: route validates shape → controller maps HTTP concerns (params, status codes) → service runs the actual business logic inside a database transaction → on commit, the service (or worker) broadcasts the relevant Socket.io event.

```text
server/
├── prisma.config.ts
├── migrations/app/            # contract migrations
├── prisma/                    # schema reference (legacy generator)
└── src/
    ├── app.js                 # express app
    ├── server.js              # http + socket.io + worker boot
    ├── controllers/           # validation + HTTP status/error mapping
    ├── routes/
    ├── services/              # reservation / drop / expiration / socket — business logic
    ├── prisma/                # contract.prisma + generated client (db.ts)
    └── tests/                 # node:test suites, incl. the Phase 14 e2e boot test
```

## Database Schema

Four models — physical tables `user`, `drop`, `reservation`, `purchase`, foreign keys cascading on delete:

```mermaid
erDiagram
    USER ||--o{ RESERVATION : places
    USER ||--o{ PURCHASE : makes
    DROP ||--o{ RESERVATION : "is reserved in"
    DROP ||--o{ PURCHASE : "sells"
    RESERVATION ||--o| PURCHASE : "converts to"
```

| Model           | Key columns                                                                                                               | Constraints & indexes                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **User**        | `id` PK · `username`                                                                                                      | `username` UNIQUE (+ index)                                                                                                                                                                         |
| **Drop**        | `id` PK · `name` · `price` · `totalStock` · `availableStock` · `startsAt`                                                 | CHECK `drop_stock_valid`: `availableStock >= 0 AND availableStock <= totalStock` · indexes on `startsAt`, `availableStock`                                                                          |
| **Reservation** | `id` PK · `userId` FK→User · `dropId` FK→Drop · `status` (`ACTIVE`/`EXPIRED`/`PURCHASED`, default `ACTIVE`) · `expiresAt` | **partial UNIQUE** `(userId, dropId) WHERE status = 'ACTIVE'` — at most one live reservation per user per drop · indexes on `status`, `(expiresAt, status)`, `(userId, status)`, `(dropId, status)` |
| **Purchase**    | `id` PK · `userId` FK→User · `dropId` FK→Drop · `reservationId` FK→Reservation · `createdAt`                              | `reservationId` **UNIQUE** — at most one purchase per reservation · index `(dropId, createdAt)` powers the recent-purchasers feed                                                                   |

The CHECK and the two UNIQUE constraints are database-level backstops: even application bugs cannot persist negative stock, two ACTIVE reservations for the same user+drop, or two purchases for one reservation.

## API Endpoints

Base URL: `http://localhost:5000/api` — every response is `{ success: boolean, data?/message? }`.

| Method | Path                                    | Body                                    | Success                                                                                            | Errors                                                                                                            |
| ------ | --------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`                               | —                                       | `200`                                                                                              | —                                                                                                                 |
| POST   | `/drops`                                | `{ name, price, totalStock, startsAt }` | `201` Drop                                                                                         | `400` validation (name/price/totalStock/startsAt)                                                                 |
| GET    | `/drops`                                | —                                       | `200` Drop[]                                                                                       | —                                                                                                                 |
| GET    | `/drops/active`                         | —                                       | `200` (Drop & `{ recentPurchasers: {username}[] }`)[] — latest 3 purchasers per drop, newest first | —                                                                                                                 |
| POST   | `/drops/:dropId/reserve`                | `{ userId }`                            | `201` Reservation                                                                                  | `400` bad ids / drop not started · `404` unknown user/drop · `409` active reservation exists / out of stock       |
| POST   | `/reservations/:reservationId/purchase` | `{ userId }`                            | `201` Purchase                                                                                     | `400` bad/missing ids · `403` not the owner · `404` unknown reservation · `409` already purchased · `410` expired |

Unknown routes → `404 { success: false, message: "Route not found" }`; unhandled errors → `500` via the global error middleware.

```bash
# Create a drop (a past startsAt makes it active immediately)
curl -X POST http://localhost:5000/api/drops -H "Content-Type: application/json" \
  -d '{"name":"Air Jordan 1","price":200,"totalStock":5,"startsAt":"2026-08-29T08:59:00Z"}'
```

```json
{
  "success": true,
  "data": {
    "id": 1,
    "name": "Air Jordan 1",
    "price": 200,
    "totalStock": 5,
    "availableStock": 5,
    "startsAt": "2026-08-29 08:59:00+00",
    "createdAt": "2026-08-29 08:59:00.123+00",
    "updatedAt": "2026-08-29 08:59:00.123+00"
  }
}
```

```bash
# Reserve as user 1
curl -X POST http://localhost:5000/api/drops/1/reserve -H "Content-Type: application/json" -d '{"userId":1}'
```

```json
{
  "success": true,
  "data": {
    "id": 7,
    "userId": 1,
    "dropId": 1,
    "status": "ACTIVE",
    "expiresAt": "2026-08-29 09:01:00+00",
    "createdAt": "2026-08-29 09:00:00+00",
    "updatedAt": "2026-08-29 09:00:00+00"
  }
}
```

```bash
# Purchase before the reservation expires
curl -X POST http://localhost:5000/api/reservations/7/purchase -H "Content-Type: application/json" -d '{"userId":1}'
```

```json
{
  "success": true,
  "data": {
    "id": 3,
    "userId": 1,
    "dropId": 1,
    "reservationId": 7,
    "createdAt": "2026-08-29 09:00:20+00"
  }
}
```

Failure shape: `{ "success": false, "message": "Drop is out of stock" }` with the matching HTTP status.

> Timestamps are PostgreSQL `timestamptz` strings (e.g. `2026-08-29 09:01:00+00`); clients should normalize the space-separator format before parsing.

## Reservation Flow

`POST /api/drops/:dropId/reserve` — one transaction (`reservationService.reserveDrop`):

1. Parse + validate `userId`/`dropId` → `400` if not integers.
2. User exists? → `404` · Drop exists? → `404`.
3. Drop started? (`startsAt <= now()`) → otherwise `400 "Drop is not active yet"`.
4. Already an ACTIVE reservation for this (user, drop)? → `409`.
5. **Atomic stock decrement** — the serialization point (why this is safe: see [Concurrency Strategy](#concurrency-strategy-critical)):

   ```sql
   UPDATE "public"."drop"
   SET "availableStock" = "availableStock" - 1, "updatedAt" = now()
   WHERE "id" = $1 AND "availableStock" > 0;
   ```

   Zero rows affected → `409 "Drop is out of stock"`.

6. INSERT the `ACTIVE` reservation with `expiresAt = now() + 60s`. A concurrent duplicate insert from the same user is rejected by the partial unique index (SQLSTATE `23505`) → translated to `409`; the whole transaction rolls back, **returning the decrement**.
7. After commit: broadcast `stock_updated` with the fresh `availableStock` (best-effort — a client that misses it converges on its next fetch).

## Concurrency Strategy (critical)

**The problem:** 100 shoppers hit _Reserve_ on a drop with 1 unit left. Exactly one may win.

**Why `read stock → if stock > 0 → decrement` is unsafe:**

```text
T1: SELECT availableStock → 1            T2: SELECT availableStock → 1
T1: 1 > 0 → proceed                      T2: 1 > 0 → proceed
T1: UPDATE ... availableStock - 1        T2: UPDATE ... availableStock - 1
    → stock = 0                              → stock = -1      ❌ oversold
```

The check and the write are two separate steps, so two transactions can interleave between them and both pass the check — the classic **check-then-act / lost update** race. Wrapping it in a transaction does **not** fix this at PostgreSQL's default `READ COMMITTED` isolation: each statement sees the latest committed data, and neither transaction knows the other is consuming the same unit. Locking alternatives (`SELECT … FOR UPDATE`, `SERIALIZABLE`) work but add lock management and retry logic.

**This project's approach — make the check part of the atomic write:**

```sql
UPDATE "public"."drop"
SET "availableStock" = "availableStock" - 1
WHERE "id" = $1 AND "availableStock" > 0;
```

One statement = one atomic decision:

1. The first transaction to reach the row takes its **row lock** and decrements.
2. Competing transactions **block** on that lock.
3. When the winner commits, PostgreSQL **re-evaluates the loser's `WHERE` clause against the newly committed row** (`READ COMMITTED` update re-check). `availableStock` is now `0`, so `> 0` is false → **0 rows affected** → the service maps that to `409`.

The loser never gets to act on stale stock; the database rejects the decrement itself. The decrement is also _relative_ (`availableStock = availableStock - 1`), so no writer can clobber a concurrent change with a stale absolute value.

**Defense in depth** — every remaining race has a database backstop:

| Race                           | Guarantee                     | Mechanism                                                                                            |
| ------------------------------ | ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| N buyers, 1 unit               | exactly 1 wins                | conditional `UPDATE … WHERE availableStock > 0` (above)                                              |
| Stock never negative           | holds even against buggy code | CHECK `drop_stock_valid` (`availableStock >= 0 AND <= totalStock`)                                   |
| Same user double-reserves      | 1 ACTIVE max                  | partial UNIQUE `(userId, dropId) WHERE status='ACTIVE'` → `23505` → `409`                            |
| Reservation insert fails       | decrement rolled back         | stock write + insert share one transaction                                                           |
| Two purchases, one reservation | 1 purchase max                | conditional `UPDATE … WHERE status='ACTIVE' AND expiresAt > now()` + UNIQUE `purchase.reservationId` |
| Purchase vs expiration         | exactly one wins              | complementary predicates on the same row (see [Expiration Architecture](#expiration-architecture))   |

**Evidence:** `reservation.test.js` #10 and `stress.test.js` fire 50/100 concurrent reservations at a stock=1 drop through the real HTTP API — exactly 1 × `201`, the rest × `409`, final stock `0`; a same-user race test proves losing transactions roll their decrement back.

## Expiration Architecture

Reservations are valid for **60 seconds**, fixed at creation (`expiresAt = createdAt + 60s`).

A background worker runs inside the API process (`expirationService.js`): `setInterval(runExpiration, EXPIRATION_POLL_INTERVAL_MS)` (default `1000ms`). Per tick:

1. **Scan** (best-effort read): ACTIVE reservations with `expiresAt <= now()` become candidates. Correctness never depends on this scan — it only decides which reservations get _attempted_.
2. **Expire** each candidate via `expireReservation(id)` — one transaction:
   - Flip: `UPDATE reservation SET status='EXPIRED' WHERE id=$1 AND status='ACTIVE' AND expiresAt <= now()` — **the database clock is authoritative**; the timer is only an alarm clock.
   - Restore stock **only if the flip matched a row**, inside the same transaction: `availableStock = availableStock + 1 … AND availableStock < totalStock` → exactly-once restore.
   - After commit: emit `reservation_expired` + `stock_updated`.
3. **Idempotent by construction** — a second worker, a second API instance, or a retry cannot double-expire (its UPDATE matches 0 rows) and cannot double-restore (the restore is gated by the flip).

**Why frontend timers are not authoritative:** client clocks skew, browsers throttle timers in background tabs, and local state can be edited. The countdown shown in the UI is a _display_, sourced from this server's `expiresAt`; the client's reservation status flips to `EXPIRED` **only** on backend confirmation (the `reservation_expired` socket event, or a `410` from the purchase API). The purchase path independently re-validates `expiresAt > now()` in its own transaction, so a tampered or throttled client can never buy an expired reservation.

**Purchase vs expiration race:** both are single conditional UPDATEs on the same row with _complementary_ predicates — `status='ACTIVE' AND expiresAt > now()` (purchase) vs `status='ACTIVE' AND expiresAt <= now()` (expiration). The row lock serializes them; the loser re-evaluates against the winner's committed row and matches zero rows. A reservation therefore settles into exactly one terminal state:

- `PURCHASED` → unit stays consumed, exactly one purchase row exists, stock **not** restored; or
- `EXPIRED` → no purchase row, stock restored **exactly once**.

`expirationPurchaseRace.test.js` and the Phase 14 e2e race scenario assert these invariants across dozens of interleavings (both outcomes observed, bookkeeping `availableStock + held = totalStock` always holds, and a follow-up expiration run changes nothing).

## Purchase Flow

`POST /api/reservations/:reservationId/purchase` — one transaction (`reservationService.purchaseReservation`):

1. Validate ids → `400`. Reservation exists? → `404`. Belongs to the caller? → `403` otherwise.
2. **Conditional transition**:
   `UPDATE reservation SET status='PURCHASED' WHERE id=$1 AND status='ACTIVE' AND expiresAt > now()`
   — zero rows → diagnose the current row: `PURCHASED` → `409 "Reservation has already been purchased"`; `EXPIRED` or past `expiresAt` → `410 "Reservation has expired"`.
3. INSERT the `purchase` row (`userId`, `dropId`, `reservationId`). The UNIQUE `reservationId` backstops a racing duplicate (`23505` → `409`, transaction rolled back).
4. **`availableStock` is intentionally untouched** — it was consumed when the reservation was created; purchasing twice would double-decrement. Verified by `purchase.test.js` #6.
5. No `stock_updated` broadcast — purchase never changes stock.

## Real-Time Architecture

Server → client pushes over Socket.io, broadcast to **all** connected clients:

| Event                 | Payload                      | Emitted when                                                                                       |
| --------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `stock_updated`       | `{ dropId, availableStock }` | after a reservation commits (fresh value re-read post-commit) · after an expiration restores stock |
| `reservation_expired` | `{ reservationId, dropId }`  | after the worker's flip+restore transaction commits                                                |

- Business logic never lives inside a socket handler — sockets only carry state that the database has already committed.
- Broadcasts are **best-effort**: a client that misses an event converges on its next fetch — the socket accelerates the UI, but the database remains the single source of truth.
- Emission always happens strictly after `COMMIT`, never before — a rolled-back transaction never produces an event.

## Local Development

Prerequisites: **Node.js 20+** (developed on 24) and **PostgreSQL 15+** (developed against 18).

```bash
# 1 — Database (once): create an empty database
createdb sneaker_drop

# 2 — API server (port 5000)
cd server
cp .env.example .env            # then set DATABASE_URL (see Environment Variables)
npm install
npx prisma db init              # create tables from the data contract + sign the DB
npm run seed                    # users: rahim, karim, john, hasan, david
                                 # drops: Air Jordan 1 (stock 5, active) · Nike Dunk Low (stock 10, future)
npm run dev                     # REST + Socket.io on http://localhost:5000
```

Useful checks: `npx prisma migration status` · `npx prisma db verify` (live DB vs contract) · `curl http://localhost:5000/api/health`.

## Environment Variables

`.env` is machine-local and git-ignored — **only** `.env.example` (placeholder values, no credentials) is committed. Never expose real credentials in the repo or in this document.

| Variable                      | Required | Default                 | Purpose                                                                             |
| ----------------------------- | -------- | ----------------------- | ----------------------------------------------------------------------------------- |
| `DATABASE_URL`                | ✅       | —                       | PostgreSQL connection string, e.g. `postgresql://user:password@localhost:5432/mydb` |
| `PORT`                        | —        | `5000`                  | HTTP + Socket.io port                                                               |
| `CLIENT_URL`                  | —        | `http://localhost:5173` | Allowed origin for the Socket.io CORS handshake                                     |
| `EXPIRATION_POLL_INTERVAL_MS` | —        | `1000`                  | Worker poll interval (the 60s reservation TTL is fixed in code)                     |
| `NODE_ENV`                    | —        | `development`           | —                                                                                   |

## Testing

```bash
npm test        # node:test via tsx — 7 suites / 42 tests, against a real PostgreSQL
```

- Requires the `DATABASE_URL` database from `.env` — each run creates its own users/drops with unique names (no seed required).
- Test files run **sequentially** (`--test-concurrency=1`): suites share one database, and some suites run global expiration passes — parallel files would interfere with each other's fixtures.
- **The concurrency test** (`reservation.test.js` #10, `stress.test.js`): creates a stock=1 drop, then fires 50/100 reservation requests through the real HTTP API simultaneously. Asserts exactly 1 × `201`, the rest × `409`, final `availableStock = 0`, exactly one ACTIVE reservation — and (same-user variant) that losing transactions roll their stock decrement back.
- **The race tests** (`expirationPurchaseRace.test.js`, `phase14.e2e.test.js` Scenario 7): fire concurrent purchases and expirations against reservations whose expiry lands mid-burst, asserting that every interleaving settles into one valid outcome with all inventory invariants intact.
- The **Phase 14 e2e** suite boots the real server (Express + Socket.io + worker) on an ephemeral port with two socket clients standing in for two browsers; Scenario 5 waits out a _real_ 60-second TTL, so a full run takes ~80 seconds. If a dev server runs concurrently it shares the database — the assertions are written to be actor-agnostic.

**Verification snapshot (Phase 14):** 42/42 tests (3 consecutive full runs) · `prisma db verify` → "Database marker and schema match contract".

## Deployment

> **Status: not deployed.** This section documents the intended topology and the decisions it requires; any claim of a working deployment would be false until a live URL exists.

**Target topology**

| Piece           | Host                                               | Notes                                                                                                         |
| --------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Database        | Neon PostgreSQL                                    | Use Neon's **pooled** connection string as `DATABASE_URL` (serverless apps open many short-lived connections) |
| API + Socket.io | Long-running Node host (Railway / Render / Fly.io) | Required — see the serverless considerations below                                                            |

**Provision the database (one-time):** point `DATABASE_URL` at Neon → `npx prisma db init` (or `npx prisma db migrate`) → `npx prisma db verify` → optionally `npm run seed`.

**Expiration worker & serverless considerations:**

- This API is a **long-running process**: `server.js` boots an HTTP server, a Socket.io gateway, and a `setInterval` expiration worker. On Vercel **serverless functions** the interval would not survive between invocations, and **Socket.io needs persistent WebSocket connections that serverless functions do not support** — hosting the API there as-is would silently break realtime sync and stock restoration.
- Options, in order of preference:
  1. **Keep the API on a long-running host** (zero code changes): worker and WebSockets behave exactly as locally; works with Neon from any host.
  2. **Split roles**: stateless REST on serverless + a separate always-on worker/realtime service sharing the same `DATABASE_URL`.
  3. **Cron-driven expiration** (e.g. Vercel Cron invoking a protected `/internal/expire` endpoint that calls `runExpiration()`): workable, but that endpoint **does not exist yet** and would need to be added; the cron frequency trades freshness against invocations.
- **Correctness never depends on the worker**: the purchase transaction re-checks `status='ACTIVE' AND expiresAt > now()` on the database row, so expired reservations can never be purchased even with the worker down. What degrades is only _stock-restoration latency_ — inventory stays conservative, never oversold.
- **Secrets & scale-out**: set `DATABASE_URL`, `CLIENT_URL` and `PORT` in the host's environment settings — never in the repo. Running multiple API instances is already safe: expiration is idempotent and stock mutations serialize on row locks.
