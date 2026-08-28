import express from 'express';
import * as reservationController from '../controllers/reservationController.js';

const router = express.Router();

router.post('/:reservationId/purchase', reservationController.purchaseReservation);

export default router;