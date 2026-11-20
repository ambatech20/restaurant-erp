# Operations

Runbook for keeping Warka Dine observable and recoverable. No external services required.

## Health and uptime

`GET /api/v1/health`

- `200` — app and database healthy. Body includes `checks.database.latencyMs`, `checks.outbox` (pending/failed integration events), `uptimeSeconds`, `commit`.
- `503` — database unreachable; `checks.database.error` holds the reason.
- Response is `Cache-Control: no-store`, safe to poll.

Uptime monitoring: point a free monitor (UptimeRobot, Better Stack) at the health URL every 5 minutes and alert on any non-200. On the LAN deployment, monitor `http://<server-ip>:3000/api/v1/health`; on Vercel, the production alias.

## Logs

Server logs are single-line JSON so they can be grepped:

```
{"ts":"…","level":"error","event":"request_error","method":"GET","path":"/en/pos","routePath":"/[locale]/(pos)/pos","routeType":"render","error":{"name":"…","message":"…","stack":"…"}}
```

Events:

| event | when |
| --- | --- |
| `server_start` | process boot (runtime, env, commit) |
| `request_error` | any unhandled server error in routes, actions, or rendering (via `src/instrumentation.ts`) |
| `health_check_failed` | health route could not reach the database |
| `slow_query` | a Prisma query exceeded `SLOW_QUERY_MS` (opt-in) |

Client-side crashes render the error boundary with a `Ref:` digest — that digest matches the `error.digest` field of the server `request_error` line, so a cashier can send a screenshot and the log can be found by digest.

Where to read them: Vercel → Project → Logs (production); the server console / terminal on a self-hosted install.

## Slow query profiling

Set `SLOW_QUERY_MS=200` (or similar) and restart. Queries at or above that duration log a `slow_query` event with `durationMs`, `target`, and the first 300 characters of SQL. Unset the variable to disable; there is no overhead when off.

## Load testing

`pnpm run test:load` (or `node scripts/loadtest.mjs`) with options:

```sh
node scripts/loadtest.mjs --url http://localhost:3000 --path /api/v1/health --concurrency 20 --duration 30 --p95 300
```

```sh
node scripts/loadtest.mjs --url https://warka-dine-eight.vercel.app --path /api/v1/health --concurrency 50 --duration 60 --p95 800 --max-error-rate 0.005
```

- Defaults: 10 workers, 15s, p95 gate 500ms, error-rate gate 1%.
- Exit code 0 = pass, 1 = threshold breached; use it as a release gate.
- Protected API routes need `--header "Authorization: Bearer <api key>"`.
- Run against a staging/LAN instance, not during service hours.

The reel/engineering baseline: a POS on a single server should hold p95 under ~300ms at 20 concurrent users. Record the numbers before and after risky changes.

## Incident runbook

1. Check `/api/v1/health` (503 = database; 200 + errors = application).
2. Grep logs for `level":"error"` around the reported time; use the digest from the on-screen `Ref:` when provided.
3. For database issues: check connectivity/credentials (`DATABASE_URL`), Prisma error in `health_check_failed`.
4. For integration stalls: check `checks.outbox.pending` / `FAILED`; flush via `POST /api/cron/flush-outbox` with the `OUTBOX_CRON_SECRET` bearer token.
5. Roll back the last deploy if the error appeared with it (Vercel → Deployments → Promote previous).

### Post-mortem template

Keep it to half a page, within two days of the incident:

- **Impact** — who was affected, for how long, which transactions were lost or duplicated.
- **Timeline** — detection time, actions taken, recovery time (use the log timestamps).
- **Root cause** — the single technical cause, not "human error".
- **Fix** — what changed to stop it recurring, with commit links.
- **Follow-ups** — monitoring or tests that would have caught it earlier.

## Capacity notes

The app is a single Node process (`server.js`) with in-process Socket.IO and an in-process PIN-attempt limiter. It does not horizontally scale as-is: multiple instances would split realtime clients and rate-limit state. If that changes, move the limiter to a shared store and use sticky sessions or a pub/sub adapter for Socket.IO first. The outbox ensures integration events survive restarts.
