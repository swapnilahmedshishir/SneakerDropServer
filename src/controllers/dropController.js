import * as dropService from '../services/dropService.js';

export async function createDrop(req, res, next) {
  try {
    const { name, price, totalStock, startsAt } = req.body;
    
    // Validation
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ success: false, message: 'Name is required' });
    }
    if (price === undefined || price === null || typeof price !== 'number' || isNaN(price) || price <= 0) {
      return res.status(400).json({ success: false, message: 'Valid price is required (positive number)' });
    }
    if (totalStock === undefined || totalStock === null || typeof totalStock !== 'number' || isNaN(totalStock) || !Number.isInteger(totalStock) || totalStock <= 0) {
      return res.status(400).json({ success: false, message: 'Valid totalStock is required (positive integer)' });
    }
    if (!startsAt || typeof startsAt !== 'string') {
      return res.status(400).json({ success: false, message: 'Valid startsAt timestamp is required' });
    }
    const date = new Date(startsAt);
    if (isNaN(date.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid startsAt timestamp' });
    }
    
    const drop = await dropService.createDrop({ name, price, totalStock, startsAt });
    res.status(201).json({ success: true, data: drop });
  } catch (err) {
    next(err);
  }
}

export async function getAllDrops(req, res, next) {
  try {
    const drops = await dropService.getAllDrops();
    res.json({ success: true, data: drops });
  } catch (err) {
    next(err);
  }
}

export async function getActiveDrops(req, res, next) {
  try {
    const drops = await dropService.getActiveDrops();
    res.json({ success: true, data: drops });
  } catch (err) {
    next(err);
  }
}
