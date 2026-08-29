import { db } from '../prisma/db.ts';
import { emitStockUpdated, emitReservationExpired } from './socketService.js';

// Business rule: reservations live for 60 seconds (enforced at creation time in
// reservationService.js). Only the worker's POLL interval is configurable.
const DEFAULT_POLL_INTERVAL_MS = 1000;

let workerTimer = null;
let workerRunning = false;

function getPollIntervalMs() {
  const raw = process.env.EXPIRATION_POLL_INTERVAL_MS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_INTERVAL_MS;
}

/**
 * Expire a single reservation atomically (Phase 7).
 *
 * One transaction:
 *   1. Conditional status flip  ACTIVE -> EXPIRED  but ONLY when
 *      `expiresAt <= now()` (database clock is authoritative).
 *      This single conditional UPDATE is the serialization point:
 *        - expiration vs purchase: the row lock serializes the two
 *          transactions; the loser re-evaluates after the winner commits and
 *          matches zero rows, so a reservation can never end up both
 *          PURCHASED-with-stock-restored or EXPIRED-with-a-purchase.
 *        - expiration vs expiration (multiple workers / instances): the same
 *          mechanism guarantees exactly one transaction per reservation wins
 *          the flip; losers affect zero rows.
 *   2. If and only if the flip matched one row, restore the unit of stock that
 *      was consumed when the reservation was created — in the SAME
 *      transaction, so the two changes commit together and an expired
 *      reservation is processed exactly once (stock can never be restored
 *      twice). Purchases never touch stock, so the only writer fighting here
 *      is reservation creation (decrement) and this (increment).
 *
 * Returns true when this call performed the flip + restore, false otherwise.
 */
export async function expireReservation(reservationId) {
  const parsedId = parseInt(reservationId, 10);
  if (isNaN(parsedId)) return false;

  const flipPlan = db.raw.sql`
    UPDATE "public"."reservation"
    SET "status" = 'EXPIRED', "updatedAt" = now()
    WHERE "id" = ${parsedId}
      AND "status" = 'ACTIVE'
      AND "expiresAt" <= now()
  `.affectedCount().build();

  const restorePlan = db.raw.sql`
    UPDATE "public"."drop" AS d
    SET "availableStock" = d."availableStock" + 1, "updatedAt" = now()
    FROM "public"."reservation" AS r
    WHERE r."id" = ${parsedId} AND d."id" = r."dropId" AND d."availableStock" < d."totalStock"
  `.affectedCount().build();

  const expired = await db.transaction(async (tx) => {
    const flip = await tx.execute(flipPlan);
    if (flip.affectedRows === 0) {
      // Already expired, already purchased, or not expired yet.
      return false;
    }
    await tx.execute(restorePlan);

    // Read the restored stock so the broadcast below reports a fresh value.
    const reservation = await tx.orm.public.Reservation.where({ id: parsedId }).first();
    return { restored: true, dropId: reservation ? reservation.dropId : null };
  });

  if (expired.restored) {
    // Phase 10/11 — restoring the stock changed the drop again AND the
    // reservation was genuinely expired by the backend. Broadcast both facts
    // so open dashboards update without a refresh. Best effort: a client that
    // misses the event converges on its next fetch / API call.
    emitReservationExpired(parsedId, expired.dropId);
    try {
      const drop = expired.dropId
        ? await db.orm.public.Drop.where({ id: expired.dropId }).first()
        : null;
      if (drop) {
        emitStockUpdated(drop.id, drop.availableStock);
      }
    } catch (err) {
      console.error('[socket] Failed to broadcast stock update:', err.message);
    }
    return true;
  }

  return false;
}

/**
 * Scan for due ACTIVE reservations and expire them.
 *
 * The candidate scan is a best-effort read (it simply answers "what might be
 * due"); correctness never depends on it because every candidate is processed
 * through `expireReservation`, whose conditional UPDATE is the authoritative,
 * idempotent gate. This makes the process safe when the scan races with a
 * purchase, when multiple worker iterations overlap, or when several backend
 * instances run the same loop.
 *
 * Returns the number of reservations expired by THIS call.
 */
export async function runExpiration() {
  const now = new Date().toISOString();

  const candidates = await db.orm.public.Reservation
    .select('id')
    .where({ status: 'ACTIVE' })
    .where((r) => r.expiresAt.lte(now))
    .all();

  let expired = 0;
  for (const candidate of candidates) {
    if (await expireReservation(candidate.id)) {
      expired += 1;
    }
  }

  if (expired > 0) {
    console.log(`[expiration] expired ${expired} reservation(s)`);
  }
  return expired;
}

/**
 * Start the background polling worker. The database remains the authoritative
 * source of truth — the timer only wakes the loop, it never decides what
 * expires. Uses `unref()` so a long idle server is not kept alive by the timer.
 *
 * Poll interval: EXPIRATION_POLL_INTERVAL_MS (default 1000ms). The
 * reservation lifetime stays fixed at 60 seconds by the reservation service.
 */
export function startExpirationWorker(intervalMs = getPollIntervalMs()) {
  if (workerTimer) return workerTimer;

  workerTimer = setInterval(() => {
    // Never pile up overlapping runs when one iteration is slow.
    if (workerRunning) return;
    workerRunning = true;
    runExpiration()
      .catch((err) => {
        console.error('[expiration] worker error:', err);
      })
      .finally(() => {
        workerRunning = false;
      });
  }, intervalMs);

  workerTimer.unref?.();
  return workerTimer;
}

export function stopExpirationWorker() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}