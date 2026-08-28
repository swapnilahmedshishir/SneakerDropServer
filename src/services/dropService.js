import { db } from '../prisma/db.ts';

export async function createDrop(data) {
  const { name, price, totalStock, startsAt } = data;

  // Validation done in controller
  const newDrop = await db.orm.public.Drop.create({
    name,
    price,
    totalStock,
    availableStock: totalStock, // Logic: availableStock equals totalStock
    startsAt: new Date(startsAt).toISOString(),
  });

  return newDrop;
}

export async function getAllDrops() {
  return await db.orm.public.Drop.all();
}

export async function getActiveDrops() {
  const now = new Date().toISOString();
  return await db.orm.public.Drop.where((d) => d.startsAt.lte(now)).all();
}
