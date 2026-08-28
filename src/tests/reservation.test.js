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

describe('Phase 4: Reservation API & Concurrency Tests', () => {
  let testUser1, testUser2, activeDrop, futureDrop, outOfStockDrop;

  before(async () => {
    // Seed users
    const timestamp = Date.now();
    testUser1 = await db.orm.public.User.create({ username: `user_p4_1_${timestamp}` });
    testUser2 = await db.orm.public.User.create({ username: `user_p4_2_${timestamp}` });

    // Seed drops
    activeDrop = await db.orm.public.Drop.create({
      name: `Active Drop ${timestamp}`,
      price: 100,
      totalStock: 5,
      availableStock: 5,
      startsAt: new Date(Date.now() - 10000).toISOString()
    });

    futureDrop = await db.orm.public.Drop.create({
      name: `Future Drop ${timestamp}`,
      price: 150,
      totalStock: 10,
      availableStock: 10,
      startsAt: new Date(Date.now() + 3600000).toISOString()
    });

    outOfStockDrop = await db.orm.public.Drop.create({
      name: `Out of Stock Drop ${timestamp}`,
      price: 120,
      totalStock: 5,
      availableStock: 0,
      startsAt: new Date(Date.now() - 10000).toISOString()
    });
  });

  it('1. Successful reservation', async () => {
    const res = await request(`/api/drops/${activeDrop.id}/reserve`, {
      method: 'POST',
      body: JSON.stringify({ userId: testUser1.id })
    });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.data.userId, testUser1.id);
    assert.strictEqual(res.body.data.dropId, activeDrop.id);
  });

  it('2. Stock decreases by exactly 1', async () => {
    const updatedDrop = await db.orm.public.Drop.where({ id: activeDrop.id }).first();
    assert.strictEqual(updatedDrop.availableStock, 4);
  });

  it('3. Reservation is ACTIVE', async () => {
    const reservations = await db.orm.public.Reservation.where({
      userId: testUser1.id,
      dropId: activeDrop.id
    }).all();

    assert.strictEqual(reservations.length, 1);
    assert.strictEqual(reservations[0].status, 'ACTIVE');
  });

  it('4. Expiration is approximately 60 seconds in the future', async () => {
    const reservations = await db.orm.public.Reservation.where({
      userId: testUser1.id,
      dropId: activeDrop.id
    }).all();

    const expiresAt = new Date(reservations[0].expiresAt).getTime();
    const createdAt = new Date(reservations[0].createdAt).getTime();
    const diffSeconds = Math.round((expiresAt - createdAt) / 1000);

    assert.ok(diffSeconds >= 59 && diffSeconds <= 61, `Expected ~60s diff, got ${diffSeconds}s`);
  });

  it('5. Out-of-stock returns conflict (409)', async () => {
    const res = await request(`/api/drops/${outOfStockDrop.id}/reserve`, {
      method: 'POST',
      body: JSON.stringify({ userId: testUser2.id })
    });

    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.message, 'Drop is out of stock');
  });

  it('6. Invalid user fails (404)', async () => {
    const res = await request(`/api/drops/${activeDrop.id}/reserve`, {
      method: 'POST',
      body: JSON.stringify({ userId: 999999 })
    });

    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.success, false);
  });

  it('7. Invalid drop fails (404)', async () => {
    const res = await request('/api/drops/999999/reserve', {
      method: 'POST',
      body: JSON.stringify({ userId: testUser2.id })
    });

    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.success, false);
  });

  it('8. TRANSACTION ROLLBACK: failed reservation insert restores stock', async () => {
    const timestamp = Date.now();
    const rollbackUser = await db.orm.public.User.create({ username: `rollback_user_${timestamp}` });
    const rollbackDrop = await db.orm.public.Drop.create({
      name: `Rollback Drop ${timestamp}`,
      price: 90,
      totalStock: 1,
      availableStock: 1,
      startsAt: new Date(Date.now() - 10000).toISOString()
    });

    // Pre-existing ACTIVE reservation for this user+drop (created directly, so the
    // partial unique index (userId, dropId) WHERE status='ACTIVE' will reject any
    // second insert). Stock is untouched, so the mirror transaction below starts at 1.
    await db.orm.public.Reservation.create({
      userId: rollbackUser.id,
      dropId: rollbackDrop.id,
      status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 60000).toISOString()
    });

    let insertError = null;
    try {
      // Mirror the service's exact transaction structure:
      //   BEGIN -> atomic stock decrement -> create ACTIVE reservation -> COMMIT
      // The reservation insert is forced to fail (unique index), so the whole
      // transaction — including the already-applied stock decrement — must roll back.
      await db.transaction(async (tx) => {
        const stockPlan = db.raw.sql`
          UPDATE "public"."drop"
          SET "availableStock" = "availableStock" - 1, "updatedAt" = now()
          WHERE "id" = ${rollbackDrop.id} AND "availableStock" > 0
        `.affectedCount().build();

        const stockResult = await tx.execute(stockPlan);
        assert.strictEqual(stockResult.affectedRows, 1, 'decrement must affect exactly 1 row');

        // This INSERT violates unique_active_reservation_per_user_drop...
        await tx.orm.public.Reservation.create({
          userId: rollbackUser.id,
          dropId: rollbackDrop.id,
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + 60000).toISOString()
        });
      });
    } catch (err) {
      insertError = err;
    }

    assert.ok(insertError, 'second ACTIVE reservation insert must fail');
    assert.strictEqual(insertError.sqlState, '23505');

    // ROLLBACK VERIFIED: the stock decrement must have been undone
    const rollbackDropAfter = await db.orm.public.Drop.where({ id: rollbackDrop.id }).first();
    assert.strictEqual(rollbackDropAfter.availableStock, 1, 'availableStock must be restored after ROLLBACK');

    // And only the original reservation exists
    const reservationsAfter = await db.orm.public.Reservation.where({
      userId: rollbackUser.id,
      dropId: rollbackDrop.id
    }).all();
    assert.strictEqual(reservationsAfter.length, 1);
  });

  it('9. Future drop reservation fails (400)', async () => {
    const res = await request(`/api/drops/${futureDrop.id}/reserve`, {
      method: 'POST',
      body: JSON.stringify({ userId: testUser2.id })
    });

    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
    assert.strictEqual(res.body.message, 'Drop is not active yet');
  });

  it('10. CONCURRENCY TEST: 100 concurrent reservation requests for a drop with stock = 1', async () => {
    const timestamp = Date.now();
    // Create drop with stock = 1
    const limitedDrop = await db.orm.public.Drop.create({
      name: `Limited Drop ${timestamp}`,
      price: 300,
      totalStock: 1,
      availableStock: 1,
      startsAt: new Date(Date.now() - 10000).toISOString()
    });

    // Create 100 users
    const userPromises = [];
    for (let i = 0; i < 100; i++) {
      userPromises.push(db.orm.public.User.create({ username: `concurrent_user_${timestamp}_${i}` }));
    }
    const users = await Promise.all(userPromises);

    // Fire 100 requests concurrently
    const reqPromises = users.map((u) =>
      request(`/api/drops/${limitedDrop.id}/reserve`, {
        method: 'POST',
        body: JSON.stringify({ userId: u.id })
      })
    );

    const results = await Promise.all(reqPromises);

    const successCount = results.filter((r) => r.status === 201).length;
    const conflictCount = results.filter((r) => r.status === 409).length;

    assert.strictEqual(successCount, 1, `Expected exactly 1 successful reservation, got ${successCount}`);
    assert.strictEqual(conflictCount, 99, `Expected 99 failed/conflict reservations, got ${conflictCount}`);

    // Verify database state: availableStock MUST be 0
    const finalDropState = await db.orm.public.Drop.where({ id: limitedDrop.id }).first();
    assert.strictEqual(finalDropState.availableStock, 0, `Expected final stock = 0, got ${finalDropState.availableStock}`);

    // Verify reservations count: exactly 1 ACTIVE reservation created
    const activeReservations = await db.orm.public.Reservation.where({
      dropId: limitedDrop.id,
      status: 'ACTIVE'
    }).all();
    assert.strictEqual(activeReservations.length, 1, `Expected exactly 1 ACTIVE reservation in DB, got ${activeReservations.length}`);
  });

  it('11. CONCURRENCY: same user races for the same drop — DB unique index + rollback', async () => {
    const timestamp = Date.now();
    const raceUser = await db.orm.public.User.create({ username: `race_user_${timestamp}` });
    const raceDrop = await db.orm.public.Drop.create({
      name: `Race Drop ${timestamp}`,
      price: 250,
      totalStock: 2,
      availableStock: 2,
      startsAt: new Date(Date.now() - 10000).toISOString()
    });

    // Fire many concurrent reservations from the SAME user (stock = 2 is a red
    // herring: the per-user partial unique index is what decides the winner).
    const reqPromises = [];
    for (let i = 0; i < 20; i++) {
      reqPromises.push(
        request(`/api/drops/${raceDrop.id}/reserve`, {
          method: 'POST',
          body: JSON.stringify({ userId: raceUser.id })
        })
      );
    }
    const results = await Promise.all(reqPromises);

    const successCount = results.filter((r) => r.status === 201).length;
    const conflictCount = results.filter((r) => r.status === 409).length;

    // The partial unique ACTIVE index guarantees at most one can win...
    assert.strictEqual(successCount, 1, `Expected exactly 1 successful reservation, got ${successCount}`);
    assert.strictEqual(conflictCount, 19, `Expected 19 conflicts, got ${conflictCount}`);

    // ...and every losing transaction must have rolled its stock decrement back,
    // so only ONE unit was permanently consumed (2 -> 1).
    const raceDropAfter = await db.orm.public.Drop.where({ id: raceDrop.id }).first();
    assert.strictEqual(raceDropAfter.availableStock, 1, 'stock must drop by exactly 1 (losers rolled back)');

    const activeRaces = await db.orm.public.Reservation.where({
      userId: raceUser.id,
      dropId: raceDrop.id,
      status: 'ACTIVE'
    }).all();
    assert.strictEqual(activeRaces.length, 1, 'exactly one ACTIVE reservation must exist');
  });
});
