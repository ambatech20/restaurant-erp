import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dbPath = path.join(root, 'prisma', 'test-open-bill.db');

/**
 * Build a throwaway SQLite database for the acceptance tests. Prisma resolves
 * relative `file:` URLs against the schema directory, so the test client and
 * this setup both point at prisma/test-open-bill.db.
 */
export default async function setup() {
  process.env.DATABASE_URL = 'file:./test-open-bill.db';
  (process.env as Record<string, string>).NODE_ENV = 'test';

  for (const file of [dbPath, `${dbPath}-journal`]) {
    if (existsSync(file)) rmSync(file);
  }

  execFileSync(
    process.execPath,
    ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate', '--accept-data-loss'],
    { cwd: root, env: { ...process.env }, stdio: 'inherit' },
  );

  const { applyOpenBillIndex } = await import('@/server/services/order-bill.service');
  await applyOpenBillIndex();

  const { prisma } = await import('@/lib/prisma');
  await prisma.$disconnect();
}
