# ADR: Batch Re-Analysis Architecture

## Decision

Choose **Option A: In-Process Queue with Database-Backed State**.

This is not a claim that external queues are unnecessary. It is a scoped decision for the workload described: one Node.js service, ~500 trials within 6 months, and 2–3 batch runs per week. I would make the database the durable source of truth and keep the executor small and replaceable, rather than adding a second process and queue infrastructure before the workload proves it needs them.

## Rationale

A full 500-trial batch would take roughly 2–6 hours sequentially, or about 25–100 minutes with conservative concurrency of 3–5. That is long-running background work, but it is not high-throughput queue processing. At that concurrency, OpenAI's 500 requests/minute limit is not the bottleneck. The more important risks are duplicate expensive runs, unclear per-trial failures, lost progress after restart, unbounded spend, and queryability of stored results.

Option A can address those risks directly if the in-memory queue is treated only as an executor, not as product state. The durable model should live in the database:

- `batches` tracks the request, filters, focus, prompt/model version, estimated cost, status, and idempotency key.
- `batch_jobs` tracks one row per trial, including status, attempts, error summary, and lease fields for recovery.
- `analysis_results` stores the raw AI output plus normalized searchable fields, such as safety-risk flags.

The executor would claim pending jobs with a lease, process them with bounded concurrency, and persist status after every trial. If the process crashes, the in-memory queue is lost, but no product state is lost: on restart, the service can requeue pending jobs and reclaim stale `in_progress` jobs. Result writes should be idempotent with a uniqueness constraint such as `(batch_id, trial_id, prompt_version)`.

This fits Node because the work is mostly network I/O to OpenAI, not CPU-heavy computation. I would still cap concurrency initially at 3–5, add per-job timeouts, bounded retries with backoff, and no retries for deterministic validation errors. The batch should continue when individual trials fail.

The UI progress requirement does not require an external queue. `GET /batch/:id/progress` can read DB-backed counts for queued, running, succeeded, failed, skipped, and cancelled jobs. If the UI needs lower-latency updates, an SSE endpoint can publish progress from the same database state.

## Strongest Argument for Option B

The strongest argument for Option B is isolation. A separate worker process gives batch analysis its own lifecycle, concurrency settings, memory profile, retry behavior, and monitoring. If batch execution misbehaves, the analyst-facing API is less likely to be affected. It also provides a cleaner path to horizontal scaling, dead-letter queues, and richer backpressure.

That is a real advantage. If Pathos already had worker infrastructure, or if batch analysis were frequent enough to become a core operational workload, I would be more inclined to choose B immediately.

## Why I Still Choose A

For the stated scale, I would rather spend the first increment of complexity on durable state, cost controls, idempotency, result storage, and observability than on new infrastructure. Option A keeps the system easier to run locally and deploy: one service, one database-backed state model, and shared analysis code for both `/trials/:id/analyze` and batch jobs.

The migration path is also clean. If the in-process executor becomes the bottleneck, the API contract and database schema can stay mostly unchanged while the executor is replaced with pg-boss, BullMQ, or a dedicated worker. In other words, Option A should be implemented as a replaceable execution strategy, not as a pile of timers hidden inside request handlers.

## What Would Change This Decision

I would move to Option B if any of the following became true:

- batches grew materially beyond 500 trials or needed to complete much faster;
- multiple batches needed to run concurrently;
- API latency, event-loop lag, memory, or connection pool contention worsened during batches;
- the service moved to multiple horizontally scaled API instances;
- retry/dead-letter behavior became compliance-critical;
- analysis became CPU-heavy rather than mostly I/O-bound;
- or the organization already operated queue/worker infrastructure as a standard platform primitive.

## Implementation Plan

1. **Extract shared analysis code** for prompt building, OpenAI calls, timeouts, token/cost accounting, and result normalization. Preserve the existing streaming endpoint for ad-hoc analysis.
2. **Add durable tables**: `batches`, `batch_jobs`, and `analysis_results`, including idempotency, prompt/model versioning, job attempts, errors, and structured fields for safety-risk search.
3. **Add batch APIs**: `POST /batch/analyze` to validate filters, estimate cost, create jobs, and return a batch ID; `GET /batch/:id/progress` for DB-backed status; optionally `POST /batch/:id/cancel` and SSE progress updates.
4. **Build the bounded executor** on service startup. Claim jobs with leases, process at concurrency 3–5, persist after each job, recover stale jobs on restart, and continue the batch after per-trial failures.
5. **Add guardrails and observability** for OpenAI errors, token usage, cost, job duration, failure rate, API latency, memory, and event-loop lag. Pause or reduce concurrency if API health degrades.

## Consequences

This keeps the first version boring and inspectable while meeting the stated requirements. The tradeoff is that batch work still shares a process with the API, so limits and monitoring are mandatory. If those limits start constraining the product, the durable schema and API contract provide a straightforward path to Option B.
