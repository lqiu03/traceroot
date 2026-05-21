# Draft review for traceroot-ai/traceroot PR #565 — "Feature basic rate limiting for Python API"

> Verdict: **Request changes** (close, but not merge-ready). Core design is sound; blockers are missing tests + ingestion limit tuning. Two earlier bot findings are stale against current HEAD — noted inline so they aren't re-fixed by mistake.

---

Thanks for this — the structure is clean and the slowapi wiring is correct (decorator order, `request:`/`response:` params, `headers_enabled=True`, SHA-256-hashed API-key buckets, Redis + in-memory fallback). A few things before merge, prioritized.

### First, two corrections to the earlier automated review
- **The `RATE_LIMIT_ENABLED` flag is NOT dead.** `_build_limiter()` passes `enabled=settings.rate_limit.enabled` into the `Limiter`, and slowapi short-circuits both the middleware and the decorator path when `enabled is False`. No change needed here.
- **`retry_after` is no longer hardcoded to 60.** It now reads `ceil(exc.limit.limit.get_expiry())`. One real nuance remains (see P2 below): `get_expiry()` returns the *window size*, not the time remaining until the window resets — so it over-estimates `Retry-After`.

### P1 — blockers
1. **Tests are missing.** The PR checklist marks "added/updated tests," but the diff contains none. For rate limiting we specifically want unit tests for: `key_by_api_key` (bearer present/absent → IP fallback), `key_by_user_id` (header present/absent), the 429 handler body/`Retry-After`, and that `RATE_LIMIT_ENABLED=false` actually disables enforcement. A 429 integration test against one endpoint with a tiny limit would be ideal.
2. **Ingestion limit (`100/minute`) is too low for batched OTLP.** Ingestion here is already an async gateway (S3 write + `process_s3_traces.delay`), so the worker queue—not this decorator—protects ClickHouse. That means the decorator is edge abuse-protection, and 100/min will throttle legitimate SDK exporters: a few services on one API key with a multi-second batch flush exceed it easily. For reference, Langfuse's batched ingestion is 1,000–20,000/min (plan-tiered). Suggest raising the default to ~1,000/min and adding a one-line comment that the real ingestion safeguard is the async queue, not this limit.

### P2 — should fix
3. **Fixed-window allows ~2x burst at window edges.** slowapi defaults to `strategy="fixed-window"`; a client can send 100 at :59 and 100 at :00. Either set `strategy="moving-window"` (Redis supports it) or use a compound limit like `"100/minute;10/second"` to cap bursts.
4. **`Retry-After` semantics.** `get_expiry()` is the full window length (60 for `100/minute`), not time-to-reset. Consider `storage.get_window_stats(...)` to compute seconds-until-reset, or document the conservative over-estimate.
5. **Unrelated change bundled in.** `MembersTab.tsx` (hide self-delete) is a good fix but unrelated to rate limiting — please split into its own PR so this one stays single-purpose.
6. **`x-user-id` is client-trusted.** Fine given the Next.js-proxy-only deployment, but please add a comment noting the assumption (the Python API must not be directly internet-reachable, or per-user buckets can be bypassed by rotating the header).

### P3 — note / future
7. **slowapi does synchronous Redis I/O on `async def` endpoints** (the decorator path is sync; see slowapi#130). Acceptable at current volume since ingestion is queue-backed, but worth a tracking issue — under high ingestion QPS this blocks the event loop per request.
8. **Limits are import-time snapshots.** `@limiter.limit(settings.rate_limit.ingestion)` reads the string once at import; same for `enabled`. Fine for env-config at startup. When we move to per-plan/per-org limits later (like Langfuse/Opik), we'll need callable limits + a key derived from the validated org/project, not a static string.

Happy to pair on the tests or the limit-tuning if useful.
