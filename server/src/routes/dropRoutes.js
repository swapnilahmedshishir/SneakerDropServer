const express = require('express');
const router = express.Router();
const dropController = require('../controllers/dropController');

router.post('/', dropController.createDrop);
router.get('/', dropController.getAllDrops);
router.get('/active', dropController.getActiveDrops);

module.exports = router;
