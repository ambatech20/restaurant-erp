import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { log } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const startedAt = performance.now();

  let dbOk = true;
  let dbLatencyMs: number | null = null;
  let dbError: string | null = null;

  try {
    const queryStart = performance.now();
    await prisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Math.round(performance.now() - queryStart);
  } catch (error) {
    dbOk = false;
    dbError = error instanceof Error ? error.message : String(error);
  }

  let outbox: { pending: number; failed: number } | null = null;
  if (dbOk) {
    try {
      const [pending, failed] = await Promise.all([
        prisma.outboundEvent.count({ where: { status: 'PENDING' } }),
        prisma.outboundEvent.count({ where: { status: 'FAILED' } }),
      ]);
      outbox = { pending, failed };
    } catch (error) {
      dbOk = false;
      dbError = error instanceof Error ? error.message : String(error);
    }
  }

  const body = {
    ok: dbOk,
    service: 'warka-dine',
    version: '1.0',
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    checks: {
      database: {
        ok: dbOk,
        latencyMs: dbLatencyMs,
        ...(dbError ? { error: dbError } : {}),
      },
      outbox,
    },
    outbox,
    uptimeSeconds: Math.round(process.uptime()),
    durationMs: Math.round(performance.now() - startedAt),
    issuedAt: new Date().toISOString(),
  };

  if (!dbOk) log('error', 'health_check_failed', { error: dbError });

  return NextResponse.json(body, {
    status: dbOk ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
