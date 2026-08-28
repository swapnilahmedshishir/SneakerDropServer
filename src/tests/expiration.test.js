import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import app from '../app.js';
import { db } from '../prisma/db.ts';
import { runExpiration, startExpirationWorker, stopExpirationWorker } from '../services/expirationService.js';

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, resolve);
  });
  baseUrl = `http://localhost:${server.address().port}`;
});

after(async () => {
  stopExpirationWorker();
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

async function reserve(userId, dropId) {
  const res = await request(`/api/drops/${dropId}/reserve`, {
    method: 'POST',
    body: JSON.stringify({ userId })
  });
  assert.strictEqual(res.status, 201, `reserve failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
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

async function getReservation(id) {
  return db.orm.public.Reservation.where({ id }).first();
}

async function getDrop(id) {
  return db.orm.public.Drop.where({ id }).first();
}

async function makeDrop(availableStock = 5, totalStock) {
  return db.orm.public.Drop.create({
    name: `Drop P7 ${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    price: 200,
    totalStock: totalStock ?? availableStock,
    availableStock,
    startsAt: new Date(Date.now() - 10000).toISOString()
  });
}

// Reserve through the real Phase 4 API, then age the reservation so it is due.
async function reserveAndAge(user, drop, expiresAt) {
  const reservation = await reserve(user.id, drop.id);
  await db.orm.public.Reservation.where({ id: reservation.id }).update({
    expiresAt: expiresAt.toISOString()
  });
  return reservation;
}

// Polls until `cond` resolves truthy or the timeout elapses.
async function waitFor(cond, timeoutMs = 3000, stepMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return Boolean(await cond());
}

describe('Phase 7: Reservation Expiration', () => {
  let user;
  let user2;
  let user3;

  before(async () => {
    // 1. Flush any leftover expired reservations so they don't spoil `count` assertions
    await runExpiration();

    const timestamp = Date.now();
    user = await db.orm.public.User.create({ username: `user_p7_1_${timestamp}` });
    user2 = await db.orm.public.User.create({ username: `user_p7_2_${timestamp}` });
    user3 = await db.orm.public.User.create({ username: `user_p7_3_${timestamp}` });
  });

  it('1. ACTIVE reservation expires: status -> EXPIRED and stock increases by exactly 1', async () => {
    const drop = await makeDrop(3);
    const reservation = await reserveAndAge(
      user,
      drop,
      new Date(Date.now() - 60000)
    );

    assert.strictEqual((await getReservation(reservation.id)).status, 'ACTIVE');
    assert.strictEqual((await getDrop(drop.id)).availableStock, 2);

    const count = await runExpiration();
    assert.strictEqual(count, 1, 'one reservation must be expired by this run');

    const after = await getReservation(reservation.id);
    assert.strictEqual(after.status, 'EXPIRED');

    const dropAfter = await getDrop(drop.id);
    assert.strictEqual(dropAfter.availableStock, 3);
    assert.strictEqual(dropAfter.totalStock, 3);
  });

  it('2. Not-yet-expired reservations are NOT expired or restored', async () => {
    const drop = await makeDrop(3);
    const reservation = await reserve(user.id, drop.id);

    await runExpiration();

    const after = await getReservation(reservation.id);
    assert.strictEqual(after.status, 'ACTIVE');
    assert.strictEqual((await getDrop(drop.id)).availableStock, 2, 'stock must stay decremented');
  });

  it('3. Expired reservation cannot be purchased (410) and no purchase row is created', async () => {
    const drop = await makeDrop(3);
    const reservation = await reserveAndAge(user, drop, new Date(Date.now() - 60000));

    await runExpiration();
    assert.strictEqual((await getReservation(reservation.id)).status, 'EXPIRED');

    const res = await purchase(reservation.id, user.id);
    assert.strictEqual(res.status, 410);
    assert.strictEqual(res.body.message, 'Reservation has expired');

    assert.strictEqual(await countPurchases(reservation.id), 0);
    assert.strictEqual((await getDrop(drop.id)).availableStock, 3);
  });

  it('4. Expiration is idempotent: subsequent runs restore stock exactly once', async () => {
    const drop = await makeDrop(3);
    const reservation = await reserveAndAge(user, drop, new Date(Date.now() - 60000));

    const first = await runExpiration();
    assert.strictEqual(first, 1);
    assert.strictEqual((await getDrop(drop.id)).availableStock, 3);

    for (let i = 0; i < 6; i++) {
      const count = await runExpiration();
      assert.strictEqual(count, 0, 'idempotent: no re-expiration allowed');
    }

    const after = await getReservation(reservation.id);
    assert.strictEqual(after.status, 'EXPIRED');
    assert.strictEqual((await getDrop(drop.id)).availableStock, 3, 'stock must not be double-restored');
  });

  it('5. Multiple concurrent expiration attempts on same reservation restore stock exactly once', async () => {
    const drop = await makeDrop(3);
    const reservation = await reserveAndAge(user, drop, new Date(Date.now() - 60000));

    const promises = Array.from({ length: 20 }, () => runExpiration());
    const results = await Promise.all(promises);

    const successes = results.filter((r) => r === 1).length;
    assert.strictEqual(successes, 1, 'exactly one expiration must succeed');

    const dropAfter = await getDrop(drop.id);
    assert.strictEqual(dropAfter.availableStock, 3, 'stock must be restored exactly once');

    const after = await getReservation(reservation.id);
    assert.strictEqual(after.status, 'EXPIRED');
  });

  it('6. Purchase near expiration does not create inconsistent state (purchase fails on expired)', async () => {
    const drop = await makeDrop(3);
    const reservation = await reserveAndAge(user, drop, new Date(Date.now() - 60000));

    const res = await purchase(reservation.id, user.id);
    assert.strictEqual(res.status, 410);

    await runExpiration();
    const after = await getReservation(reservation.id);
    assert.strictEqual(after.status, 'EXPIRED');
    assert.strictEqual((await getDrop(drop.id)).availableStock, 3);
    assert.strictEqual(await countPurchases(reservation.id), 0);
  });

  it('7. Purchase of still-valid reservation succeeds and prevents later expiration', async () => {
    const drop = await makeDrop(3);
    const reservation = await reserve(user.id, drop.id);

    const res = await purchase(reservation.id, user.id);
    assert.strictEqual(res.status, 201);

    assert.strictEqual((await getDrop(drop.id)).availableStock, 2);

    const count = await runExpiration();
    assert.strictEqual(count, 0, 'purchased reservation must not be expired');

    const after = await getReservation(reservation.id);
    assert.strictEqual(after.status, 'PURCHASED');
    assert.strictEqual((await getDrop(drop.id)).availableStock, 2);
  });
});