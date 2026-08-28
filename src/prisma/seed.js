import 'dotenv/config';
import postgres from '@prisma/orm-postgres/runtime';
import contractJson from './contract.json' with { type: 'json' };

const db = postgres({
  contractJson,
  url: process.env.DATABASE_URL,
});

async function seed() {
  console.log('Starting seed execution...');

  // 1. Seed Users
  const usernames = ['rahim', 'karim', 'john', 'hasan', 'david'];
  for (const username of usernames) {
    const existing = await db.orm.public.User.where({ username }).first();
    if (!existing) {
      await db.orm.public.User.insert({ username });
      console.log(`Created user: ${username}`);
    } else {
      console.log(`User already exists: ${username}`);
    }
  }

  // 2. Seed Active Drop
  const activeDropName = 'Air Jordan 1';
  const existingActive = await db.orm.public.Drop.where({ name: activeDropName }).first();
  if (!existingActive) {
    await db.orm.public.Drop.insert({
      name: activeDropName,
      price: 200,
      totalStock: 5,
      availableStock: 5,
      startsAt: new Date(Date.now() - 3600000).toISOString(),
    });
    console.log(`Created active drop: ${activeDropName}`);
  } else {
    console.log(`Active drop already exists: ${activeDropName}`);
  }

  // 3. Seed Future Drop
  const futureDropName = 'Nike Dunk Low';
  const existingFuture = await db.orm.public.Drop.where({ name: futureDropName }).first();
  if (!existingFuture) {
    await db.orm.public.Drop.insert({
      name: futureDropName,
      price: 150,
      totalStock: 10,
      availableStock: 10,
      startsAt: new Date(Date.now() + 86400000).toISOString(),
    });
    console.log(`Created future drop: ${futureDropName}`);
  } else {
    console.log(`Future drop already exists: ${futureDropName}`);
  }

  console.log('Seeding completed successfully!');
}

seed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seeding failed:', err);
    process.exit(1);
  });
