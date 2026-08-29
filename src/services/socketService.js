let ioInstance = null;

export function initSocket(io) {
  ioInstance = io;
}

export function getSocket() {
  return ioInstance;
}

export function emitStockUpdated(dropId, availableStock) {
  if (ioInstance) {
    ioInstance.emit('stock_updated', {
      dropId: parseInt(dropId, 10),
      availableStock: parseInt(availableStock, 10)
    });
  }
}

/**
 * Broadcast that a reservation was expired by the backend (Phase 11). The
 * client treats this as the authoritative signal — its local countdown is
 * only a display, never the source of truth.
 */
export function emitReservationExpired(reservationId, dropId) {
  if (ioInstance) {
    ioInstance.emit('reservation_expired', {
      reservationId: parseInt(reservationId, 10),
      dropId: parseInt(dropId, 10)
    });
  }
}
