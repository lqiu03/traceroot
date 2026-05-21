# PR #565 — proposed adjustments (drafts, NOT applied to production)

These address the P1/P2 items. Apply on top of branch `feature-basic-rate-limiting`.

## 1. Raise ingestion default + clarify it's edge protection (`backend/shared/config.py`)
```python
    enabled: bool = True
    # Public SDK ingestion endpoint — rate-limited per API key.
    # NOTE: This is edge abuse-protection only. The real ingestion safeguard is the
    # async S3 + Celery queue (process_s3_traces.delay); the worker protects ClickHouse.
    # Keep this high enough not to throttle legitimate batched OTLP exporters.
    ingestion: str = "1000/minute"
    # Authenticated dashboard API — rate-limited per user ID
    api: str = "300/minute"
```
And in `.env.example`: `# RATE_LIMIT_INGESTION=1000/minute`

## 2. Cap bursts with moving-window (`backend/rest/rate_limit.py`, in `_build_limiter`)
```python
    return Limiter(
        key_func=get_remote_address,
        enabled=settings.rate_limit.enabled,
        storage_uri=storage_uri,
        strategy="moving-window",   # avoid fixed-window 2x burst at window edges
        headers_enabled=True,
        in_memory_fallback_enabled=True,
        swallow_errors=False,
    )
```
(Alternative if you prefer to keep fixed-window: use compound limits like
`"1000/minute;50/second"` in config to bound bursts.)

## 3. Correct Retry-After to time-until-reset (`backend/rest/rate_limit.py`)
```python
import time
from limits import RateLimitItem  # for type clarity only

def rate_limit_exceeded_handler(request, exc):
    retry_after = 60
    try:
        item = exc.limit.limit  # limits.RateLimitItem
        # get_window_stats returns (reset_epoch_seconds, remaining)
        reset_at, _ = limiter._limiter.get_window_stats(item, *exc.limit.key_func(request))
        retry_after = max(1, ceil(reset_at - time.time()))
    except Exception:
        try:
            retry_after = ceil(exc.limit.limit.get_expiry())  # window size fallback
        except Exception:
            pass
    # ... unchanged JSONResponse ...
```
(If wiring `get_window_stats` is awkward, keep `get_expiry()` and just add a comment that
it is a conservative over-estimate of the wait.)

## 4. Document the x-user-id trust assumption (`backend/rest/rate_limit.py`)
```python
def key_by_user_id(request: Request) -> str:
    """Bucket by authenticated user ID.

    SECURITY ASSUMPTION: x-user-id is set by the trusted Next.js proxy AFTER auth.
    The Python REST API must NOT be directly internet-reachable; otherwise per-user
    buckets can be bypassed by rotating this header. See deployment topology docs.
    """
```

## 5. Minimal test scaffold (`backend/tests/rest/test_rate_limit.py` — NEW)
```python
import hashlib
from types import SimpleNamespace
from rest.rate_limit import key_by_api_key, key_by_user_id

def _req(headers): return SimpleNamespace(headers=headers, client=SimpleNamespace(host="1.2.3.4"))

def test_key_by_api_key_hashes_bearer():
    raw = "secret-key"
    digest = hashlib.sha256(raw.encode()).hexdigest()[:24]
    assert key_by_api_key(_req({"authorization": f"Bearer {raw}"})) == f"apikey:{digest}"

def test_key_by_api_key_falls_back_to_ip():
    assert key_by_api_key(_req({})).startswith("ip:")

def test_key_by_user_id_uses_header():
    assert key_by_user_id(_req({"x-user-id": "u_42"})) == "user:u_42"

def test_key_by_user_id_falls_back_to_ip():
    assert key_by_user_id(_req({})).startswith("ip:")

# Integration: set RATE_LIMIT_API="2/minute", hit a read endpoint 3x, assert 3rd is 429
# with a Retry-After header; then set RATE_LIMIT_ENABLED=false and assert no 429.
```

## 6. Split out MembersTab.tsx
Move the `MembersTab.tsx` self-delete change to its own PR; keep #565 backend-only.
