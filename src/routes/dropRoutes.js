import express from 'express';
import * as dropController from '../controllers/dropController.js';

const router = express.Router();

router.post('/', dropController.createDrop);
router.get('/', dropController.getAllDrops);
router.get('/active', dropController.getActiveDrops);

export default router;
