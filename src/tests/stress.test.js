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
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, body: data };
}

describe('Phase 5: Reservation Stress Tests', () => {
  it('50 concurrent requests on stock=1 -> exactly 1 success, 49 failed', async () => {
    const timestamp = Date.now();

    // 1) Create drop with totalStock=1, availableStock=1
    const drop = await db.orm.public.Drop.create({
      name: `Stress Drop (50) ${timestamp}`,
      price: 99.99,
      totalStock: 1,
      availableStock: 1,
      startsAt: new Date(Date.now() - 10000).toISOString()
    });

    // 2) Create 50 users
    const userPromises = [];
    for (let i = 0; i < 50; i++) {
      userPromises.push(
        db.orm.public.User.create({ username: `stress50_user_${timestamp}_${i}` })
      );
    }
    const users = await Promise.all(userPromises);

    // 3) Fire 50 reservation requests concurrently
    const reqPromises = users.map((u) =>
      request(`/api/drops/${drop.id}/reserve`, {
        method: 'POST',
        body: JSON.stringify({ userId: u.id })
      })
    );

    const results = await Promise.all(reqPromises);

    // Assertions
    const successCount = results.filter((r) => r.status === 201).length;
    const failureCount = results.filter((r) => r.status !== 201).length;

    assert.strictEqual(successCount, 1, `Expected exactly 1 success, got ${successCount}`);
    assert.strictEqual(failureCount, 49, `Expected exactly 49 failures, got ${failureCount}`);

    const finalDrop = await db.orm.public.Drop.where({ id: drop.id }).first();
    assert.strictEqual(finalDrop.availableStock, 0, `Expected availableStock=0, got ${finalDrop.availableStock}`);
    assert.ok(finalDrop.availableStock >= 0, `availableStock must never be negative`);

    const activeReservations = await db.orm.public.Reservation.where({
      dropId: drop.id,
      status: 'ACTIVE'
    }).all();
    assert.strictEqual(activeReservations.length, 1, `Expected ACTIVE reservations=1, got ${activeReservations.length}`);

    // Sanity: successful reservations can never exceed originally available stock
    assert.ok(successCount <= 1, 'successful reservations must not exceed initial stock');
  });

  it('100 concurrent requests on stock=1 -> exactly 1 success, 99 conflicts', async () => {
    const timestamp = Date.now();

    // 1) Create drop with totalStock=1, availableStock=1
    const drop = await db.orm.public.Drop.create({
      name: `Stress Drop (100) ${timestamp}`,
      price: 199.99,
      totalStock: 1,
      availableStock: 1,
      startsAt: new Date(Date.now() - 10000).toISOString()
    });

    // 2) Create 100 users
    const userPromises = [];
    for (let i = 0; i < 100; i++) {
      userPromises.push(
        db.orm.public.User.create({ username: `stress100_user_${timestamp}_${i}` })
      );
    }
    const users = await Promise.all(userPromises);

    // 3) Fire 100 reservation requests concurrently
    const reqPromises = users.map((u) =>
      request(`/api/drops/${drop.id}/reserve`, {
        method: 'POST',
        body: JSON.stringify({ userId: u.id })
      })
    );

    const results = await Promise.all(reqPromises);

    // Assertions
    const successCount = results.filter((r) => r.status === 201).length;
    const conflictCount = results.filter((r) => r.status === 409).length;
    const otherFailureCount = results.filter((r) => r.status !== 201 && r.status !== 409).length;

    assert.strictEqual(successCount, 1, `Expected exactly 1 success, got ${successCount}`);
    assert.strictEqual(conflictCount, 99, `Expected 99 conflicts, got ${conflictCount}`);
    assert.strictEqual(otherFailureCount, 0, `Expected 0 non-conflict failures, got ${otherFailureCount}`);

    const finalDrop = await db.orm.public.Drop.where({ id: drop.id }).first();
    assert.strictEqual(finalDrop.availableStock, 0, `Expected availableStock=0, got ${finalDrop.availableStock}`);

    const activeReservations = await db.orm.public.Reservation.where({
      dropId: drop.id,
      status: 'ACTIVE'
    }).all();
    assert.strictEqual(activeReservations.length, 1, `Expected ACTIVE reservations=1, got ${activeReservations.length}`);
  });
});
