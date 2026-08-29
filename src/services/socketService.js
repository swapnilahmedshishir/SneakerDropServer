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
