# Bug Report

- [High-priority findings](#high-priority-findings)
  1. [`/trials/:id/analyze` accepts invalid `focus` values](#invalid-focus-values)
  2. [Trial route parameters are not validated at the route boundary](#trial-route-parameters-not-validated)
  3. [Search scoring mutates shared trial objects by adding `_score`](#search-scoring-mutates-shared-objects)
  4. [`getTrialSummary()` assumes `responseRate` is never `null`](#gettrialsummary-null-response-rate)
  5. [OpenAI analysis stream has no timeout or client-disconnect cancellation](#openai-stream-no-timeout-or-cancellation)
- [Medium-priority findings](#medium-priority-findings)
  1. [Trial services return shared mutable objects from memory caches](#trial-services-return-shared-mutable-objects)
  2. [Analysis prompt accepts unbounded trial field lengths](#analysis-prompt-unbounded-field-lengths)
  3. [`startDate` sorting applies descending order twice](#startdate-sorting-descending-twice)
  4. [`keyFindings` search only matches exact array entries](#keyfindings-search-exact-array-entries)
- [Lower-priority findings](#lower-priority-findings)
  - [Whitespace-only search is not normalized](#whitespace-only-search-not-normalized)
  - [Missing `.gitignore`](#missing-gitignore)
  - [Package lock](#package-lock)
- [Future considerations](#future-considerations)
  - [Paid AI analysis endpoint has no rate limiting or authorization](#paid-ai-endpoint-no-rate-limiting-or-authorization)

<a id="review-guide"></a>

## Review guide

- **High priority:** Can cause security, reliability, correctness, data-integrity, type-safety, or cost-control problems in production.
- **Medium priority:** Defensive/hardening concerns or require another bug/future code path to become user-visible.
- **Lower priority:** Project-hygiene issues that are worth fixing but are less likely to cause immediate production impact.
- **Future considerations:** Not bugs in the strict sense, but production-readiness gaps I would block a PR on before exposing this service externally.

<a id="high-priority-findings"></a>

## High-priority findings
<a id="invalid-focus-values"></a>

### 1. `/trials/:id/analyze` accepts invalid `focus` values

**Type:** Security, correctness, type safety  
**Location:** `starter/src/routes/trials.ts > POST /:id/analyze`

#### Summary

The route accepts `focus` as a string and then casts it to `any`, bypassing the type system.

```ts
const { focus } = req.body;
await streamAnalysis(trial, focus as any, res);
```

#### How to reproduce / evidence

```sh
curl -X POST 'http://localhost:3000/trials/NCT-003/analyze' \
  --header 'Content-Type: application/json' \
  --data '{
    "focus": "random"
  }'
```

#### Production impact

- Invalid requests can trigger expensive OpenAI calls.
- Malformed prompts that exclude the intended focused instructions can produce low-quality or misleading analysis.

#### Suggested fix

Validate the request body before calling `streamAnalysis()` using Zod, consistent with route-boundary validation elsewhere.

```ts
const analyzeRequestSchema = z
  .object({
    focus: z.enum(["safety", "efficacy", "competitive"]),
  })
  .strict();

const parsedBody = analyzeRequestSchema.safeParse(req.body);
if (!parsedBody.success) {
  res.status(400).json({ error: "Invalid focus" });
  return;
}

await streamAnalysis(trial, parsedBody.data.focus, res);
```

#### Suggested test

```http
POST /trials/NCT-001/analyze
{ "focus": "not-real" }
```

Expected result: `400 Bad Request`.

#### Tradeoffs / alternatives

None noted.

---

<a id="trial-route-parameters-not-validated"></a>

### 2. Trial route parameters are not validated at the route boundary

**Type:** Security, correctness, type safety  
**Location:** `starter/src/routes/trials.ts`

#### Summary

The trials routes cast `req.query` directly into service inputs and assume route params are strings. Express query parameters and params can be arrays or malformed values, which can cause incorrect behavior, runtime errors, and TypeScript build failures.

```ts
phase: phase as string | undefined,
minEnrollment: minEnrollment ? Number(minEnrollment) : undefined,
const trial = getTrialById(req.params.id!);
```

#### How to reproduce / evidence

Examples that should be rejected or normalized:

```http
GET /trials?order=sideways
GET /trials?phase=IV
GET /trials?minEnrollment=abc
GET /trials?sponsor=Merck&sponsor=Pathos
GET /trials?search=%20%20%20
```

The `id` routes also fail strict TypeScript with current Express types because `req.params.id` is treated as `string | string[]`, not definitely `string`.

#### Production impact

- Malformed query params, such as arrays, can cause `500` errors.
- Invalid `order` values silently behave like `desc`.
- Invalid `sort` values silently no-op.
- `minEnrollment=abc` becomes `NaN`, and the filter is silently ignored.
- Whitespace-only `search` can produce surprising empty results.
- Untyped route params contribute to the project not type-checking.

#### Suggested fix

Validate and normalize route inputs with Zod before calling services. Type route params explicitly.

```ts
import { z } from "zod";

const trialQuerySchema = z.object({
  phase: z.enum(["I", "II", "III"]).optional(),
  status: z.enum(["recruiting", "completed", "terminated"]).optional(),
  minEnrollment: z.string().regex(/^\d+$/).transform(Number).optional(),
  sponsor: z.string().trim().min(1).optional(),
  search: z.string().trim().min(1).optional(),
  sort: z.enum(["startDate", "enrollment", "adverseEventRate"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
});

const trialParamsSchema = z.object({
  id: z.string().min(1).max(128),
});
```

```ts
router.get("/:id", (req: Request<{ id: string }>, res: Response) => {
  const parsed = trialParamsSchema.safeParse(req.params);
  if (!parsed.success) return res.status(400).json({ error: "Invalid trial id" });

  const trial = getTrialById(parsed.data.id);
  ...
});
```

#### Suggested test

```ts
expect(GET "/trials?order=sideways").toReturn(400);
expect(GET "/trials?minEnrollment=abc").toReturn(400);
expect(GET "/trials?phase=IV").toReturn(400);
expect(GET "/trials?search=%20%20%20").toReturn(400);
expect(npmRunBuild()).toPass();
```

#### Tradeoffs / alternatives

Whitespace-only search could also be normalized to `undefined` instead of rejected.

---

<a id="search-scoring-mutates-shared-objects"></a>

### 3. Search scoring mutates shared trial objects by adding `_score`

**Type:** Data integrity, race condition, type safety  
**Location:** `starter/src/services/trial-service.ts > listTrials()`

#### Summary

`listTrials()` mutates the underlying trial objects by adding a request-specific `_score` property.

```ts
// starter/src/services/trial-service.ts
(t as any)._score = score;
```

#### How to reproduce / evidence

Call `listTrials()` with a search query, then inspect the same trial through another code path such as `getTrialById()`.

#### Production impact

- Search requests permanently modify shared in-memory state.
- `_score` can leak into future API responses, including `GET /trials/:id`.
- Concurrent requests can observe request-specific state from another request.
- The `ClinicalTrial` type becomes inaccurate because responses contain fields not declared in the interface.

#### Suggested fix

Do not write `_score` onto the trial object. Store scores separately.

```ts
const scored = results
  .map((trial) => ({ trial, score: calculateSearchScore(trial, query) }))
  .filter(({ score }) => score > 0);

results = scored.map(({ trial }) => trial);
```

#### Suggested test

```ts
listTrials({ search: "prostate" });
expect(getTrialById("NCT-001")).not.toHaveProperty("_score");
```

#### Tradeoffs / alternatives

None noted.

---

<a id="gettrialsummary-null-response-rate"></a>

### 4. `getTrialSummary()` assumes `responseRate` is never `null`

**Type:** Correctness, type safety  
**Location:** `starter/src/services/analysis-service.ts > getTrialSummary()`

#### Summary

`ClinicalTrial.responseRate` is typed as `number | null`, but `getTrialSummary()` uses a non-null assertion.

```ts
`Current response rate: ${trial.responseRate!.toFixed(1)}%.`
```

Calling the `GET /trials/:id/summary` endpoint for a trial with a `null` response rate throws a runtime `TypeError`.

#### How to reproduce / evidence

```sh
curl -X GET 'http://localhost:3000/trials/NCT-003/summary'
```

This returns a `500` error:

```sh
TypeError: Cannot read properties of null (reading 'toFixed')
```

#### Production impact

Some valid trials return `500` errors. Any trial without mature efficacy data can break the summary endpoint.

#### Suggested fix

Explicitly handle `null` response rates.

```ts
const responseRateText =
  trial.responseRate === null
    ? "Not yet available"
    : `${trial.responseRate.toFixed(1)}%`;

`Current response rate: ${responseRateText}.`
```

#### Suggested test

```ts
const trial = getTrialById("NCT-003")!;
const summary = getTrialSummary(trial);
expect(summary.summary).toContain("Not yet available");
```

#### Tradeoffs / alternatives

None noted.

---

<a id="openai-stream-no-timeout-or-cancellation"></a>

### 5. OpenAI analysis stream has no timeout or client-disconnect cancellation

**Type:** Reliability, performance, cost control  
**Location:** `starter/src/routes/trials.ts > POST /:id/analyze` and `starter/src/services/analysis-service.ts > streamAnalysis()`

#### Summary

`streamAnalysis()` starts an OpenAI stream but does not enforce a timeout or cancel the upstream request if the client disconnects.

#### How to reproduce / evidence

Start an analysis request, then close the client connection before the stream finishes. The server has no `req.on("close")` handling and does not pass an abort signal to the AI call. 

#### Production impact

- Abandoned requests can continue consuming OpenAI tokens.
- Long-running requests can hold server resources indefinitely.
- Clients and servers have no clear upper bound for analysis duration.

#### Suggested fix

Create an `AbortController` per request, abort it on client disconnect or timeout, and pass the signal into the AI SDK call if supported.

```ts
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 60_000);
req.on("close", () => controller.abort());

await streamAnalysis(trial, focus, res, controller.signal);
clearTimeout(timeout);
```

#### Suggested test

Mock `streamText()`, simulate a client disconnect, and assert the abort signal is triggered.

#### Tradeoffs / alternatives

Timeouts must be high enough for legitimate model latency but low enough to cap cost and resource usage.

---

<a id="medium-priority-findings"></a>

## Medium-priority findings

<a id="trial-services-return-shared-mutable-objects"></a>

### M1. Trial services return shared mutable objects from memory caches

**Type:** Data integrity, race condition  
**Location:** `starter/src/services/trial-service.ts > getTrialById()` and `listTrials()`

#### Summary

`getTrialById()` and `listTrials()` return the exact objects stored in memory caches.

#### How to reproduce / evidence

Mutating a returned trial object also mutates the shared process-wide cached object.

#### Production impact

Any future internal code that modifies a returned trial object will mutate shared process-wide state, causing cross-request contamination.

#### Suggested fix

Return immutable data or defensive copies.

```ts
export function getTrialById(id: string): ClinicalTrial | undefined {
  const trial = trialCache.get(id);
  return trial ? structuredClone(trial) : undefined;
}
```

#### Suggested test

```ts
const trial = getTrialById("NCT-001")!;
trial.name = "mutated";
expect(getTrialById("NCT-001")!.name).toBe("AURORA-1: Pocenbrodib in mCRPC");
```

#### Tradeoffs / alternatives

None noted.

---

<a id="analysis-prompt-unbounded-field-lengths"></a>

### M2. Analysis prompt accepts unbounded trial field lengths

**Type:** Performance, cost control, reliability, input validation  
**Location:** `starter/src/services/analysis-service.ts > buildPrompt()` / `streamAnalysis()`

#### Summary

`buildPrompt()` directly interpolates trial fields into the LLM prompt. Fields such as `id`, `name`, `primaryEndpoint`, `indication`, and `keyFindings` have no length boundaries, so one oversized value can create a very large prompt.

#### How to reproduce / evidence

```ts
const trial = {
  ...getTrialById("NCT-001")!,
  id: "NCT-" + "x".repeat(100_000),
};

await streamAnalysis(trial, "safety", res);
```

The full `id` is included in the prompt.

#### Production impact

- Can exceed the model context window and fail.
- Can significantly increase OpenAI input token cost and latency.
- If trial data becomes user-controllable, this can become a denial-of-wallet / denial-of-service vector.

#### Suggested fix

Use Zod, which is already available in `package.json`, to validate and bound prompt-facing trial data before building the prompt.

```ts
const promptTrialSchema = z.object({
  id: z.string().max(128),
  name: z.string().max(256),
  sponsor: z.string().max(128),
  indication: z.string().max(256),
  primaryEndpoint: z.string().max(512),
  keyFindings: z.array(z.string().max(512)).max(10),
});
```

Depending on product behavior, either reject oversized trial data or transform/truncate it before calling `streamText()`.

#### Suggested test

```ts
const trial = { ...getTrialById("NCT-001")!, id: "x".repeat(100_000) };
expect(() => buildPromptForTest(trial, "safety")).toThrow();
```

#### Tradeoffs / alternatives

Rejecting oversized values is safer, while truncating is more tolerant but may remove useful clinical context.

---

<a id="startdate-sorting-descending-twice"></a>

### M3. `startDate` sorting applies descending order twice

**Type:** Data integrity  
**Location:** `starter/src/services/trial-service.ts > listTrials()`

#### Summary

`listTrials()` claims the default ordering is descending by `startDate`, but the `startDate` comparator is already reversed and then the order-handling logic reverses it again. This causes API consumers to receive results in the opposite order from what they requested.

#### How to reproduce / evidence

Found through the failing unit test:

```txt
src/__tests__/trials.test.ts > trial-service > listTrials > sorts by startDate
```

Also reproducible through the trials endpoint:

```sh
curl -X GET 'http://localhost:3000/trials?sort=startDate&order=asc'
```

#### Production impact

Users and API clients can receive trials in the opposite order from what they requested. This can lead to misleading dashboards, or users not seeing the most recent trials where expected.

#### Suggested fix

Use a canonical ascending comparator inside the switch, then apply `asc` / `desc` exactly once.

```ts
// starter/src/services/trial-service.ts > listTrials()
case "startDate":
  cmp = new Date(a.startDate).getTime() - new Date(b.startDate).getTime();
  break;
```

#### Suggested test

Add or update tests to verify both ascending and descending `startDate` sorting.

#### Tradeoffs / alternatives

None noted.

---

<a id="keyfindings-search-exact-array-entries"></a>

### M4. `keyFindings` search only matches exact array entries

**Type:** Correctness  
**Location:** `starter/src/services/trial-service.ts > listTrials()`

#### Summary

The search logic uses array `.includes(query)` on `keyFindings`. This only returns `true` if an entire key finding exactly equals the lowercase query string. It does not perform substring matching and is not case-insensitive.

#### How to reproduce / evidence

```sh
curl -X GET 'http://localhost:3000/trials?search=dose-proportional'
```

This returns no results, even though it should return trial `NCT-003`.

#### Production impact

Users searching for clinically relevant terms found only inside `keyFindings` may receive no results even when matching trials exist.

#### Suggested fix

Use `.some()` and normalize each finding before checking for the query substring.

```ts
const keyFindingsMatch = t.keyFindings.some((finding) => {
  return finding.toLowerCase().includes(query);
});

if (keyFindingsMatch) score += 2;
```

#### Suggested test

```ts
const result = listTrials({ search: "dose-proportional" });
expect(result.trials.map((t) => t.id)).toContain("NCT-003");
```

#### Tradeoffs / alternatives

None noted.

---

<a id="lower-priority-findings"></a>

## Lower-priority findings

<a id="whitespace-only-search-not-normalized"></a>

### L1. Whitespace-only search is not normalized

**Type:** Correctness, usability  
**Location:** `starter/src/routes/trials.ts > GET /trials` and `starter/src/services/trial-service.ts > listTrials()`

#### Summary

Search input is passed directly into `listTrials()` without trimming. A whitespace-only search value is truthy, so the service searches for whitespace and can return no results.

```ts
const query = filters.search.toLowerCase();
```

#### How to reproduce / evidence

```http
GET /trials?search=%20%20%20
```

#### Production impact

Users can receive empty results for an effectively blank search, instead of seeing all trials or a validation error.

#### Suggested fix

Trim search at the route boundary using Zod. Either reject blank search or normalize it to `undefined`.

```ts
search: z.string().trim().min(1).optional()
```

#### Suggested test

```ts
expect(GET "/trials?search=%20%20%20").toReturn(400);
// or, if normalized:
expect(GET "/trials?search=%20%20%20").toEqual(GET "/trials");
```

#### Tradeoffs / alternatives

Rejecting blank search is explicit; normalizing it to no filter is more user-friendly.

---

<a id="missing-gitignore"></a>

### L2. Missing `.gitignore`

Important because of .env, but not a runtime app bug.

<a id="package-lock"></a>

### L3. Package lock

Good reproducibility hygiene.

---

<a id="future-considerations"></a>

## Future considerations

<a id="paid-ai-endpoint-no-rate-limiting-or-authorization"></a>

### F1. Paid AI analysis endpoint has no rate limiting or authorization

**Type:** Security, Performance
**Location:** `starter/src/routes/trials.ts > POST /:id/analyze`

#### Summary

Anyone who can reach the service can repeatedly call `/trials/:id/analyze`, which triggers a paid OpenAI request each time. 

#### How to reproduce / evidence

```sh
for i in {1..100}; do
  curl -X POST 'http://localhost:3000/trials/NCT-001/analyze' \
    -H 'Content-Type: application/json' \
    -d '{"focus":"safety"}' &
done
```

All 100 requests are served and each one bills OpenAI.

#### Production impact

- Unauthenticated callers can drive up OpenAI spend.
- Burst traffic can exhaust upstream model rate limits and degrade service for legitimate users.
- No per-tenant accounting once the service has paying customers.

#### Suggested direction

1. **Authentication first.** Identity is the right key for limits and billing attribution; raw IP is a stopgap. An API-key or session-based identity gate belongs in front of any paid endpoint.
2. **Per-identity rate limiting.** A token bucket or sliding window keyed on the authenticated principal, sized to internal analyst workflows but capping bursts. Limits should be enforced in a shared store (e.g. Redis) so they hold across replicas.
3. **Cost guardrails independent of rate limits.** Per-tenant daily/monthly spend caps, plus a circuit breaker on the OpenAI client when error rates or latency spike.
4. **Observability.** Log per-request token usage and emit a metric so abuse and cost regressions are visible before the bill arrives.

#### Tradeoffs / alternatives

- An in-process per-IP limiter is trivial to add and would mitigate the most obvious abuse, but it doesn't survive horizontal scaling and is bypassable behind NAT or a proxy. I'd avoid shipping it as the "solution" because it creates a false sense of safety.
- Pushing this entirely to an API gateway (e.g. Kong, Cloudflare, AWS API Gateway) is also viable and may be the right call depending on the deployment topology; the application would then only enforce business-level quotas.
