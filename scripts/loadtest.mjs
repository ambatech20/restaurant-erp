#!/usr/bin/env node
// Minimal load test: fixed concurrency, timed, with p95/error-rate gates.
// Usage:
//   node scripts/loadtest.mjs --url http://localhost:3000 --concurrency 20 --duration 30
//   node scripts/loadtest.mjs --path /api/v1/health --p95 300
//   node scripts/loadtest.mjs --path /api/v1/orders/1 --header "Authorization: Bearer <key>"

const USAGE = `Load test

Options:
  --url <base>            Base URL (default: $LOADTEST_URL or http://127.0.0.1:3000)
  --path <path>           Request path; repeatable (default: /api/v1/health)
  --concurrency <n>       Parallel workers (default: 10)
  --duration <seconds>    Test length after warm-up (default: 15)
  --header "K: V"         Extra request header; repeatable
  --timeout <ms>          Per-request timeout (default: 10000)
  --p95 <ms>              Fail if aggregate p95 exceeds this (default: 500)
  --max-error-rate <0-1>  Fail if non-2xx/network rate exceeds this (default: 0.01)

Examples:
  node scripts/loadtest.mjs
  node scripts/loadtest.mjs --path /en/login --concurrency 50 --duration 60 --p95 800
  node scripts/loadtest.mjs --path api/v1/health --max-error-rate 0

Note: Git Bash rewrites arguments that start with "/". Pass paths without the leading
slash (--path api/v1/health) or run with MSYS_NO_PATHCONV=1.`;

function fail(message) {
  console.error(`error: ${message}\n`);
  console.error(USAGE);
  process.exit(2);
}

function positiveInt(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`${name} must be a positive integer`);
  return parsed;
}

function normalizePath(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const url = new URL(trimmed);
    return url.pathname + url.search;
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function parseArgs(argv) {
  const options = {
    base: process.env.LOADTEST_URL ?? 'http://127.0.0.1:3000',
    paths: [],
    concurrency: 10,
    duration: 15,
    headers: {},
    timeout: 10000,
    p95: 500,
    maxErrorRate: 0.01,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) fail(`missing value for ${flag}`);
      return next;
    };

    switch (flag) {
      case '--url':
        options.base = value();
        break;
      case '--path':
        options.paths.push(normalizePath(value()));
        break;
      case '--concurrency':
        options.concurrency = positiveInt(value(), flag);
        break;
      case '--duration':
        options.duration = positiveInt(value(), flag);
        break;
      case '--header': {
        const raw = value();
        const colon = raw.indexOf(':');
        if (colon <= 0) fail(`--header expects "Name: value", got "${raw}"`);
        options.headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
        break;
      }
      case '--timeout':
        options.timeout = positiveInt(value(), flag);
        break;
      case '--p95':
        options.p95 = positiveInt(value(), flag);
        break;
      case '--max-error-rate': {
        const rate = Number(value());
        if (!Number.isFinite(rate) || rate < 0 || rate > 1) fail('--max-error-rate must be between 0 and 1');
        options.maxErrorRate = rate;
        break;
      }
      case '--help':
      case '-h':
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        fail(`unknown option: ${flag}`);
    }
  }

  if (options.paths.length === 0) options.paths.push('/api/v1/health');
  if (options.concurrency > 500) fail('--concurrency above 500 is not supported');
  return options;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

async function hit(options, path) {
  const url = new URL(path, options.base).toString();
  const startedAt = performance.now();
  let status = 0;
  try {
    const response = await fetch(url, {
      headers: options.headers,
      signal: AbortSignal.timeout(options.timeout),
      redirect: 'follow',
    });
    status = response.status;
    await response.arrayBuffer();
  } catch {
    status = -1;
  }
  return { path, status, ms: performance.now() - startedAt };
}

async function runWorker(options, deadline, samples) {
  for (;;) {
    const cursor = samples.nextPath++;
    if (Date.now() >= deadline) return;
    const path = options.paths[cursor % options.paths.length];
    samples.records.push(await hit(options, path));
  }
}

function summarize(records) {
  const durations = records.map((record) => record.ms).sort((a, b) => a - b);
  const errors = records.filter((record) => record.status < 200 || record.status >= 300).length;
  const total = durations.reduce((sum, value) => sum + value, 0);
  return {
    count: records.length,
    errors,
    errorRate: records.length ? errors / records.length : 0,
    min: durations[0] ?? 0,
    mean: records.length ? total / records.length : 0,
    p50: percentile(durations, 0.5),
    p95: percentile(durations, 0.95),
    p99: percentile(durations, 0.99),
    max: durations[durations.length - 1] ?? 0,
  };
}

const ms = (value) => `${Math.round(value)}ms`;
const pad = (value, width) => String(value).padStart(width);
const padLeft = (value, width) => String(value).padEnd(width);

async function main() {
  const options = parseArgs(process.argv.slice(2));

  console.log(`Load test ${options.base}`);
  console.log(
    `${options.concurrency} workers · ${options.duration}s · paths: ${options.paths.join(', ')}`,
  );
  console.log('warm-up…');

  for (const path of options.paths) await hit(options, path);

  const samples = { records: [], nextPath: 0 };
  const startedAt = Date.now();
  const deadline = startedAt + options.duration * 1000;

  await Promise.all(
    Array.from({ length: options.concurrency }, () => runWorker(options, deadline, samples)),
  );

  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  const all = summarize(samples.records);
  const byPath = new Map();
  for (const record of samples.records) {
    if (!byPath.has(record.path)) byPath.set(record.path, []);
    byPath.get(record.path).push(record);
  }

  console.log('');
  console.log(
    `${padLeft('path', 34)}${pad('reqs', 8)}${pad('rps', 8)}${pad('p50', 8)}${pad('p95', 8)}${pad('p99', 8)}${pad('err', 8)}`,
  );
  for (const [path, records] of byPath) {
    const stats = summarize(records);
    console.log(
      `${padLeft(path, 34)}${pad(stats.count, 8)}${pad((stats.count / elapsedSeconds).toFixed(1), 8)}` +
        `${pad(ms(stats.p50), 8)}${pad(ms(stats.p95), 8)}${pad(ms(stats.p99), 8)}` +
        `${pad((stats.errorRate * 100).toFixed(2) + '%', 8)}`,
    );
  }
  console.log(
    `${padLeft('TOTAL', 34)}${pad(all.count, 8)}${pad((all.count / elapsedSeconds).toFixed(1), 8)}` +
      `${pad(ms(all.p50), 8)}${pad(ms(all.p95), 8)}${pad(ms(all.p99), 8)}` +
      `${pad((all.errorRate * 100).toFixed(2) + '%', 8)}`,
  );
  console.log(`       min ${ms(all.min)} · mean ${ms(all.mean)} · max ${ms(all.max)}`);

  const p95Ok = all.p95 <= options.p95;
  const errorOk = all.errorRate <= options.maxErrorRate;
  const verdict = p95Ok && errorOk ? 'PASS' : 'FAIL';
  console.log(
    `\nResult: ${verdict} (p95 ${ms(all.p95)} ${p95Ok ? '<=' : '>'} ${options.p95}ms, ` +
      `error rate ${(all.errorRate * 100).toFixed(2)}% ${errorOk ? '<=' : '>'} ` +
      `${(options.maxErrorRate * 100).toFixed(2)}%)`,
  );

  process.exit(verdict === 'PASS' ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
