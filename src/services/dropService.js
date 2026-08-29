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
  const drops = await db.orm.public.Drop.where((d) => d.startsAt.lte(now)).all();
  if (drops.length === 0) return [];

  // Attach the top 3 most recent purchasers per drop.
  //
  // Performance: exactly 2 fixed queries — never one per drop (no N+1). The
  // second query loads purchases for the active drops' ids in a single round
  // trip, newest first, using the existing @@index([dropId, createdAt]) on
  // Purchase. The per-drop "top 3" cut is applied while grouping in JS because
  // the ORM query builder has no per-partition LIMIT (window function) support.
  // Row volume stays bounded by the purchases of currently-active drops only.
  const dropIds = drops.map((drop) => drop.id);
  const purchases = await db.orm.public.Purchase
    .where((p) => p.dropId.in(dropIds))
    .orderBy((p) => p.createdAt.desc())
    .include('user')
    .all();

  const purchasersByDrop = new Map();
  for (const purchase of purchases) {
    const username = purchase.user?.username;
    if (!username) continue;
    const list = purchasersByDrop.get(purchase.dropId);
    if (list) {
      if (list.length < 3) list.push({ username });
    } else {
      purchasersByDrop.set(purchase.dropId, [{ username }]);
    }
  }

  return drops.map((drop) => ({
    ...drop,
    recentPurchasers: purchasersByDrop.get(drop.id) ?? [],
  }));
}
