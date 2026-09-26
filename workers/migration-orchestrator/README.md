# Migration Orchestrator

This autonomous Cloudflare Worker owns migration progress and database synchronization for both Super Slurper and the migration worker pool. It connects directly to PostgreSQL, polls and persists Super Slurper job progress, hands completed buckets to the File Scanner for independent verification, and activates the verified target account. For the worker pool it also converts File Scanner inventory into one-file jobs, recovers stale or aborted leases, fans GitHub dispatch intents through Cloudflare Queues, and retries bounded repair generations.

It selects active migrations in either execution mode, including `migration_workers`. File enumeration and verification remain File Scanner responsibilities; account refresh remains a Backend Orchestrator responsibility. Coordination uses durable database rows plus authenticated wake-up calls to the File Scanner and Backend Orchestrator.

## Deploy

Set `PANEL_URL` and `MIGRATION_ORCHESTRATOR_SECRET` as build environment variables, then run:

```bash
npm ci
npm run deploy
```

The deploy script verifies Wrangler authentication, creates the dispatch queue and dead-letter queue when missing, calls the authenticated configuration endpoint once, and injects only `POSTGRES_URL` into Cloudflare. Runtime URL, secret, dispatch, and peer settings are loaded from PostgreSQL.

Cron ticks enqueue a durable cycle message instead of opening PostgreSQL inside the scheduled invocation. This keeps the timer within the Free plan CPU limit; the queue consumer owns scheduling, reconciliation, and dispatch.

GitHub dispatch messages use one-message consumer invocations. Every dispatch has a durable database intent and unique worker instance ID; retries reconcile that ID before any external dispatch. Workers claim one scanner-generated file job with `FOR UPDATE SKIP LOCKED`, so two workers cannot own the same file. A job succeeds only after independently streaming source and destination SHA-256 hashes and persisting the proof; final File Scanner verification also requires that proof and the same committed destination ETag.

`GET /health` is a cheap liveness check. Authenticated `GET /status` reads durable database state, `POST /wake` queues a non-blocking cycle request for the dashboard, and `POST /run` runs one lease-guarded cycle for operator checks.
