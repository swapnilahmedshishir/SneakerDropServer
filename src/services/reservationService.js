import { db } from '../prisma/db.ts';
import { emitStockUpdated } from './socketService.js';

// Reservations are valid for 60 seconds (mirrors the Phase 4 API contract).
const RESERVATION_TTL_MS = 60 * 1000;

// PostgreSQL SQLSTATE 23505 == unique_violation
const UNIQUE_VIOLATION_SQLSTATE = '23505';

export async function reserveDrop(userId, dropId) {
  // Parsed inputs validation
  const parsedUserId = parseInt(userId, 10);
  const parsedDropId = parseInt(dropId, 10);

  if (isNaN(parsedUserId) || isNaN(parsedDropId)) {
    const err = new Error('Invalid user ID or drop ID');
    err.status = 400;
    throw err;
  }

  // Perform atomic transaction
  const reservation = await db.transaction(async (tx) => {
    // 1. Verify User exists
    const user = await tx.orm.public.User.where({ id: parsedUserId }).first();
    if (!user) {
      const err = new Error('User not found');
      err.status = 404;
      throw err;
    }

    // 2. Verify Drop exists
    const drop = await tx.orm.public.Drop.where({ id: parsedDropId }).first();
    if (!drop) {
      const err = new Error('Drop not found');
      err.status = 404;
      throw err;
    }

    const now = new Date();
    const startsAt = new Date(drop.startsAt);
    if (startsAt > now) {
      const err = new Error('Drop is not active yet');
      err.status = 400;
      throw err;
    }

    // 3. Check existing active reservation for the user on this drop
    const existingRes = await tx.orm.public.Reservation.where({
      userId: parsedUserId,
      dropId: parsedDropId,
      status: 'ACTIVE'
    }).first();

    if (existingRes) {
      const err = new Error('User already has an active reservation for this drop');
      err.status = 409;
      throw err;
    }

    // 4. Atomically consume one unit of stock.
    // The single conditional UPDATE is the serialization point: under
    // PostgreSQL READ COMMITTED a concurrent UPDATE that blocks on the row
    // re-evaluates the WHERE clause against the freshly committed row, so
    // exactly one caller can win when only one unit of stock is left. The
    // drop_stock_valid CHECK constraint guarantees the result stays >= 0.
    const stockPlan = db.raw.sql`
      UPDATE "public"."drop"
      SET "availableStock" = "availableStock" - 1, "updatedAt" = now()
      WHERE "id" = ${parsedDropId} AND "availableStock" > 0
    `.affectedCount().build();

    const stockResult = await tx.execute(stockPlan);

    if (stockResult.affectedRows === 0) {
      const err = new Error('Drop is out of stock');
      err.status = 409;
      throw err;
    }

    // 5. Create the ACTIVE reservation with a 60 second validity window.
    const reservation = await tx.orm.public.Reservation.create({
      userId: parsedUserId,
      dropId: parsedDropId,
      status: 'ACTIVE',
      expiresAt: new Date(now.getTime() + RESERVATION_TTL_MS).toISOString(),
    });

    return reservation;
  }).catch((err) => {
    // A truly concurrent second request from the same user can race past the
    // check above — the partial unique index
    //   unique_active_reservation_per_user_drop
    // on (userId, dropId) WHERE status = 'ACTIVE' then rejects the insert.
    // Translate that database error back into an API conflict.
    if (err && err.sqlState === UNIQUE_VIOLATION_SQLSTATE) {
      const conflict = new Error('User already has an active reservation for this drop');
      conflict.status = 409;
      throw conflict;
    }
    throw err;
  });

  // Phase 10 — notify connected dashboards that the drop's stock changed. This
  // is best effort: a client that misses the event simply picks the fresh value
  // up on its next fetch / reconnect, so a broadcast failure must never fail
  // the reservation itself.
  await broadcastStockUpdate(parsedDropId);

  return reservation;
}

// Broadcast the drop's *current* availableStock. Reading it back after the
// transaction keeps the value accurate even when several reservations land in
// quick succession.
async function broadcastStockUpdate(dropId) {
  try {
    const drop = await db.orm.public.Drop.where({ id: dropId }).first();
    if (drop) {
      emitStockUpdated(drop.id, drop.availableStock);
    }
  } catch (err) {
    console.error('[socket] Failed to broadcast stock update:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Phase 6 — Purchase
// POST /api/reservations/:reservationId/purchase
//
// A user may purchase ONLY while reservation.status === 'ACTIVE' AND
// reservation.expiresAt > now. The purchase must never touch availableStock:
// stock was already consumed when the reservation was created.
// ---------------------------------------------------------------------------
export async function purchaseReservation(reservationId, userId) {
  // Parsed inputs validation
  const parsedReservationId = parseInt(reservationId, 10);
  const parsedUserId = parseInt(userId, 10);

  if (isNaN(parsedReservationId)) {
    const err = new Error('Invalid reservation ID');
    err.status = 400;
    throw err;
  }

  if (userId === undefined || userId === null || isNaN(parsedUserId)) {
    const err = new Error('Purchase requires a valid userId in the request body');
    err.status = 400;
    throw err;
  }

  // Perform atomic transaction.
  //   BEGIN
  //     -> validate reservation
  //     -> validate expiration
  //     -> transition ACTIVE -> PURCHASED
  //     -> create Purchase
  //   COMMIT
  // Any thrown error aborts the entire transaction (ROLLBACK).
  return await db.transaction(async (tx) => {
    // 1. Validate the reservation exists and belongs to the caller.
    const reservation = await tx.orm.public.Reservation.where({ id: parsedReservationId }).first();
    if (!reservation) {
      const err = new Error('Reservation not found');
      err.status = 404;
      throw err;
    }

    if (reservation.userId !== parsedUserId) {
      const err = new Error('Reservation does not belong to this user');
      err.status = 403;
      throw err;
    }

    // 2. Atomically transition ACTIVE -> PURCHASED, but ONLY while the
    //    reservation is still ACTIVE and has not expired.
    //    This single conditional UPDATE is the serialization point for every
    //    race we care about:
    //      - purchase vs purchase: the row lock serializes concurrent
    //        transactions; the loser re-evaluates after the winner commits
    //        and matches zero rows (status is no longer 'ACTIVE').
    //      - purchase vs expiration: if an expirer already flipped the row to
    //        'EXPIRED' (or the clock passed expiresAt), zero rows match.
    //      - already-purchased: status is 'PURCHASED', zero rows match.
    const now = new Date();
    const purchased = await tx.orm.public.Reservation
      .where({ id: parsedReservationId, status: 'ACTIVE' })
      .where((r) => r.expiresAt.gt(now.toISOString()))
      .update({ status: 'PURCHASED' });

    // 3. Zero rows matched — report the precise reason.
    if (!purchased) {
      const current = await tx.orm.public.Reservation.where({ id: parsedReservationId }).first();
      if (!current) {
        const err = new Error('Reservation not found');
        err.status = 404;
        throw err;
      }
      if (current.status === 'PURCHASED') {
        const err = new Error('Reservation has already been purchased');
        err.status = 409;
        throw err;
      }
      if (current.status === 'EXPIRED' || new Date(current.expiresAt).getTime() <= now.getTime()) {
        const err = new Error('Reservation has expired');
        err.status = 410;
        throw err;
      }
      const err = new Error('Reservation is not available for purchase');
      err.status = 409;
      throw err;
    }

    // 4. Create the purchase record.
    //    availableStock is intentionally untouched here — it was already
    //    decremented when the reservation was created. The unique constraint
    //    on purchase.reservationId is the database-level backstop: a racing
    //    duplicate insert fails with 23505 and rolls this transaction back, so
    //    two purchases can never exist for the same reservation.
    return await tx.orm.public.Purchase.create({
      userId: purchased.userId,
      dropId: purchased.dropId,
      reservationId: purchased.id,
    });
  }).catch((err) => {
    // Backstop: if a racing transaction somehow created the purchase before
    // this one, the unique constraint on purchase.reservationId fires and the
    // whole transaction (including the status flip) is rolled back. Surface a
    // clean conflict instead of a 500.
    if (err && err.sqlState === UNIQUE_VIOLATION_SQLSTATE) {
      const conflict = new Error('Reservation has already been purchased');
      conflict.status = 409;
      throw conflict;
    }
    throw err;
  });
}
