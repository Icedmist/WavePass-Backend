import { PrismaClient, PlanMode, RouterStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding WavePass database...');

  // 1. Create or find default venue
  const venue = await prisma.venue.upsert({
    where: { slug: 'flagship' },
    update: {},
    create: {
      name: 'WavePass Flagship Venue',
      slug: 'flagship',
      timezone: 'Africa/Lagos',
      currency: 'NGN',
    },
  });
  console.log(`Venue: ${venue.name} (${venue.id})`);

  // 2. Create or find default router
  const router = await prisma.router.upsert({
    where: { id: 'default-router-1' },
    update: { endpoint: process.env.MOCK_ROUTER_URL || 'http://localhost:3001' },
    create: {
      id: 'default-router-1',
      venueId: venue.id,
      name: 'Primary Hotspot Router',
      endpoint: process.env.MOCK_ROUTER_URL || 'http://localhost:3001',
      connectionMode: 'local',
      status: RouterStatus.ONLINE,
    },
  });
  console.log(`Router: ${router.name} (${router.endpoint})`);

  // 3. Seed standard pricing plans
  const plansData = [
    {
      id: 'plan_1hr',
      name: '1 Hour Quick Surf',
      description: 'High-speed unlimited access for 1 hour',
      priceMinor: 20000, // 200 NGN
      durationSeconds: 3600,
      rateLimit: 'profile_1h',
      mode: PlanMode.ELAPSED,
      simultaneousDevices: 1,
      active: true,
    },
    {
      id: 'plan_12hr',
      name: '12 Hour Access',
      description: 'Extended full-day work session for 12 hours',
      priceMinor: 80000, // 800 NGN
      durationSeconds: 43200,
      rateLimit: 'profile_12h',
      mode: PlanMode.ELAPSED,
      simultaneousDevices: 1,
      active: true,
    },
    {
      id: 'plan_24hr',
      name: '24 Hour Unlimited',
      description: 'Full 24-hour non-stop Wi-Fi access pass (Single Device)',
      priceMinor: 150000, // 1500 NGN
      durationSeconds: 86400,
      rateLimit: 'profile_1d',
      mode: PlanMode.ELAPSED,
      simultaneousDevices: 1,
      active: true,
    },
    {
      id: 'plan_duo_24hr',
      name: '24 Hour Duo Pass',
      description: 'Shareable Wi-Fi pass for up to 2 devices simultaneously',
      priceMinor: 250000, // 2500 NGN
      durationSeconds: 86400,
      rateLimit: 'profile_duo',
      mode: PlanMode.ELAPSED,
      simultaneousDevices: 2,
      active: true,
    },
    {
      id: 'plan_family_24hr',
      name: '24 Hour Family Pass',
      description: 'High-speed shared Wi-Fi for up to 5 devices simultaneously',
      priceMinor: 500000, // 5000 NGN
      durationSeconds: 86400,
      rateLimit: 'profile_family',
      mode: PlanMode.ELAPSED,
      simultaneousDevices: 5,
      active: true,
    },
  ];

  for (const plan of plansData) {
    const created = await prisma.plan.upsert({
      where: { id: plan.id },
      update: {
        priceMinor: plan.priceMinor,
        durationSeconds: plan.durationSeconds,
        rateLimit: plan.rateLimit,
        simultaneousDevices: plan.simultaneousDevices,
        active: plan.active,
      },
      create: {
        ...plan,
        venueId: venue.id,
      },
    });
    console.log(`Plan: ${created.name} — ₦${created.priceMinor / 100} (${created.rateLimit}, ${created.simultaneousDevices} device${created.simultaneousDevices > 1 ? 's' : ''})`);
  }

  console.log('Seeding finished successfully.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
