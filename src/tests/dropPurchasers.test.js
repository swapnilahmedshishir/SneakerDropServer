import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import app from '../app.js';
import { db } from '../prisma/db.ts';

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, resolve);
  });
  const port = server.address().port;
  baseUrl = `http://localhost:${port}`;
});

after(async () => {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
  await db.close();
});

async function request(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const unique = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

async function makeDrop(name, stock = 10) {
  return db.orm.public.Drop.create({
    name,
    price: 100,
    totalStock: stock,
    availableStock: stock,
    startsAt: new Date(Date.now() - 10000).toISOString()
  });
}

async function makeUser(username) {
  return db.orm.public.User.create({ username: unique(username) });
}

// Directly create a PURCHASED reservation + purchase row, mirroring what the
// purchase API persists. expiresAt stays in the future so a concurrently
// running dev expiration worker cannot flip the reservation's status mid-test.
async function purchaseDrop(drop, user) {
  const reservation = await db.orm.public.Reservation.create({
    userId: user.id,
    dropId: drop.id,
    status: 'ACTIVE',
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  return db.orm.public.Purchase.create({
    userId: user.id,
    dropId: drop.id,
    reservationId: reservation.id
  });
}

describe('Phase 12: per-drop recent purchasers on GET /api/drops/active', () => {
  it('returns the latest 3 purchasers per drop, newest first, without global leakage', async () => {
    const dropA = await makeDrop(unique('Drop P12 A'));
    const dropB = await makeDrop(unique('Drop P12 B'));

    const buyersA = [];
    for (let i = 0; i < 5; i++) {
      buyersA.push(await makeUser(`p12buyera${i}`));
    }
    const buyerB = await makeUser('p12buyerb');

    // Five purchases on drop A (sequential => deterministic createdAt order),
    // one on drop B.
    for (const buyer of buyersA) {
      await purchaseDrop(dropA, buyer);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    await purchaseDrop(dropB, buyerB);

    const res = await request('/api/drops/active');
    assert.strictEqual(res.status, 200);

    const dropAData = res.body.data.find((d) => d.id === dropA.id);
    const dropBData = res.body.data.find((d) => d.id === dropB.id);
    assert.ok(dropAData, 'drop A must be present in active drops');
    assert.ok(dropBData, 'drop B must be present in active drops');

    // Drop A: exactly the 3 newest of its 5 purchases, createdAt DESC.
    assert.strictEqual(dropAData.recentPurchasers.length, 3);
    const expectedA = buyersA.slice(2).reverse().map((u) => u.username);
    assert.deepStrictEqual(
      dropAData.recentPurchasers.map((p) => p.username),
      expectedA
    );

    // Response shape: [{ username }, ...]
    for (const purchaser of dropAData.recentPurchasers) {
      assert.deepStrictEqual(Object.keys(purchaser).sort(), ['username']);
      assert.strictEqual(typeof purchaser.username, 'string');
    }

    // CRITICAL: drop B must see ONLY its own purchaser — never drop A's.
    assert.deepStrictEqual(
      dropBData.recentPurchasers.map((p) => p.username),
      [buyerB.username]
    );
  });

  it('returns an empty recentPurchasers list for a drop with no purchases', async () => {
    const drop = await makeDrop(unique('Drop P12 empty'));

    const res = await request('/api/drops/active');
    assert.strictEqual(res.status, 200);

    const target = res.body.data.find((d) => d.id === drop.id);
    assert.ok(target, 'fresh drop must be present in active drops');
    assert.deepStrictEqual(target.recentPurchasers, []);
  });
});