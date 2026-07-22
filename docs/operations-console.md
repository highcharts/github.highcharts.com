# Operations Console — Normative Specification

> **Development-only.** The operations console is a secured internal tool for Highsoft
> engineers. It is disabled by default, must never be exposed outside a controlled
> development environment, and is explicitly out of scope for staging and production
> rollout.

All requirements in this document are normative. "Must" and "must not" state
mandatory behaviour. "Should" and "should not" state strong recommendations.
"May" states permitted behaviour.

---

## Table of contents

1. [Purpose, operator journeys, and non-goals](#1-purpose-operator-journeys-and-non-goals)
2. [Topology and trust boundaries](#2-topology-and-trust-boundaries)
3. [Enablement and configuration](#3-enablement-and-configuration)
4. [Route namespace and HTTP routes](#4-route-namespace-and-http-routes)
5. [Shared-token login and session contract](#5-shared-token-login-and-session-contract)
6. [Security headers, CSP, and browser restrictions](#6-security-headers-csp-and-browser-restrictions)
7. [Rate limits](#7-rate-limits)
8. [Read API — aggregate snapshot](#8-read-api--aggregate-snapshot)
9. [Service snapshot model](#9-service-snapshot-model)
10. [Correlation, activity, spans, and failures](#10-correlation-activity-spans-and-failures)
11. [Health semantics](#11-health-semantics)
12. [Cache operation semantics](#12-cache-operation-semantics)
13. [Cache operation transport and result schema](#13-cache-operation-transport-and-result-schema)
14. [Audit and logging](#14-audit-and-logging)
15. [Error contract and validation bounds](#15-error-contract-and-validation-bounds)
16. [UI, information architecture, and accessibility](#16-ui-information-architecture-and-accessibility)
17. [Compatibility and schema versioning](#17-compatibility-and-schema-versioning)
18. [Verification gates](#18-verification-gates)
19. [Development rollout, rollback, and abort criteria](#19-development-rollout-rollback-and-abort-criteria)
20. [Non-normative provenance](#20-non-normative-provenance)

---

## 1. Purpose, operator journeys, and non-goals

### Purpose

The operations console is a development-environment tool that lets trusted
Highsoft engineers:

1. **Assess system health** — see the overall and per-service health status, active
   queue pressure, cache condition, and recent failure evidence at a glance.
2. **Survey recent request activity** — browse bounded recent public file requests
   and distinguish outcomes, latency, failures, and cache or build behaviour.
3. **Trace one request** — locate a failed or slow request by time, resource, or
   correlation identifier, and reach an initial diagnosis — affected service,
   processing stage, resolved commit, selected build mode, and sanitized failure
   explanation.
4. **Maintain caches** — inspect downloader and builder cache summaries and commit
   entries; evict one commit from either or both services; purge expired entries;
   clear an entire service cache.

### Operator acceptance

An informal Highsoft engineer review must affirm that, without separate instructions, an engineer can:

- Judge system health and determine whether action is needed.
- Browse activity and isolate a specific request.
- Trace a request to the affected service and stage, reaching a useful initial diagnosis.
- Understand and complete every supported cache-maintenance action.

Formal signed acceptance is required before enabling the console in any
development environment (see §19).

### Non-goals

The following are explicitly out of scope:

- Staging or production rollout.
- Corporate SSO, MFA, RBAC, per-engineer identity, or reliable non-repudiation.
- Build submission, retry, or output inspection.
- Full log access, artifact inspection, root-cause tooling beyond initial diagnosis.
- CPU profiling, detailed host telemetry, or durable observability.
- Console-based configuration, environment-variable, token, or secret management.
- Deployment or image-version visibility.
- Persistent audit history.
- New public ports, listeners, sidecars, fourth services, databases, Redis, event
  buses, metrics platforms, OpenTelemetry, or durable telemetry stores.

---

## 2. Topology and trust boundaries

The existing three-process topology is unchanged:

| Service | Role | Public port |
|---|---|---|
| **Router** | Accepts public requests; hosts the same-origin operations console UI and browser-facing API | 8080 |
| **Downloader** | Internal only; resolves refs, fetches and caches source trees; exposes authenticated internal `/v1` ops endpoints | None |
| **Builder** | Internal only; compiles sources; exposes authenticated internal `/v1` ops endpoints | None |

**Trust rules:**

- The browser never contacts the downloader or builder directly.
- The browser never receives the internal bearer token.
- Downloader and builder internal ops endpoints are additive, bearer-protected,
  and reachable only from a private network.
- Only the router publishes a port.
- The existing `GET /health` endpoint on each service remains minimal and
  unauthenticated. Console telemetry, cache details, and operational state exist
  only under the bearer-protected `/v1/ops/*` paths.
- Existing unauthenticated mutation paths that are equivalent to cache cleanup
  (such as a public `/cleanup?true`) must not remain an authorization bypass
  when the console is enabled.

---

## 3. Enablement and configuration

### Config variables

| Variable | Required when | Description |
|---|---|---|
| `OPS_CONSOLE_ENABLED` | Always evaluated | Must be exactly the string `true` to enable the console. Any other value or absence disables it. |
| `OPS_CONSOLE_TOKEN_VERIFIER` | Console enabled | Domain-separated SHA-256 verifier derived from the shared admin token. Stored outside source control. Validated at startup. |
| `OPS_CONSOLE_ORIGIN` | Console enabled | The single exact external Origin that the console accepts for all state-changing requests and for login. |
| `OPS_CONSOLE_ALLOW_HTTP_LOOPBACK` | Optional | When exactly `true`, allows HTTP when the configured Origin is a loopback address. All other HTTP combinations fail startup. |

`OPS_CONSOLE_TRUSTED_PROXY` is not supported. Setting it to any non-blank value aborts startup.

`OPS_CONSOLE_MTLS_PORT`, `OPS_CONSOLE_MTLS_KEY_PATH`, `OPS_CONSOLE_MTLS_CERT_PATH`, and `OPS_CONSOLE_MTLS_CA_PATH` are retired and unsupported. Setting any to a non-blank value aborts startup.

### Disabled behaviour (default)

When `OPS_CONSOLE_ENABLED` is absent or not exactly `true`:

- The router starts normally.
- Every `/_ops/*` path returns 404.
- No console calls are made to internal services.
- One sanitized status event is emitted to stdout.
- `OPS_CONSOLE_TOKEN_VERIFIER` is not required or validated.

### Enabled behaviour — fail-closed startup

When `OPS_CONSOLE_ENABLED` is exactly `true`, startup **must** fail if any of
the following conditions apply:

- `OPS_CONSOLE_TOKEN_VERIFIER` is missing or malformed.
- `OPS_CONSOLE_ORIGIN` is missing or invalid.
- `OPS_CONSOLE_TRUSTED_PROXY` is set to any non-blank value.
- `OPS_CONSOLE_ALLOW_HTTP_LOOPBACK=true` is set but the Origin is not a loopback address.
- `OPS_CONSOLE_ALLOW_HTTP_LOOPBACK` is `true` and the Origin scheme is `https:`.

`NODE_ENV` alone must never enable the console.

### Client IP and rate limiting

Node.js does not trust any `Forwarded` or `X-Forwarded-*` header and does not
derive a client IP from proxy headers. Login rate limiting is process-wide only:
a single global counter of 30 attempts per 15 minutes. There is no per-source
or per-IP bucket at the application layer.

The audit `source` field is always `null`; no network identity is trusted and no
client or proxy IP is attributed. Operators requiring per-client-IP rate limiting must
enforce it at the proxy layer before requests reach the router.

---

The `/_ops/` namespace is reserved from all public branch/file routes. Obscurity
is not a security control; the namespace reservation is operational.

Console assets and all `/_ops/*` routes must mount **before** public
wildcard/static routes in the router.

### Browser-facing routes

| Method | Path | Authenticated | Purpose |
|---|---|---|---|
| `GET` | `/_ops/` | Yes | UI shell |
| `GET` | `/_ops/login` | No | Login page |
| `POST` | `/_ops/api/v1/session` | No (creates session) | Validate shared token and create session |
| `GET` | `/_ops/api/v1/session` | Yes | Bootstrap current session |
| `DELETE` | `/_ops/api/v1/session` | Yes | Revoke current session and clear cookie |
| `GET` | `/_ops/api/v1/snapshot` | Yes | Aggregate snapshot |
| `POST` | `/_ops/api/v1/cache-operations` | Yes | Cache mutation |

### Internal routes (per downloader and builder)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/ops/snapshot` | Service snapshot |
| `POST` | `/v1/ops/cache-operations` | Cache operation |

All other existing endpoints are unchanged.

### Caching

Every `/_ops/*` response — HTML, assets, and API — must carry:

```http
Cache-Control: no-store
```

No console CORS is enabled.

---

## 5. Shared-token login and session contract

### Token and verifier

The shared admin token:

- Must be exactly **32 CSPRNG-generated bytes**, encoded as canonical base64url.
- Must be separate from the internal service token, webhook secret, GitHub token,
  and all committed config values.
- Is supplied by the operator only at login.
- Is never stored by the router.
- Must never appear in browser storage, cookies, URLs, logs, responses, committed
  config, or downstream requests.

`OPS_CONSOLE_TOKEN_VERIFIER` is the canonical domain-separated SHA-256 verifier
derived from the token.

Login validation must:

- Bound and format-check input before hashing.
- Compare fixed-length digests using `crypto.timingSafeEqual`.
- Use timing-safe comparison as the sole token-validity test.

### `POST /_ops/api/v1/session`

**Request body** (exactly):

```json
{ "token": "<base64url token>" }
```

**Success response** — HTTP `201`:

```json
{
  "authenticated": true,
  "idleExpiresAt": "<UTC RFC3339>",
  "absoluteExpiresAt": "<UTC RFC3339>",
  "csrfToken": "<opaque random>"
}
```

**Rules:**

- Requires the exact configured external Origin.
- Requires `application/json` body.
- Is CSRF-exempt (no session exists yet).
- Invalid or malformed auth-equivalent attempts return a generic `401`.
- A successful login while a session already exists revokes the old session
  before creating the replacement.
- The router validates the token and never returns it.

### `GET /_ops/api/v1/session`

Used to bootstrap the current authenticated session.

**Success response** — HTTP `200`:

```json
{
  "authenticated": true,
  "idleExpiresAt": "<UTC RFC3339>",
  "absoluteExpiresAt": "<UTC RFC3339>",
  "csrfToken": "<opaque random>"
}
```

### `DELETE /_ops/api/v1/session`

**Success response** — HTTP `204` (no body).

**Rules:** requires a valid session, exact Origin, and valid `X-Ops-CSRF`. The
server-side session is revoked and the cookie is cleared.

### Session lifetime and storage

Sessions are opaque, server-side, router-local, bounded, in-memory, and not
token-bearing. Session state contains only creation/last-use timestamps, CSRF
state, verifier/session generation, and a one-way audit correlation value.

| Property | Value |
|---|---|
| Idle expiry | 30 minutes |
| Absolute expiry | 8 hours |
| Renewal | Authenticated API calls renew idle expiry only |
| Warning | UI warns 5 minutes before expiry |
| Expiry action | UI returns to login |
| Cleanup | Lazy plus bounded periodic |
| Restart | Router restart revokes all sessions |
| Token rotation | Admin-token rotation revokes all sessions |
| Capacity | Maximum 64 live sessions; no eviction |
| Excess | `503 SESSION_CAPACITY` |

### Cookie

**HTTPS (deployed development):**

```http
Set-Cookie: __Host-hc-ops=<opaque random 256-bit ID>; Secure; HttpOnly; SameSite=Strict; Path=/
```

No `Domain` attribute.

**Loopback HTTP (local development, `OPS_CONSOLE_ALLOW_HTTP_LOOPBACK=true` only):**

```http
Set-Cookie: ghhc-console-dev=<opaque random ID>; HttpOnly; SameSite=Strict; Path=/
```

No `Secure` attribute; no `__Host-` prefix.

---

## 6. Security headers, CSP, and browser restrictions

### CSRF, Origin, and Fetch Metadata

- A random per-session CSRF token is returned by `POST` and `GET /_ops/api/v1/session`.
- The CSRF token must be held only in UI JavaScript memory, never in browser storage.
- Every authenticated state-changing request must carry `X-Ops-CSRF: <token>`.
- Every state-changing request must originate from the exact configured external Origin.
  Missing, malformed, or mismatched Origins are rejected with `403`.
- Login requires the exact Origin but is CSRF-exempt.
- Mutations must be JSON only. Non-JSON content types return `415`.
- `GET` requests are passive and must never mutate state.
- When `Sec-Fetch-Site` is present, the value must be `same-origin`; cross-site requests
  are rejected with `403`. There is no Referer fallback.
- No credentialed cross-origin console API is permitted. No console CORS headers are set.

### Content Security Policy

All `/_ops/*` responses must carry:

```http
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'
```

### Required response headers (all `/_ops/*` responses)

```http
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=()
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
X-Frame-Options: DENY
```

HSTS (`Strict-Transport-Security`) is a deployment-boundary concern managed at
the ingress/proxy layer and is not a router header requirement.

### Frontend restrictions

The console UI must not use or load:

- Inline JavaScript.
- Inline CSS.
- Third-party assets or scripts.
- Analytics or tracking.
- Service workers.
- Browser storage (`localStorage`, `sessionStorage`, `IndexedDB`, cookies from
  client-side JavaScript, etc.).
- External HTTP requests.

Operational values must render through safe text sinks and default DOM escaping.
Unsafe HTML insertion is prohibited.

---

## 7. Rate limits

All rate-limit state is in-memory and resets on router restart. Rate-limited
responses return HTTP `429` with error code `RATE_LIMITED` and a `Retry-After`
header.

Node.js does not trust `Forwarded` or `X-Forwarded-*` headers and does not
derive a client IP from proxy headers. Login rate limiting is process-wide only;
there is no per-source or per-IP application bucket. Per-client-IP limiting in a
proxied deployment must be enforced at the proxy layer.

| Area | Limit |
|---|---|
| Login — global | 30 attempts / 15 minutes |
| Snapshot — per session | 12 requests / minute |
| Cache operations — per session | 5 requests / minute |
| Cache operations — global | 20 requests / minute |

---

## 8. Read API — aggregate snapshot

### Endpoint

```http
GET /_ops/api/v1/snapshot
```

Returns the complete bounded aggregate model from concurrent fan-out to all
internal services. Filtering and drilldown are client-side. There are no
separate **browser-facing** per-service read endpoints; the internal
`GET /v1/ops/snapshot` endpoint on each service is what the router fans out to.

### Browser refresh behaviour

- Refresh immediately after authentication.
- Automatic refresh starts **30 seconds** after the prior request settles.
- Requests must not overlap.
- Refresh pauses while the page is hidden or the client is offline.
- Refresh resumes on return.
- Manual refresh is always available.
- Router-local data remains usable during a failed remote refresh.
- A failed single service must never fail the aggregate response.
- Reads are not automatically retried.

### Internal fan-out

- The router queries downloader and builder **concurrently**.
- Each service has an independent timeout of **1.5 seconds**.
- The router retains one last-success snapshot per internal service.
- A last-success snapshot is **stale** for up to **2 minutes** (approximately four
  missed refreshes at the 30-second cadence), then transitions to **unknown**.
- Before any successful response, freshness is `unknown`.
- A stale slot retains the last-success snapshot plus a sanitized current error.
- An unknown slot has `snapshot: null`.
- Age is measured at the aggregate `observedAt` timestamp.

### Aggregate response envelope

```json
{
  "schemaVersion": 1,
  "correlationId": "<opaque UUID>",
  "observedAt": "<UTC RFC3339>",
  "refreshAfterMs": 30000,
  "services": {
    "router":     { /* service slot — see below */ },
    "downloader": { /* service slot */ },
    "builder":    { /* service slot */ }
  },
  "activity": [ /* activity trace array */ ],
  "failures":  [ /* failure array */ ]
}
```

### Service slot schema

```json
{
  "freshness":     "fresh|stale|unknown",
  "lastAttemptAt": "<UTC RFC3339 or null>",
  "lastSuccessAt": "<UTC RFC3339 or null>",
  "ageMs":         0,
  "snapshot":      null,
  "error":         null
}
```

Field conventions used throughout the API:

| Convention | Detail |
|---|---|
| Timestamps | UTC RFC3339 |
| Durations | Milliseconds (integer) |
| Sizes | Bytes (integer) |
| Optional/absent values | Explicit `null` |

---

## 9. Service snapshot model

### Common snapshot shape

Every internal `/v1/ops/snapshot` response must include `schemaVersion: 1` plus:

```json
{
  "service":    "router|downloader|builder",
  "instanceId": "<opaque>",
  "startedAt":  "<UTC RFC3339>",
  "observedAt": "<UTC RFC3339>",
  "health": {
    "status":  "healthy|degraded|unhealthy",
    "reasons": [
      { "code": "<ASCII ≤64>", "message": "<string ≤256>" }
    ]
  },
  "capabilities": [
    {
      "name":       "<ASCII ≤64>",
      "status":     "available|degraded|unavailable",
      "reasonCode": null
    }
  ],
  "queues":       [],
  "cache":        null,
  "dependencies": [],
  "telemetry": {
    "activityDropped":  0,
    "completedEvicted": 0,
    "failuresEvicted":  0,
    "spansDropped":     0
  }
}
```

**Rules:**

- Use empty arrays for collections that do not apply.
- Health derives from capabilities; every degradation must carry a reason.
- UI supplies human-readable labels; codes are machine-readable.
- `instanceId`, `startedAt`, and `observedAt` are required so stale or empty
  histories can be distinguished from missing data.
- Freshness unknown is the only case where overall health is also unknown.

### Stable capability names

**Router:** `public_file_delivery`, `console_read`, `console_cache_control`

**Downloader:** `ref_resolution`, `source_file_delivery`, `source_archive_delivery`, `cache_control`

**Builder:** `build_delivery`, `cache_control`

The router derives its own capabilities from itself plus required downstream
services. Partial downstream failure degrades only the affected capability.

### Queue schema

```json
{
  "name":               "download|build",
  "active":             0,
  "queued":             0,
  "limit":              0,
  "available":          0,
  "oldestQueuedAgeMs":  null
}
```

`limit` includes active work. `available = max(0, limit − active − queued)`.
`oldestQueuedAgeMs` is `null` when there are no waiting entries. No arguments,
paths, or requester data are exposed.

### Cache schema

```json
{
  "entryCount":       0,
  "totalBytes":       0,
  "idleExpiryMs":     0,
  "entriesTruncated": false,
  "entries": [
    {
      "commit":         "<40-char lowercase SHA>",
      "sizeBytes":      0,
      "lastAccessedAt": "<UTC RFC3339>",
      "expiresAt":      "<UTC RFC3339>",
      "inUse":          0
    }
  ]
}
```

**Rules:**

- Summary figures (`entryCount`, `totalBytes`) are exact over the full cache.
- `entries` lists the most-recently-accessed entries, capped at **200**.
- `inUse` is a reference count of active in-flight users.
- Only complete commit entries (those with a `.complete` marker) are included.
- Cache inspection failure degrades `cache_control` and returns `cache: null`.

### Dependency schema

```json
{
  "name":          "github|downloader|builder",
  "status":        "available|degraded|unavailable|unknown",
  "lastAttemptAt": null,
  "lastSuccessAt": null,
  "lastFailureAt": null,
  "lastLatencyMs": null,
  "errorCode":     null
}
```

**Rules:**

- Dependency observation is passive-only; the console must not trigger active probes.
- No prior attempts → `unknown`.
- Most recent result a success → `available`.
- Mixed recent results → `degraded`.
- Repeated recent failures or no recent success → `unavailable`.
- Downloader must not probe GitHub in response to console refresh.
- Builder must not probe downloader in response to console refresh.

---

## 10. Correlation, activity, spans, and failures

### Correlation ID

- The router generates a UUID (or equivalent canonical opaque ID) for each console
  API request and each public application request. The field name is `correlationId`.
- The router replaces or ignores any correlation header from the client.
- The router includes `X-Correlation-ID` in all API responses.
- The router propagates the correlation ID to all internal requests.
- Browser-provided IDs are not canonical.
- There is no automatic retry, no span hierarchy, and no distributed tracing.

### Activity trace schema

```json
{
  "correlationId": "<opaque>",
  "state":         "active|completed",
  "startedAt":     "<UTC RFC3339>",
  "completedAt":   null,
  "durationMs":    null,
  "request": {
    "method":    "GET|POST|...",
    "route":     "<allow-listed route pattern>",
    "commit":    null,
    "resource":  null,
    "buildMode": "legacy|webpack|dashboards|esbuild|static|null"
  },
  "outcome": {
    "status":     "succeeded|failed|rejected|aborted",
    "httpStatus": null,
    "code":       null
  },
  "spans": []
}
```

`resource` is the bounded, normalized, control-stripped path/ref exposed to the
operator (raw URL, query string, headers, and tokens are never included). Maximum
256 UTF-8 characters.

**Rules:**

- Each internal service records only its local span fragment under the router
  correlation ID.
- The router owns the canonical trace and merges matching fragments.
- Active traces are visible alongside completed traces.
- A completed trace may be marked partial with explicit missing or stale stages.
- The system must never silently infer missing observations.

### Span schema

```json
{
  "service":     "router|downloader|builder",
  "operation":   "<allow-listed name>",
  "state":       "active|completed",
  "startedAt":   "<UTC RFC3339>",
  "completedAt": null,
  "durationMs":  null,
  "outcome": {
    "status":     "<string>",
    "httpStatus": null,
    "code":       null
  }
}
```

Completion fields are `null` while the span is active. `operation` is
allow-listed. Maximum **8 spans per trace**; excess increments `spansDropped`.

### Activity exclusions and sort order

The following must be excluded from request activity:

- All `/_ops/*` paths.
- Automated health checks.
- Routine background cleanup.

Cache operations appear in audit and immediate result, not public-delivery
activity. Console refresh must never observe itself.

**Sort order:**

| Collection | Sort |
|---|---|
| Active traces | Newest `startedAt` first |
| Completed traces | Newest `completedAt` first |
| Failures | Newest `occurredAt` first |

Deduplication key: `correlationId + service + operation`. Orphan internal
fragments must not synthesize traces, though derived failures may appear.

### Failure schema

```json
{
  "occurredAt":    "<UTC RFC3339>",
  "correlationId": "<opaque>",
  "service":       "router|downloader|builder",
  "operation":     "<allow-listed name>",
  "code":          "<ASCII ≤64>",
  "summary":       "<allow-listed operator-safe string ≤256>",
  "httpStatus":    null,
  "commit":        null
}
```

Unknown exceptions become `INTERNAL_ERROR` with a generic summary. The
correlation ID links the failure to stdout logs. The following must never appear
in failure records: raw URL, query string, headers, tokens, request/response
body, stack trace, filesystem paths, upstream bodies, or arbitrary input.

### Retention bounds (per service)

| Collection | Bound | Retention window |
|---|---|---|
| Active traces | 100 records | — |
| Completed traces | 200 records | ≤ 15 minutes |
| Failures | 100 records | ≤ 1 hour |
| Spans per trace | 8 | — |

Oldest-first eviction. Excess active records increment `activityDropped`. Excess
completed records increment `completedEvicted`. Excess failures increment
`failuresEvicted`. Counters are monotonic per process and reset on restart.

The browser-level arrays in the aggregate envelope are the sum of these per-service
bounds; no hidden truncation occurs above that sum.

---

## 11. Health semantics

### Health status enum (wire)

```
healthy | degraded | unhealthy
```

The UI may label a service slot with `freshness: unknown` as "Unavailable".

### Capability status enum (wire)

```
available | degraded | unavailable
```

### Judgment rules

| Condition | Effect |
|---|---|
| Queue saturated (occupancy reached configured capacity) | Degrades affected capability |
| Capacity rejection in the prior 5 minutes | Degrades affected capability |
| Operational failures + rejections ≥ 3 and ≥ 10 % of completed requests in rolling 5-minute window (minimum 10 samples) | Degrades reliability |
| p95 latency ≥ 80 % of configured route/stage timeout (minimum 10 samples) | Degrades latency |
| Current dependency/rate-limit, cache-inspection, or cleanup failure | Degrades immediately; remains evidence for 5 minutes |
| Partial capability loss | `degraded` |
| No degradation rule applies and signals are fresh/reachable | `healthy` |

Queue "busy" (active > 0 but not saturated) is informational only.

---

## 12. Cache operation semantics

### Operator-visible actions

| Canonical name | Scope |
|---|---|
| `cache.evict_commit` | Downloader, builder, or both — named in one router action |
| `cache.purge_expired` | Exactly one named service |
| `cache.clear` | Exactly one named service |

### Logical entry definition

A logical cache entry is keyed by a canonical lowercase 40-character commit SHA.

- **Downloader entry:** SHA source tree, SHA single-file cache, commit-keyed esbuild
  detection state.
- **Builder entry:** SHA extracted workspace, build outputs.

The following are not operator-controllable entries: sub-file entries, named-ref
lookup maps, temporary extraction directories, queues, and telemetry.

### Expiry (idle-time)

- An entry is eligible for `cache.purge_expired` when its `lastUsedAt` is at least
  the service-configured cache lifetime ago.
- Eligibility is evaluated at action start to form a candidate snapshot.
- Under a per-entry lock, `lastUsedAt` is re-evaluated. If it advanced past the
  eligibility threshold since the snapshot, the entry is released and counted in
  `skippedChanged`.
- In-flight entries are counted in `skippedInUse`.
- `cache.clear` has no expiry threshold; `skippedChanged` does not apply.

### In-flight safety

Active entries are skipped unconditionally. They are never cancelled, waited
for, or deferred. An entry is active when it is in-flight for any of: download,
extraction, build, archive generation, or file response. Skipped active entries
are counted in `skippedInUse`.

### Concurrency protocol

1. Snapshot candidate SHAs at action start.
2. Per-entry exclusion atomically checks in-flight status.
3. If idle, claim deletion.
4. For expiry operations, re-evaluate `lastUsedAt` under lock.
5. `cache.purge_expired` and `cache.clear` must not chase entries created after the
   snapshot.
6. New work arriving after deletion claim waits and rebuilds normally.
7. Concurrent deletion of the same entry by a later claimer: record `absent`.

### Retry semantics

- The router must **never automatically retry** a cache operation.
- Absent entries are no-op and idempotent, so manual operator retries are
  deletion-safe.
- For an `unknown` outcome, the UI must surface the correlation ID and instruct
  the operator to inspect the current cache state before deciding whether to retry.
- There is no confirmation UI for any action including `cache.clear`.
- All authenticated sessions share the same allow-listed operations; there is no
  special-privilege clear role.

---

## 13. Cache operation transport and result schema

### Browser endpoint

```http
POST /_ops/api/v1/cache-operations
```

### Internal endpoint (per service)

```http
POST /v1/ops/cache-operations
```

### Request shapes

**Evict one commit:**

```json
{
  "operation": "cache.evict_commit",
  "targets":   ["downloader", "builder"],
  "commit":    "<full 40-char lowercase SHA>"
}
```

`targets` accepts one or both valid values. `cache.purge_expired` and
`cache.clear` require exactly one target and no `commit` field.

**Purge expired:**

```json
{
  "operation": "cache.purge_expired",
  "targets":   ["downloader"]
}
```

**Clear:**

```json
{
  "operation": "cache.clear",
  "targets":   ["builder"]
}
```

### Dispatch rules

- The router validates the request and forwards only service-specific named
  commands. No generic proxy; no legacy cleanup fallback.
- Targets are invoked **concurrently and independently**.
- Timeout per target: **10 seconds**.
- A two-target eviction completes in approximately 10 seconds total (not 20).
- A timeout result is `unknown`.
- Aborting the router wait does not imply cancellation or rollback on the
  internal service.
- The router must never retry.

### HTTP result behaviour

A dispatched/orchestrated request returns HTTP `200` even when a target fails or
times out. Validation, authentication, and rate-limit failures return pre-dispatch
non-2xx responses.

### Operation response schema

```json
{
  "correlationId": "<opaque>",
  "operation":     "cache.evict_commit|cache.purge_expired|cache.clear",
  "startedAt":     "<UTC RFC3339>",
  "completedAt":   "<UTC RFC3339>",
  "outcome":       "completed|no_op|partial|failed|unknown",
  "targets": [
    {
      "service":         "downloader|builder",
      "outcome":         "completed|no_op|partial|failed|unknown",
      "removedEntries":  0,
      "freedBytes":      0,
      "absent":          false,
      "skippedInUse":    0,
      "skippedChanged":  0,
      "error":           null
    }
  ]
}
```

`cache.clear` targets omit `skippedChanged`.

For `cache.evict_commit`, the per-service semantic disposition (`removed`,
`absent`, `in_use`, or `failed`) is not a separate wire field. It is derived
from the existing wire fields as follows:

| Semantic disposition | Wire representation |
|---|---|
| `removed` | `removedEntries > 0` |
| `absent` | `absent: true` |
| `in_use` | `skippedInUse > 0` |
| `failed` | target `outcome` is `"failed"` and `error` is non-null |

### Outcome derivation rules

| Condition | Outcome |
|---|---|
| Any target timed out or response ambiguous | `unknown` |
| All targeted services failed definitively | `failed` |
| A definitive failure mixed with any non-failure disposition (absent, skip, or removed) | `partial` |
| Definitive removal mixed with a skip (in-use or skippedChanged) and no failures | `partial` |
| One or more entries removed; all remaining targets removed or absent; no failures | `completed` |
| Nothing removed, no failures; all targets absent, in-use, or skippedChanged | `no_op` |

`absent` is neutral and never on its own converts `completed` into `partial`.
`unknown` means dispatch occurred but outcome is indeterminate.

### Router audit event

Exactly **one** structured JSON event must be written to router stdout per browser
cache action attempt. This applies to every attempt outcome including validation
failure, `no_op`, `partial`, `unknown`, `failed`, pre-dispatch rejection,
and post-dispatch completion or timeout.

Internal services must not emit independent operator-visible audit events.

Required audit event fields:

| Field | Description |
|---|---|
| `time` | ISO timestamp |
| `action` | Normalized operation name |
| `correlationId` | Router request ID |
| `sessionAuditId` | Separate random per-session audit ID, independent of cookie, non-authorizing |
| `source` | Always `null`; no network identity is trusted and no client or proxy IP is attributed |
| `userAgent` | Bounded, truncated |
| `operation` | Validated operation |
| `targets` | Validated target list |
| `commit` | Commit SHA, if applicable |
| `dispatchStatus` | Whether dispatch occurred |
| `outcome` | Overall outcome |
| `targetOutcomes` | Per-target outcomes, dispositions, and counts |
| `errorCodes` | Bounded, sanitized |
| `durationMs` | Total duration |

---

## 14. Audit and logging

### Sanitized events (additional, non-cache)

Auth, rate-limit, and session events may be separately emitted without
violating the one-event-per-cache-attempt rule. Events may include: login
success/failure, logout, detected expiry, revoke-all, CSRF/origin/rate-limit
rejection, and sanitized enabled/disabled status.

### What must never be logged

The following must never appear in any log, trace, error response, or audit event:

- Shared admin token.
- Token verifier.
- Cookie or session identifier.
- CSRF token.
- Authorization header value.
- Internal bearer token.
- GitHub token.
- Webhook secret.
- Login request body or any raw request body.
- Arbitrary request or response headers.
- Raw error messages or exception messages.
- Stack traces.
- Filesystem paths.
- Compiler output.
- Upstream response bodies.
- Sensitive payloads.
- Arbitrary operator input.

### Audit retention

- No database, file audit store, or in-console history.
- Container stdout is the only audit record.
- Loss on container restart is explicitly acceptable for the development-first scope.
- Because the console uses a shared token, the per-session audit ID must not imply
  identified individuals.

---

## 15. Error contract and validation bounds

### Uniform non-2xx error response

```json
{
  "error": {
    "code":          "<ASCII ≤64>",
    "message":       "<string ≤256>",
    "correlationId": "<opaque>"
  }
}
```

Optional bounded field list (names only, no values):

```json
{
  "details": {
    "fields": ["<field name ≤64>"]
  }
}
```

Maximum 16 field names, 64 characters each.

### HTTP status code families

| Status | Meaning |
|---|---|
| `400` | Invalid JSON, schema, operation, target, or commit |
| `401` | Invalid login, or missing/expired session |
| `403` | Origin or CSRF failure |
| `404` | Unknown console API route |
| `413` | Request body too large |
| `415` | Non-JSON mutation body |
| `429` | Rate limited |
| `503` | Session capacity exceeded, or temporarily unavailable |
| `500` | Unexpected router failure before a valid result |

Aggregate dependency failures and post-dispatch mutation failures return HTTP
`200` with a structured error or outcome in the body.

### Validation and payload bounds

| Constraint | Value |
|---|---|
| Body encoding | UTF-8 `application/json`; optional `charset=utf-8` |
| Body structure | One top-level JSON object |
| Maximum decoded body size | 4 KiB |
| Login token maximum | 512 UTF-8 bytes |
| Commit format | Exactly 40 lowercase hex characters |
| Internal snapshot response | Uncompressed, capped at **1 MiB per service** |
| Internal mutation response | Capped at **64 KiB** |
| Human-readable strings | Maximum 256 UTF-8 characters |
| Stable codes and identifiers | ASCII, maximum 64 characters |
| Integers | Non-negative safe integers |
| Timestamps | Valid UTC RFC3339 |

Additional rules:

- Reject malformed JSON, duplicate keys, unknown properties, wrong types, coercion,
  and out-of-bound values.
- An invalid or oversized internal snapshot is a failed attempt; the slot falls
  back to stale or unknown.
- An invalid or oversized internal mutation response is `unknown` because execution
  may have occurred.
- Serialization failure before the response returns a uniform pre-response `500`.

---

## 16. UI, information architecture, and accessibility

### Information hierarchy

The UI must follow an **overview-first** layout:

1. Compact cross-service status and snapshot overview (router, downloader, builder).
2. Capacity, active work, and correlated recent request activity.
3. Prominent recent sanitized failures.
4. Clearly separated commit-level cache inspection and actions.
5. Session status — visible but not dominant.

Detail must drill from the overview into service, request, and cache context. A
service-first navigation model or incident timeline must not be the default
top-level structure.

### Visual direction

Production UI must be simpler than any prototype:

- Restrained utility UI with compact typography and spacing.
- Plain tables, lists, and panels where sufficient.
- Minimal decoration; no oversized hero treatment, ornamental gradients,
  rotations, or gratuitous card styling.

Simplicity must not remove: labels, timestamps, semantic status text, keyboard
access, focus visibility, or responsive readability.

### Required UI states

| State | Required behaviour |
|---|---|
| Initial load | Preserve structure; show textual loading status. Never fake zeros. No skeleton-only indefinite UI. |
| Empty | Queues, activity, failures, and cache at zero are explicit normal empty states. |
| Stale | Values remain visible with a "Stale" label, age, and sanitized error. Must not be styled as current. |
| Unknown | No inferred values; show "Unavailable" label, last attempt time, and sanitized reason. `snapshot: null`. |
| Partial aggregate | Render usable services with a prominent warning for unavailable services. |
| Refreshing | Unobtrusive refreshing indicator without replacing existing data. Show `observedAt`, next refresh time, and manual refresh control. |
| Mutation pending | Disable only conflicting controls. Retain per-target result until dismissed or replaced. |
| Unknown mutation | Warn the operator to inspect a fresh snapshot before acting again. Surface the correlation ID. |
| Session expiry warning | Visible and keyboard accessible. "Stay signed in" is a normal authenticated refresh, not a hidden mutation. |
| Auth failure | Replace the console with the login page and move focus to the heading. |
| No JavaScript | Static page stating JavaScript is required; no degraded mutation path. |

### Responsive layout

At **320 CSS px** viewport width:

- No required horizontal page scrolling.
- Stack cards vertically.
- Convert tables to labeled records if needed.
- Retain critical status, timestamps, and action controls.

### Accessibility

The console must meet **WCAG 2.2 Level AA**. Specific requirements:

- Semantic headings and landmark regions.
- Tables and forms used appropriately.
- Every interactive control is keyboard-operable.
- Visible, unobscured focus indicator.
- Labels and error messages are programmatically associated.
- Restrained use of `aria-live`; status messages announce without stealing focus.
- Automatic refresh must not move focus.
- After a user-initiated cache operation, move focus to the result summary.
- Color must never be the sole state indicator.
- Sufficient contrast and touch/pointer target sizes (WCAG 2.2 AA).
- Respect `prefers-reduced-motion`.
- No content loss or overlap at 200 % browser zoom.

### Manual accessibility acceptance

Before enabling in any development environment, a human must verify:

- Logical tab sequence with no keyboard traps.
- Enter, Space, and Escape function correctly for all interactive elements.
- Focus is visible and unobscured throughout all flows.
- Loading, empty, partial, stale, and error states all render correctly at 320 CSS px.
- Status messages announce without stealing focus.
- No content loss or overlap at 200 % zoom.
- At least one screen-reader pairing: NVDA + Firefox, or VoiceOver + Safari.

---

## 17. Compatibility and schema versioning

### Version contract

- Internal snapshots must include `"schemaVersion": 1`.
- The browser API namespace is `/_ops/api/v1/*`.
- Internal endpoints are `/v1/ops/*`.
- The browser supports v1 only.

### Additive changes (permitted within v1)

Adding optional response fields to existing endpoints is a compatible additive
change and does not require a version bump.

### Incompatible changes (require `/v2`)

Removing fields, changing field meanings, removing or redefining enum values,
and adding new required fields all require a `/v2` version.

### Schema validation rules

- The router ignores unknown additional response fields from internal services.
- The router strictly requires all known mandatory fields.
- Missing or wrong known fields, or an unknown `schemaVersion`, produce
  `INCOMPATIBLE_SCHEMA`. The affected slot falls back to stale or unknown.
- No default values are guessed for missing mandatory fields.
- Unsupported operations return `UNSUPPORTED_OPERATION`; there is no legacy fallback.
- Internal console endpoints are additive and must never weaken bearer authentication.

### Deployment skew

- Deploy downloader and builder before enabling the router's console.
- During skew, missing internal endpoints appear as unavailable in the affected
  service slot while public delivery continues normally.
- After dispatch, a malformed, incompatible, disconnected, or timed-out mutation
  response is `unknown` unless a valid response structure proves a definitive outcome.

---

## 18. Verification gates

All verification must produce redacted evidence retained per §19.

### Gate 1 — Unit/PR (`npm test`)

`npm test` (TypeScript generation/lint/Mocha) is the automated PR gate. It must
cover at minimum:

**Configuration and startup:**
- Disabled routes 404; no internal calls; sanitized status event.
- Enabled startup failures for every illegal loopback combination.
- `NODE_ENV` alone must not enable the console.

**Login and credentials:**
- Login requires exact `{ "token": "..." }` JSON body ≤ 4 KiB decoded, token ≤ 512 UTF-8 bytes.
- Login requires exact configured Origin; is CSRF-exempt.
- Valid login returns `201` and sets the correct cookie.
- HTTPS environment sets `__Host-hc-ops` cookie.
- Loopback HTTP environment sets `ghhc-console-dev` cookie.
- Malformed or invalid auth-equivalent attempts return generic `401`.
- Successful login revokes the prior session.
- No raw token, verifier, cookie, CSRF token, Authorization header, login body,
  or sensitive payload appears in logs, traces, or error responses.

**Session management:**
- Session idle timeout: 30 minutes.
- Session absolute timeout: 8 hours.
- `DELETE` session returns `204`, revokes server-side session, clears cookie.
- Revoked cookie returns `401`.
- Maximum 64 sessions; no eviction; excess returns `503 SESSION_CAPACITY`.

**CSRF and headers:**
- Unsafe authenticated mutations require exact Origin and valid `X-Ops-CSRF`.
- Origin or CSRF failures return `403`.
- `Sec-Fetch-Site: same-origin` required when present; cross-site returns `403`.
- Safe `GET`/`HEAD` never mutate.
- All required security headers are present and exact on `/_ops/*` responses.
- No inline JS/CSS; no third-party resources; no analytics, service workers,
  browser storage, external requests, or CORS headers.

**Rate limits:**
- Login global limit enforced (30 attempts / 15 minutes); no per-source bucket exists.
- Snapshot and cache-operation session/global limits enforced.
- Rate-limited responses include `429`, `RATE_LIMITED`, and `Retry-After`.

**Snapshot:**
- Fan-out to downloader and builder is concurrent.
- Per-service timeout of 1.5 seconds is enforced independently.
- Correlation ID is propagated to internal requests.
- Stale and unknown slot rules are applied correctly.
- Bounds: 1 MiB per internal snapshot, strings ≤ 256, identifiers ≤ 64,
  100/200/100 active/completed/failures, 8 spans/trace, cache list ≤ 200.

**Cache operations:**
- Targets invoked concurrently; 10 s per-target timeout; no automatic retry.
- Structured outcomes per derivation rules.
- Exactly one sanitized stdout audit event per attempt.
- Internal mutation response ≤ 64 KiB.
- Internal missing or wrong bearer returns `401` via timing-safe comparison.

### Gate 2 — Topology

Before any internal image promotion, a Docker Compose inspection must prove:

- Only the router publishes port 8080.
- Downloader and builder have no published ports.
- Unauthenticated `GET` and `POST` to internal ops endpoints from the private
  network return `401`.

### Gate 3 — Integration (`npm run test:integration:ops`)

A new `test:integration:ops` npm script must be added. It runs Hurl
contract/security/failure scenarios against a composed loopback HTTP stack.

The existing public Hurl smoke (`test/hurl/smoke.hurl`) and service-split
(`test/hurl/service-split.hurl`) suites run separately and must continue to pass.

Integration scenarios must cover:

- Valid and invalid login flows.
- Cookie attributes by mode (HTTPS vs loopback HTTP).
- Absence of logged credentials.
- Session `GET`, logout, revocation, and token rotation.
- Origin + CSRF and Fetch Metadata negative cases.
- Unsupported methods, content types, and CORS headers.
- Disabled mode: all `/_ops/*` return 404; public endpoints unaffected.
- Healthy fresh snapshots.
- Stopped or slow service after prior success → stale slot.
- No prior success when service is down → unknown slot.
- 1.5-second timeout handling and bounds enforcement.
- Named cache operation on healthy service → `completed` or `no_op`.
- Cache operation against unavailable/timing-out service → `failed`/`unknown`.
- No automatic retry.
- Audit event format and 64 KiB response bound.

### Gate 4 — Security and failure injection

Failure injection cases map to OWASP ASVS 5.0 V3/V4/V7/V8/V16 and relevant WSTG
session/auth/input/error topics. No blanket compliance claim is made.

Required negative checks:

- Expired cookie → `401`.
- Replacement login revokes old session and issues new session ID.
- Rate-limit `429` plus `Retry-After` respected.
- Protected data and actions return `401` unauthenticated.
- No stacks, paths, env values, secrets, token fragments, or session IDs in
  responses or logs.
- Internal missing/wrong bearer → `401` via timing-safe comparison.
- All security headers present and exact.
- No credentials in logs or traces.

Failure injection:

- Service response > 1.5 s after prior success → stale slot; no unhandled error.
- Service down before any success → unknown slot.
- Service unavailable after prior success → stale; no unhandled error.
- Malformed internal JSON → unknown; no raw forwarding to client.
- Internal snapshot > 1 MiB → bounded/rejected.
- Restarted service recovers on next refresh cycle.
- Mutation response > 10 s → unknown; no retry; audit event emitted.
- Concurrent cache commands are independent and each produces one audit event.

### Gate 5 — Browser and accessibility (`npm run test:browser:ops`)

A new `test:browser:ops` npm script must be added and **wired into CI** so that
it runs automatically on every PR. It runs Playwright tests against Chromium and
Firefox and includes axe accessibility checks.

Must cover: login flow, overview/snapshot rendering, and cache operations.
Must report no known WCAG 2.2 Level A or AA violations in tested flows.

Automation supports but does not replace manual accessibility acceptance (§16).

---

## 19. Development rollout, rollback, and abort criteria

### Staged development rollout

**Step 1 — PR merge:** `npm test` passes; commit SHA recorded.

**Step 2 — Downloader:** Deploy updated image.
- Verify `/health` returns OK.
- Verify unauthenticated `GET /v1/ops/snapshot` returns `401`.
- Verify no published host port.
- Verify additive internal API compatibility.

**Step 3 — Builder:** Deploy updated image.
- Verify `/health` returns OK.
- Verify unauthenticated `GET /v1/ops/snapshot` and `POST /v1/ops/cache-operations`
  return `401`.
- Verify no published host port.
- Verify additive compatibility.

**Step 4 — Router, console disabled:** Deploy updated router image with
`OPS_CONSOLE_ENABLED` unset or not `true`.
- Run the existing public Hurl smoke and service-split suites; they must pass exactly.
- All `/_ops/*` paths must return `404`.

**Step 5 — Router, console enabled:** Restart the single router with
`OPS_CONSOLE_ENABLED=true`, valid `OPS_CONSOLE_TOKEN_VERIFIER`, and
`OPS_CONSOLE_ORIGIN`.

Required before declaring success:
- Sanitized enabled status event appears in stdout.
- `npm run test:integration:ops` passes.
- All security/failure injection checks pass.
- `npm run test:browser:ops` passes.
- Manual accessibility acceptance complete.
- Signed operator acceptance complete (login, read snapshot, execute cache command,
  stop a service and observe stale, disable console and verify 404 + public
  unaffected, complete rollback rehearsal).

Any failed gate halts rollout and triggers disable/rollback.

### Observability during rollout

Monitor in stdout:

- Sanitized status, auth, and CSRF events.
- Snapshot duration and per-slot `observedAt`.
- Per-target timeout events.
- Cache command outcome, duration, and audit event.
- Unhandled errors (must contain no sensitive data).
- Correlation IDs joining router and internal-service log lines.

### Disabling the console

Unset `OPS_CONSOLE_ENABLED` (or set it to any value other than `true`) and restart
the router. Expected post-restart state:

- All `/_ops/*` paths return `404`.
- No console calls are made to internal services.
- Public file delivery is unaffected.

Disabling is immediate containment and not a substitute for image rollback.

### Rollback procedure

1. Roll back the router first using the previous immutable image digest.
2. Verify the public Hurl smoke and service-split suites pass.
3. Verify all `/_ops/*` paths return `404`.
4. Verify old session cookies are unusable (in-memory session state was reset).
5. Verify no console calls reach internal services.
6. Roll back builder, then downloader, **only if** their additive ops endpoint
   changes are implicated or incompatible. Compatible internal images may remain.
7. Verify `/health` on all services.

### Abort criteria

Rollout must be immediately halted and rolled back on any of:

- Any regression in the public Hurl smoke or service-split suite.
- Protected console data, API, or action succeeds without authentication.
- Any planned security negative check unexpectedly passes.
- Sensitive material (token, verifier, cookie, CSRF, stack trace, filesystem path)
  appears in logs, responses, or test artifacts.
- Any internal snapshot slot returns more than 1 MiB.
- Service timeout not handled within 1.5 seconds (snapshot) or 10 seconds (mutation).
- Client-visible unhandled error.
- Automatic retry of any operation.
- Unsatisfied operator acceptance check.

### Evidence to retain

All evidence must use ephemeral credentials. Verifier, tokens, CSRF values,
cookies, Authorization headers, login bodies, and sensitive payloads and
screenshots must be redacted before storage.

| Evidence | Minimum content |
|---|---|
| CI unit gate | `npm test` link and passing commit SHA |
| Integration transcript | Redacted Hurl output, timestamp, and image digests |
| Security results | Per-case pass/fail, ASVS/WSTG reference, tester name, and timestamp |
| Browser/accessibility report | Playwright report, axe results, signed manual checklist, screen-reader pairing used |
| Operator signoff | Name, time, correlation IDs used during acceptance |
| Image digests | Before and after digests for all three services; rollback digest |
| Disable and rollback rehearsal | Steps taken, public Hurl result, confirmation of old-cookie invalidation |

---

## 20. Non-normative provenance

This specification consolidates decisions reached in the following Wayfinder
issues and topics as historical context; the normative body above does not
depend on them.

| Issue | Topic |
|---|---|
| #24 | Operator journeys |
| #25 | Shared-token security research |
| #26 | Shared-token access contract |
| #28 | Operational signal model |
| #29 | Safe cache-control semantics |
| #30 | Admin API and UI contract |
| #31 | Verification and development rollout |
| #32 | Console and telemetry architecture |
| #33 | Prototype workflows and information architecture |

Where earlier and later decisions conflicted, the later or more specific
decision was used. Key supersessions:

- `/_ops/*` supersedes `/operations/*` (#30/#31 over #26).
- `__Host-hc-ops` / `ghhc-console-dev` supersede `__Host-ghhc-console` (#30/#31 over #25/#26).
- `X-Ops-CSRF` supersedes `X-CSRF-Token` (#30/#31 over #26).
- `default-src 'none'` CSP supersedes earlier variants (#30/#31 over #25/#26).
- `X-Frame-Options: DENY` is explicitly required (#31 over omission in #30).
- Login global rate limit of 30/15 min supersedes earlier tracking-only approach (#30/#31 over #26).
- Stale threshold of 2 minutes/four misses supersedes 60-second stale (#30 over #28).
- Retention bounds 100/200/100 supersede 1,000/hour (#30 over #28).
- Wire health enum `unhealthy` supersedes `unavailable` (#30 over #24/#28).
- Wire freshness enum `fresh|stale|unknown` supersedes four-value enum (#30 over #32).
- Token verifier required only in enabled mode (#31 over #26).
