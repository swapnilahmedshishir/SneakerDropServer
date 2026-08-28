import { db } from './db.js';

async function seed() {
  console.log('Starting migration seed...');

  // Create Users
  const users = ['rahim', 'karim', 'john', 'hasan', 'david'];
  for (const username of users) {
    await db.orm.public.User.upsert({
      where: { username },
      create: { username },
      update: {},
    });
  }
  console.log('Users seeded.');

  // Create active drop
  await db.orm.public.Drop.upsert({
    where: { name: 'Air Jordan 1' },
    create: {
      name: 'Air Jordan 1',
      price: 200,
      totalStock: 5,
      availableStock: 5,
      startsAt: new Date(Date.now() - 3600000).toISOString(),
    },
    update: {},
  });
  console.log('Active drop seeded.');

  // Create future drop
  await db.orm.public.Drop.upsert({
    where: { name: 'Nike Dunk Low' },
    create: {
      name: 'Nike Dunk Low',
      price: 150,
      totalStock: 10,
      availableStock: 10,
      startsAt: new Date(Date.now() + 86400000).toISOString(),
    },
    update: {},
  });
  console.log('Future drop seeded.');

  console.log('Seed finished successfully.');
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
