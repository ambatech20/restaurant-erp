import type { Instrumentation } from 'next';
import { log, logError } from './lib/logger';

export function register(): void {
  log('info', 'server_start', {
    runtime: process.env.NEXT_RUNTIME ?? 'nodejs',
    env: process.env.NODE_ENV ?? 'development',
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
  });
}

export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  logError('request_error', error, {
    method: request.method,
    path: request.path,
    routerKind: context.routerKind,
    routePath: context.routePath,
    routeType: context.routeType,
  });
};
