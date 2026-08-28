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

async function purchase(reservationId, userId) {
  return request(`/api/reservations/${reservationId}/purchase`, {
    method: 'POST',
    body: JSON.stringify({ userId })
  });
}

async function countPurchases(reservationId) {
  const rows = await db.orm.public.Purchase.where({ reservationId }).all();
  return rows.length;
}

describe('Phase 6: Purchase API & Concurrency Tests', () => {
  let user;
  let otherUser;

  async function makeDrop(availableStock = 5) {
    return db.orm.public.Drop.create({
      name: `Drop P6 ${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      price: 200,
      totalStock: availableStock,
      availableStock,
      startsAt: new Date(Date.now() - 10000).toISOString()
    });
  }

  // Reserve through the real Phase 4 API so fixtures exercise the full flow.
  async function reserveViaApi(u, dropId) {
    const res = await request(`/api/drops/${dropId}/reserve`, {
      method: 'POST',
      body: JSON.stringify({ userId: u.id })
    });
    assert.strictEqual(res.status, 201, `reserve failed: ${JSON.stringify(res.body)}`);
    return res.body.data;
  }

  before(async () => {
    const timestamp = Date.now();
    user = await db.orm.public.User.create({ username: `user_p6_a_${timestamp}` });
    otherUser = await db.orm.public.User.create({ username: `user_p6_b_${timestamp}` });
  });

  it('1. Valid purchase: reservation -> PURCHASED, purchase row created', async () => {
    const drop = await makeDrop();
    const reservation = await reserveViaApi(user, drop.id);

    const res = await purchase(reservation.id, user.id);

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.data.userId, user.id);
    assert.strictEqual(res.body.data.dropId, drop.id);
    assert.strictEqual(res.body.data.reservationId, reservation.id);

    // reservation.status must be PURCHASED
    const updated = await db.orm.public.Reservation.where({ id: reservation.id }).first();
    assert.strictEqual(updated.status, 'PURCHASED');

    assert.strictEqual(await countPurchases(reservation.id), 1);
  });

  it('2. Invalid reservation returns 404', async () => {
    const res = await purchase(999999, user.id);
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.message, 'Reservation not found');
  });

  it('3. Expired reservation (past expiresAt) returns 410 and creates no purchase', async () => {
    const drop = await makeDrop();
    const reservation = await db.orm.public.Reservation.create({
      userId: user.id,
      dropId: drop.id,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() - 60000).toISOString()
    });

    const res = await purchase(reservation.id, user.id);
    assert.strictEqual(res.status, 410);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.message, 'Reservation has expired');

    // Failure rolled back: status untouched, no purchase row
    const after = await db.orm.public.Reservation.where({ id: reservation.id }).first();
    assert.strictEqual(after.status, 'ACTIVE');
    assert.strictEqual(await countPurchases(reservation.id), 0);
  });

  it('4. Already-purchased reservation returns 409', async () => {
    const drop = await makeDrop();
    const reservation = await reserveViaApi(user, drop.id);

    const first = await purchase(reservation.id, user.id);
    assert.strictEqual(first.status, 201);

    const second = await purchase(reservation.id, user.id);
    assert.strictEqual(second.status, 409);
    assert.strictEqual(second.body.message, 'Reservation has already been purchased');

    // Exactly one purchase must exist for this reservation
    assert.strictEqual(await countPurchases(reservation.id), 1);
  });

  it('5. CONCURRENCY: duplicate purchase requests create exactly one purchase', async () => {
    const drop = await makeDrop();
    const reservation = await reserveViaApi(user, drop.id);

    const requests = [];
    for (let i = 0; i < 25; i++) {
      requests.push(purchase(reservation.id, user.id));
    }
    const results = await Promise.all(requests);

    const created = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);

    assert.strictEqual(
      created.length,
      1,
      `expected exactly 1 successful purchase, got ${created.length}: ${JSON.stringify(results.map((r) => r.status))}`
    );
    assert.strictEqual(
      conflicts.length,
      24,
      `expected 24 conflicting purchases, got ${conflicts.length}: ${JSON.stringify(results.map((r) => r.status))}`
    );

    // The unique constraint on purchase.reservationId guarantees this.
    assert.strictEqual(await countPurchases(reservation.id), 1);

    const reservationAfter = await db.orm.public.Reservation.where({ id: reservation.id }).first();
    assert.strictEqual(reservationAfter.status, 'PURCHASED');
  });

  it('6. availableStock is unchanged by purchase (no double decrement)', async () => {
    const drop = await makeDrop(3);
    const reservation = await reserveViaApi(user, drop.id);

    // Reservation consumed exactly one unit
    const afterReserve = await db.orm.public.Drop.where({ id: drop.id }).first();
    assert.strictEqual(afterReserve.availableStock, 2);

    const res = await purchase(reservation.id, user.id);
    assert.strictEqual(res.status, 201);

    // Purchase MUST NOT touch stock again
    const afterPurchase = await db.orm.public.Drop.where({ id: drop.id }).first();
    assert.strictEqual(afterPurchase.availableStock, 2, 'purchase must not decrement availableStock');
    assert.strictEqual(afterPurchase.totalStock, 3);
  });

  it('7. Purchase record correctly references user/drop/reservation', async () => {
    const drop = await makeDrop();
    const reservation = await reserveViaApi(user, drop.id);

    const res = await purchase(reservation.id, user.id);
    assert.strictEqual(res.status, 201);

    const purchases = await db.orm.public.Purchase.where({ reservationId: reservation.id }).all();
    assert.strictEqual(purchases.length, 1);

    const p = purchases[0];
    assert.strictEqual(p.userId, user.id);
    assert.strictEqual(p.userId, reservation.userId);
    assert.strictEqual(p.dropId, drop.id);
    assert.strictEqual(p.dropId, reservation.dropId);
    assert.strictEqual(p.reservationId, reservation.id);
    assert.ok(p.createdAt, 'purchase must carry a createdAt timestamp');
  });

  it('8. A user cannot purchase another user\'s reservation (403)', async () => {
    const drop = await makeDrop();
    const reservation = await reserveViaApi(user, drop.id);

    const res = await purchase(reservation.id, otherUser.id);
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.message, 'Reservation does not belong to this user');

    // Nothing was changed on the failed attempt
    const after = await db.orm.public.Reservation.where({ id: reservation.id }).first();
    assert.strictEqual(after.status, 'ACTIVE');
    assert.strictEqual(await countPurchases(reservation.id), 0);
  });

  it('9. Purchase without a valid userId returns 400', async () => {
    const drop = await makeDrop();
    const reservation = await reserveViaApi(user, drop.id);

    const res = await request(`/api/reservations/${reservation.id}/purchase`, {
      method: 'POST',
      body: JSON.stringify({})
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);

    // Still reserved — untouched
    const after = await db.orm.public.Reservation.where({ id: reservation.id }).first();
    assert.strictEqual(after.status, 'ACTIVE');
    assert.strictEqual(await countPurchases(reservation.id), 0);
  });

  it('10. Expired-by-status reservation also returns 410', async () => {
    const drop = await makeDrop();
    const reservation = await db.orm.public.Reservation.create({
      userId: user.id,
      dropId: drop.id,
      status: 'EXPIRED',
      expiresAt: new Date(Date.now() + 60000).toISOString()
    });

    const res = await purchase(reservation.id, user.id);
    assert.strictEqual(res.status, 410);
    assert.strictEqual(res.body.message, 'Reservation has expired');
    assert.strictEqual(await countPurchases(reservation.id), 0);
  });
});