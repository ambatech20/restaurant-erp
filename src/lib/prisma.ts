import { PrismaClient } from '@prisma/client';
import { log } from '@/lib/logger';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  slowQueryHook: boolean | undefined;
};

const slowQueryMs = Number(process.env.SLOW_QUERY_MS ?? 0);
const slowQueryEnabled = Number.isFinite(slowQueryMs) && slowQueryMs > 0;

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: slowQueryEnabled
      ? [{ emit: 'event', level: 'query' }, 'error', 'warn']
      : ['error', 'warn'],
  });

if (slowQueryEnabled && !globalForPrisma.slowQueryHook) {
  globalForPrisma.slowQueryHook = true;
  type QueryHookClient = {
    $on: (event: 'query', callback: (event: { duration: number; target: string; query: string }) => void) => unknown;
  };
  (prisma as unknown as QueryHookClient).$on('query', (event) => {
    if (event.duration >= slowQueryMs) {
      log('warn', 'slow_query', {
        durationMs: event.duration,
        target: event.target,
        query: event.query.slice(0, 300),
      });
    }
  });
}

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
