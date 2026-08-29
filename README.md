# SneakerDropServer

Node.js + Express 5 + Socket.io API for the Limited Edition Sneaker Drop assessment, using a contract-driven Prisma ORM against PostgreSQL.

- REST: drop creation/listing, 60-second reservations, purchases
- Realtime: `stock_updated` / `reservation_expired` broadcasts
- Background expiration worker (DB clock is the source of truth)
- `node:test` suites incl. concurrency stress, race proofs, and a full e2e boot (`npm test`)

👉 **Full assessment documentation:** see the [root README](../README.md) (architecture, concurrency strategy, schema, API reference, setup).

