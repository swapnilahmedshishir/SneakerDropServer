import * as reservationService from '../services/reservationService.js';

export async function reserveDrop(req, res, next) {
  try {
    const { dropId } = req.params;
    const { userId } = req.body;

    if (userId === undefined || userId === null) {
      return res.status(400).json({
        success: false,
        message: 'userId is required in request body'
      });
    }

    const reservation = await reservationService.reserveDrop(userId, dropId);

    res.status(201).json({
      success: true,
      data: reservation
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        success: false,
        message: err.message
      });
    }
    next(err);
  }
}

export async function purchaseReservation(req, res, next) {
  try {
    const { reservationId } = req.params;
    const { userId } = req.body;

    const purchase = await reservationService.purchaseReservation(reservationId, userId);

    res.status(201).json({
      success: true,
      data: purchase
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({
        success: false,
        message: err.message
      });
    }
    next(err);
  }
}
