# ADR: Batch Re-Analysis Architecture

## Decision

Choose **Option A: In-Process Queue with Database-Backed State**.

We're not rejecting real queues. We just don't need Redis, a second process, and all the new ops surface area yet. The DB stays the source of truth. When load proves it's worth it, we swap the executor.

## Rationale

The current scale does not justify adding Redis, a second worker process, queue health checks, and new deployment concerns. The system is expected to handle ~500 trials and 2–3 batch runs per week. Each analysis takes 15–45 seconds, so a sequential run would take roughly 2–6 hours. With conservative concurrency around 5, wall-clock time should usually be closer to 25–75 minutes.

That is acceptable if we keep the executor bounded, persist progress incrementally, and avoid holding large payloads in memory.

Cost control, API health, and recovery matter more than OpenAI's 500 req/min rate limit right now. Before starting a batch, the service should estimate expected cost from trial count, model, and prompt size, then reject or require confirmation for oversized runs against the ~$200/month budget.

The key design choice is durable state:

- `batches` track the batch request and status.
- `batch_jobs` track per-trial progress, attempts, errors, and locks.
- `analysis_results` store queryable outputs.

If scale grows, we can replace the executor with BullMQ, pg-boss, or a dedicated worker without changing the API contract or stored result model.

## Tradeoffs

The downside is that batch work shares the same Node.js process as the API. Even though OpenAI calls are mostly I/O-bound, concurrency must be capped and observable. We should track API latency, event-loop lag, OpenAI errors, batch duration, and cost.

The in-memory queue is not durable by itself. Jobs need explicit DB-backed states plus a lease field such as `locked_at`. On startup, the service should re-enqueue pending jobs and reclaim stale `in_progress` jobs whose lock expired.

We should also prevent duplicate expensive work. `POST /batch/analyze` should accept an idempotency key or reject duplicate active batches with the same filter/focus.

## Strongest Argument for Option B

Option B gives cleaner isolation between API traffic and background work. A real queue with a separate worker provides stronger retry semantics, backpressure, dead-letter handling, and horizontal scalability.

B wins only if batches become frequent, latency-sensitive, or we need real dead-letter/compliance behavior.

## What Would Change This Decision

I would move to Option B if:

- batches grow materially beyond ~500 trials,
- batches overlap with peak API traffic,
- API latency or event-loop lag worsens during runs,
- we need multiple workers,
- retry/dead-letter behavior becomes compliance-critical,
- analysis becomes CPU-heavy,
- or budget/rate-limit enforcement needs centralized throttling.

## Implementation Plan

1. **Define the durable schema**
   - `batches`: requester, filter/focus, status, timestamps, idempotency key.
   - `batch_jobs`: batch ID, trial ID, status, attempts, error, `locked_at`, timestamps.
   - `analysis_results`: batch ID, trial ID, model, prompt version, raw output, structured risk fields, timestamps.

2. **Add batch APIs**
   - `POST /batch/analyze` creates a batch and per-trial jobs, estimates cost, applies idempotency, and returns a batch ID.
   - `GET /batch/:id/progress` reads DB-backed counts for polling.
   - Poll for now. Add SSE only when the UI actually needs live updates.

3. **Build a controlled in-process executor**
   - Process jobs with bounded concurrency, initially around 5.
   - Use per-job timeouts and bounded retries.
   - Fail individual jobs independently without failing the whole batch.
   - Persist status after each job; never rely on memory as the source of truth.

4. **Add recovery, guardrails, and observability**
   - On startup, re-enqueue pending jobs and reclaim stale locked jobs.
   - Enforce rate-limit and budget guardrails before and during execution.
   - Monitor API latency, event-loop lag, batch duration, failure rate, and cost.

## Consequences

Keep it small and obvious at this scale. Make batch analysis durable in the DB, observable, cost-aware, and trivial to rip out later for a real queue when the numbers say so.
