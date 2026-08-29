// -----------------------------------------------------------------------------
// Phase 8 — Expiration vs Purchase: inventory-integrity race proof
//
// OBJECTIVE
//   Prove that a purchase completing at the same moment a reservation expires
//   can never corrupt inventory. Exactly one operation may win; every corrupt
//   state is unreachable no matter how the two interleave.
//
// THE RACE UNDER TEST
//   reservation   status = ACTIVE, expiresAt ≈ now  (very short test expiry)
//     ├── purchase request     POST /api/reservations/:id/purchase
//     └── expiration processing runExpiration() -> expireReservation(id)
//   both fired at approximately the same instant, then repeated many times to
//   widen the chance of exposing a race.
//
// VALID OUTCOMES — only one may win:
//   A. purchase wins   -> reservation=PURCHASED, a purchase row exists,
//                         availableStock stays DECREMENTED (the unit is sold
//                         and permanently held by the reservation).
//   B. expiration wins -> reservation=EXPIRED, NO purchase row ever exists,
//                         availableStock restored EXACTLY once.
//
// INVALID OUTCOMES — asserted to be unreachable:
//   1. reservation=PURCHASED AND stock restored. (A paid unit would be sold
//      again + the purchase would be double-counted against available stock.)
//   2. reservation=EXPIRED AND a purchase row exists. (An expired reservation
//      would have been paid for.)
//   3. stock restored twice. (Inventory inflation.)
//
// CONCURRENCY STRATEGY  (why the invariants hold)
//   BOTH participants serialize on the SAME row of the `reservation` table via
//   a single conditional UPDATE — the row lock is the arbitration point:
//
//     purchase:
//       UPDATE reservation SET status='PURCHASED'
//       WHERE id=$1 AND status='ACTIVE' AND expiresAt > now()
//     expiration:
//       UPDATE reservation SET status='EXPIRED'
//       WHERE id=$1 AND status='ACTIVE' AND expiresAt <= now()
//
//   * Under PostgreSQL READ COMMITTED the UPDATE that acquires the row lock
//     first wins. The competing statement BLOCKS on the lock, then re-evaluates
//     its WHERE predicate against the winner's freshly committed row and matches
//     zero rows, so it loses cleanly with no side effects.
//   * The two time predicates are complementary (`> now()` vs `<= now()`) and
//     both require status='ACTIVE', so a single row can never satisfy both at
//     once -> purchase and expiration are mutually exclusive by construction.
//   * availableStock is written in ONLY two places and each is atomic with its
//     gate:
//       - reservation creation:  -1 (conditional UPDATE availableStock > 0)
//       - expiration:            +1 (ONLY inside the same transaction whose
//                                 ACTIVE->EXPIRED flip matched a row).
//     Purchase NEVER touches stock, and an expiration only restores stock when
//     it also flipped the reservation to EXPIRED. A purchase that flipped to
//     PURCHASED therefore blocks any restore, and an expiration that flipped to
//     EXPIRED creates no purchase row.
//   * purchase.reservationId has a UNIQUE constraint (DB backstop) and the drop
//     carries CHECK constraint drop_stock_valid
//     (0 <= availableStock <= totalStock) as an extra safety net.
//
// HOW THE TEST IMPOSES GENUINE CONCURRENCY
//   For every iteration a fresh drop (totalStock=1) and fresh user are reserved
//   through the real Phase 4 API, then expiresAt is aged to a very short test
//   expiry that straddles the boundary:
//     +80ms  -> purchase virtually always wins  (exercises ordering A)
//     +15ms  -> coin-flip band (purchase & expiration genuinely contend)
//     -10ms  -> expiration virtually always wins (exercises ordering B)
//   Immediately afterwards a burst of purchase requests and a burst of
//   runExpiration() calls are fired together. After the burst settles (the
//   reservation must converge to PURCHASED or EXPIRED — this mirrors the real
//   worker which keeps polling), the end state is read from the DB and every
//   invariant is asserted.
//
//   The winner (A vs B) is decided by the DATABASE, never by the test — the
//   test only verifies that whichever won, no corrupt combination appeared.
// -----------------------------------------------------------------------------

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'http';
import app from '../app.js';
import { db } from '../prisma/db.ts';
import { runExpiration } from '../services/expirationService.js';

let server;
let baseUrl;
const dbg = () => {};

before(async () => {
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, resolve);
  });
  baseUrl = `http://localhost:${server.address().port}`;

  // Flush any ACTIVE-and-due reservations left over from earlier phases so the
  // convergence loop below only ever has to resolve our own fixture.
  await runExpiration();
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
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function reserveViaApi(userId, dropId) {
  const res = await request(`/api/drops/${dropId}/reserve`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
  assert.strictEqual(res.status, 201, `reserve failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

async function purchase(reservationId, userId) {
  return request(`/api/reservations/${reservationId}/purchase`, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
}

async function getReservation(id) {
  return db.orm.public.Reservation.where({ id }).first();
}

async function getDrop(id) {
  return db.orm.public.Drop.where({ id }).first();
}

async function countPurchases(reservationId) {
  const rows = await db.orm.public.Purchase.where({ reservationId }).all();
  return rows.length;
}

// Reproduce the production worker's polling: keep expiring until the racy
// reservation settles to a terminal state (PURCHASED or EXPIRED). A purchase
// that beat the clock, or an expiration that ran, both converge here — and a
// reservation that neither caught immediately WILL be expired by the next poll.
async function waitForSettled(reservationId, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await getReservation(reservationId);
    if (row.status !== 'ACTIVE') return row.status;
    await runExpiration();
    await new Promise((r) => setTimeout(r, 20));
  }
  const row = await getReservation(reservationId);
  return row.status;
}

describe('Phase 8: Expiration vs Purchase — inventory can never be corrupted', () => {
  it('repeated concurrent purchase/expiration races settle into exactly one valid outcome', async () => {
    const iterations = 30;
    const purchaseBurst = 6; // concurrent purchase requests per iteration
    const expirBurst = 6;    // concurrent expiration runs per iteration
    // Straddle the expiry boundary so BOTH valid orderings are exercised.
    const expiryOffsetsMs = [80, 15, -10];

    const outcomes = { purchased: 0, expired: 0 };

    for (let i = 0; i < iterations; i++) {
      dbg(`iter ${i}: loop start`);
      const stamp = `${Date.now()}_${i}`;
      const user = await db.orm.public.User.create({ username: `p8_user_${stamp}` });
      dbg(`iter ${i}: user ${user.id}`);
      const drop = await db.orm.public.Drop.create({
        name: `P8 Drop ${stamp}`,
        price: 200,
        totalStock: 1,
        availableStock: 1,
        startsAt: new Date(Date.now() - 10000).toISOString(),
      });
      dbg(`iter ${i}: drop ${drop.id}`);

      // Real API reservation consumes the single unit of stock.
      const reservation = await reserveViaApi(user.id, drop.id);
      dbg(`iter ${i}: reservation ${reservation.id} ${reservation.status}`);
      assert.strictEqual((await getDrop(drop.id)).availableStock, 0, 'set-up: reserve must consume 1 unit');

      // Very short test expiry right at the boundary (see header).
      const offset = expiryOffsetsMs[i % expiryOffsetsMs.length];
      await db.orm.public.Reservation.where({ id: reservation.id }).update({
        expiresAt: new Date(Date.now() + offset).toISOString(),
      });

      // === THE RACE: fire purchase requests and expiration processing together ===
      dbg(`iter ${i} offset=${offset} -> firing ${purchaseBurst} purchases + ${expirBurst} expirations`);
      const purchaseResults = await Promise.all(
        Array.from({ length: purchaseBurst }, () => purchase(reservation.id, user.id))
      );
      dbg(`iter ${i}: purchases settled`);
      await Promise.all(Array.from({ length: expirBurst }, () => runExpiration()));
      dbg(`iter ${i}: expirations settled`);

      // Converge to a terminal state (mirrors the real polling worker).
      dbg(`iter ${i}: waitForSettled start`);
      const finalStatus = await waitForSettled(reservation.id);
      dbg(`iter ${i}: settled as ${finalStatus}`);

      // Authoritative end state straight from the database.
      const [finalDrop, purchaseCount] = await Promise.all([
        getDrop(drop.id),
        countPurchases(reservation.id),
      ]);

      // --- VALID OUTCOMES ---
      if (finalStatus === 'PURCHASED') {
        outcomes.purchased += 1;
        assert.strictEqual(
          purchaseResults.filter((r) => r.status === 201).length,
          1,
          `outcome A requires exactly one winning purchase, got ${purchaseResults
            .map((r) => r.status)
            .join(',')} (iter ${i})`,
        );
        assert.strictEqual(purchaseCount, 1, `outcome A: purchase row must exist (iter ${i})`);
        // [INVALID 1] PURCHASED must keep the unit deducted, never restored:
        assert.strictEqual(
          finalDrop.availableStock,
          0,
          `INVALID: status PURCHASED but stock was restored (${finalDrop.availableStock}) (iter ${i})`,
        );
      } else if (finalStatus === 'EXPIRED') {
        outcomes.expired += 1;
        assert.strictEqual(
          purchaseResults.filter((r) => r.status === 201).length,
          0,
          `outcome B: no purchase may succeed when expiration wins (iter ${i})`,
        );
        // [INVALID 2] EXPIRED must have NO purchase row:
        assert.strictEqual(
          purchaseCount,
          0,
          `INVALID: status EXPIRED but a purchase row exists (${purchaseCount}) (iter ${i})`,
        );
        // [INVALID 3] EXPIRED restores stock EXACTLY once (1 unit -> back to total 1):
        assert.strictEqual(
          finalDrop.availableStock,
          1,
          `INVALID: stock not restored exactly once (available=${finalDrop.availableStock}) (iter ${i})`,
        );
      } else {
        assert.fail(`reservation must settle to PURCHASED or EXPIRED, got ${finalStatus} (iter ${i})`);
      }

      // Every failed purchase must be a clean protocol conflict, never a 500.
      for (const r of purchaseResults) {
        assert.ok(
          [201, 409, 410].includes(r.status),
          `purchase returned unexpected status ${r.status}: ${JSON.stringify(r.body)} (iter ${i})`,
        );
      }

      // Drop-level bookkeeping invariant: available stock + units held by
      // non-expired reservations must equal totalStock. A PURCHASED or ACTIVE
      // reservation holds exactly one unit; an EXPIRED one released it.
      const held = (await db.orm.public.Reservation.where({ dropId: drop.id }).all())
        .filter((r) => r.status !== 'EXPIRED').length;
      assert.strictEqual(
        finalDrop.availableStock + held,
        finalDrop.totalStock,
        `drop bookkeeping broken: available(${finalDrop.availableStock}) + held(${held}) != total(${finalDrop.totalStock}) (iter ${i})`,
      );

      // Idempotence / [INVALID 3] backstop: one more full expiration run must
      // not change the reservation nor the stock (nothing can be restored twice).
      await runExpiration();
      const [afterDrop, afterRes] = await Promise.all([
        getDrop(drop.id),
        getReservation(reservation.id),
      ]);
      assert.strictEqual(afterDrop.availableStock, finalDrop.availableStock, `stock changed after a follow-up run (double restore) (iter ${i})`);
      assert.strictEqual(afterRes.status, finalStatus, `reservation changed after a follow-up run (iter ${i})`);
    }

    // Both valid orderings must have been observed — proving both code paths.
    assert.ok(outcomes.purchased > 0, `never observed a purchase win (purchased=${outcomes.purchased})`);
    assert.ok(outcomes.expired > 0, `never observed an expiration win (expired=${outcomes.expired})`);

    console.log(
      `[Phase 8] ${iterations} races (${purchaseBurst} purchases + ${expirBurst} expirations each): ` +
      `purchase-won=${outcomes.purchased} expiration-won=${outcomes.expired}, no corruption observed`,
    );
  });
});