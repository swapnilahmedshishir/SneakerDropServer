import express from 'express';
import * as dropController from '../controllers/dropController.js';
import * as reservationController from '../controllers/reservationController.js';

const router = express.Router();

router.post('/', dropController.createDrop);
router.get('/', dropController.getAllDrops);
router.get('/active', dropController.getActiveDrops);
router.post('/:dropId/reserve', reservationController.reserveDrop);

export default router;
