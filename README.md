# github.highcharts.com
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)

Node.js server that serves Highcharts distribution files built on demand from any branch, tag, or commit in the Highcharts repository. Intended for testing and development; use code.highcharts.com for production.

## Operations console

> **Development-only.** The operations console must never be enabled in staging or production.

A secured operations console is built into the router and is disabled by default. When enabled, it lets trusted Highsoft engineers inspect system health, browse recent request activity, trace individual requests, and perform cache-maintenance operations — all from a same-origin browser UI served at `/_ops/`.

The full normative specification (1 479 lines) is at [docs/operations-console.md](docs/operations-console.md). This section covers everything needed to configure, start, and operate it locally.

### Topology

The console does not change the three-process topology. Only the router exposes a port; the downloader and builder remain on the private Docker network. The browser never contacts internal services directly and never receives the internal bearer token. Console telemetry and cache state are available only under bearer-protected `/v1/ops/*` paths on each internal service.

### Environment variables

| Variable | Required when | Description |
|---|---|---|
| `OPS_CONSOLE_ENABLED` | Always evaluated | Must be exactly the string `true` to enable the console. Any other value or absence keeps the console off and every `/_ops/*` path returns 404. |
| `OPS_CONSOLE_TOKEN_VERIFIER` | Console enabled | Canonical domain-separated SHA-256 verifier derived from the shared admin token (see below). Never store the raw token. Validated at startup; missing or malformed values abort startup. |
| `OPS_CONSOLE_ORIGIN` | Console enabled | The single exact external Origin the console accepts for all state-changing requests and for login (e.g. `http://localhost:8080`). Missing or ambiguous values abort startup. |
| `OPS_CONSOLE_ALLOW_HTTP_LOOPBACK` | Optional | Set to exactly `true` to allow HTTP only when the Origin is a loopback address and no mTLS settings are present. All other HTTP/mTLS combinations abort startup. |
| `OPS_CONSOLE_MTLS_PORT` | HTTPS console | Port for the mTLS listener. Defaults to `8443`. Must not be combined with HTTP loopback mode. |
| `OPS_CONSOLE_MTLS_KEY_PATH` | HTTPS console | Absolute in-container path to the server TLS private key PEM file. |
| `OPS_CONSOLE_MTLS_CERT_PATH` | HTTPS console | Absolute in-container path to the server TLS certificate PEM file. |
| `OPS_CONSOLE_MTLS_CA_PATH` | HTTPS console | Absolute in-container path to the Envoy client CA certificate PEM file. The router uses this CA to verify the client certificate that Envoy presents during the mTLS handshake. The file must be a CA certificate; startup fails if it is not. This CA is the Envoy-client-issuing CA and is distinct from the server CA used in Contour's `validation.caSecret`. |
| `ROUTER_BIND_ADDRESS` | Optional | Host address the router container binds to. Defaults to `127.0.0.1` in Docker Compose; the console is not reachable from outside loopback unless this is changed deliberately. |

`OPS_CONSOLE_TRUSTED_PROXY` is not supported. Setting it to any non-blank value aborts startup.

**Verifier, not token.** `OPS_CONSOLE_TOKEN_VERIFIER` stores a one-way verifier, never the raw token. Derive it from a canonical 32-byte CSPRNG token (base64url-encoded) with:

```bash
node -e "
const { createHash } = require('crypto');
const sep = 'github.highcharts.com:ops-console:v1\x00';
const raw = Buffer.from('<your-base64url-token>', 'base64url');
const digest = createHash('sha256').update(sep).update(raw).digest('base64url');
console.log('v1.' + digest);
"
```

Set the printed `v1.<base64url-sha256>` string as `OPS_CONSOLE_TOKEN_VERIFIER` in your `.env`. Keep the raw token only in your password manager or 1Password — never in `.env`, source control, logs, or browser storage.

### Login and session behaviour

Navigate to `/_ops/login` and submit the raw base64url token. On success the router creates an opaque server-side session (30-minute idle expiry, 8-hour absolute maximum) and sets a `HttpOnly; SameSite=Strict` cookie. Sessions are router-local and in-memory; restarting the router revokes all active sessions. The UI warns five minutes before expiry and returns to the login page on expiry or logout.

### Snapshot and cache operations

`GET /_ops/api/v1/snapshot` returns a concurrent aggregate of router, downloader, and builder state: health, queue depth, cache summary, and recent request activity. Each internal call is bounded to 1.5 seconds.

`POST /_ops/api/v1/cache-operations` drives cache maintenance: evict a single commit, purge expired entries, or clear a full service cache. Each operation is bounded to 10 seconds. All mutations are recorded as a single sanitized audit event in the router log.

### Local Compose setup

```bash
# 1. Copy the example env file (only needed once)
cp .env.example .env

# 2. Generate and store the raw token in your password manager, then derive the verifier:
node -e "
const { createHash, randomBytes } = require('crypto');
const sep = 'github.highcharts.com:ops-console:v1\x00';
const raw = randomBytes(32);
console.log('Raw token (save to password manager):', raw.toString('base64url'));
const digest = createHash('sha256').update(sep).update(raw).digest('base64url');
console.log('Verifier (put in .env):', 'v1.' + digest);
"

# 3. Edit .env — set the required console variables:
#   OPS_CONSOLE_ENABLED=true
#   OPS_CONSOLE_TOKEN_VERIFIER=v1.<digest from above>
#   OPS_CONSOLE_ORIGIN=http://localhost:8080
#   OPS_CONSOLE_ALLOW_HTTP_LOOPBACK=true
#   (leave OPS_CONSOLE_MTLS_* blank for local HTTP loopback mode)

# 4. Start the stack
docker compose up --build --wait

# 5. Open http://localhost:8080/_ops/login and log in with the raw token

# 6. To disable the console again, set OPS_CONSOLE_ENABLED=false (or remove it) and restart:
docker compose up --build --wait
```

### Running the console tests

```bash
# Full unit and lint suite (includes ops-console and ops-config tests)
npm test

# Integration smoke tests against a running stack (requires docker compose up)
npm run test:integration:ops

# Browser/accessibility tests (requires a running stack and Playwright browsers installed)
npm run test:browser:ops
```

### Operational checklist

This checklist covers staged local rollout, abort criteria, and rollback.

**Enable:**

1. Derive the verifier and set `OPS_CONSOLE_ENABLED=true` plus the three required variables in `.env`.
2. For local HTTP loopback mode, set `OPS_CONSOLE_ALLOW_HTTP_LOOPBACK=true` and leave all `OPS_CONSOLE_MTLS_*` variables blank. For HTTPS mTLS mode, supply absolute in-container paths for `OPS_CONSOLE_MTLS_KEY_PATH`, `OPS_CONSOLE_MTLS_CERT_PATH`, and `OPS_CONSOLE_MTLS_CA_PATH`.
3. Restart the router (`docker compose up --build --wait`). Confirm startup log shows `ops-console enabled`.
4. Open `/_ops/login`; confirm login succeeds and the snapshot page loads with data from all three services.
5. Run `npm run test:integration:ops` — all checks must pass.

**Abort criteria — disable immediately if any of the following occur:**

- `/_ops/*` paths are reachable from outside the intended network boundary.
- Login returns a session without a valid token being submitted.
- Any audit event is absent from the router log after a cache mutation.
- Internal bearer token appears in a browser response or cookie.
- Router startup fails with a missing-verifier, missing TLS path, or invalid TLS material error that cannot be resolved within 10 minutes.

**Disable and roll back:**

```bash
# Remove or unset OPS_CONSOLE_ENABLED in .env (or set it to any value other than "true"),
# then restart the router:
docker compose up --build --wait

# Confirm every /_ops/* path returns 404:
curl -o /dev/null -w "%{http_code}" http://localhost:8080/_ops/
# Expected: 404
```

If the router itself must be rolled back, re-tag the prior immutable image to the environment tag and restart the container. The router can be rolled back independently of the internal services provided internal API compatibility is maintained.

## Architecture

The application is split into three cooperating services. Only the router is reachable from the public internet. The downloader and builder are internal and communicate over a private Docker network.

| Service | Entrypoint | Responsibility |
|---|---|---|
| **Router** | `server.js` | Accepts public requests, resolves branch/tag/SHA references, decides build mode, proxies to downloader or builder, and applies public response headers. |
| **Downloader** | `downloader-server.js` | Fetches TypeScript source trees from GitHub and caches them by commit SHA. Resolves named refs (branches, tags, short SHAs) to full 40-character SHAs. Also performs the v13+ esbuild detection HEAD request. |
| **Builder** | `builder-server.js` | Receives a build request from the router, fetches sources from the downloader, compiles them using the selected mode, and streams the result back. |

### Trust boundaries

- All inter-service calls carry a `Bearer` token (`INTERNAL_SERVICE_TOKEN`). Requests without a valid token receive `401`.
- The downloader and builder expose no host ports; only the router publishes port 8080.
- Rate-limiting and CORS headers are applied by the router; internal services do not set public headers.

### Internal API (not a public stability guarantee)

All authenticated endpoints are under `/v1/`.

**Downloader**
- `GET /health` — returns `{"status":"ok"}` (unauthenticated)
- `POST /v1/resolve` — resolves a `ref` string to `{commit, needsEsbuild, rate}`
- `GET /v1/files/:commit/*` — streams a single source file from the cache
- `GET /v1/sources/:commit.tar.gz` — streams a gzip tar archive of the full source tree
- `POST /v1/cleanup` — removes expired or force-removed cache entries

**Builder**
- `GET /health` — returns `{"status":"ok"}` (unauthenticated)
- `POST /v1/build` — compiles `{commit, path, mode, options}` and streams the result; sets `X-Built-With` and `X-Build-Path` response headers
- `POST /v1/cleanup` — removes expired or force-removed build cache entries

## Install

Clone the repository and install dependencies:

```
git clone https://github.com/highcharts/github.highcharts.com.git
cd github.highcharts.com
npm i
```

## Configuration

Each service reads its configuration from environment variables, falling back to `config.json` for values that are not set. Non-empty environment variable values take precedence.

### Required

| Variable | Owner | Description |
|---|---|---|
| `INTERNAL_SERVICE_TOKEN` | all three services | Shared bearer token for internal service-to-service calls. Must be set to a long random value. |

### Optional

| Variable | Owner | Description |
|---|---|---|
| `WEBHOOK_SECRET` | router | Secret for validating GitHub webhook deliveries to `/update`. Falls back to `config.json` `secureToken`. |
| `GITHUB_TOKEN` | downloader | Personal access token for GitHub API calls. Not required for local use, but avoids rate limits. |

### Other settings (all optional)

| Variable | Default | Description |
|---|---|---|
| `ROUTER_PORT` | `8080` | Host port published by the router container. |
| `PUBLIC_DOWNLOADER_TIMEOUT` | `15000` | Router → downloader request timeout (ms). |
| `PUBLIC_BUILDER_TIMEOUT` | `180000` | Router → builder request timeout (ms). |
| `BUILDER_DOWNLOADER_TIMEOUT` | `120000` | Builder → downloader request timeout (ms). |
| `DOWNLOADER_CACHE_LIFETIME` | `604800000` | Time (ms) before a cached source tree is eligible for removal. |
| `BUILDER_CACHE_LIFETIME` | `604800000` | Time (ms) before a cached build output is eligible for removal. |
| `DOWNLOADER_CLEAN_INTERVAL` | `120000` | How often (ms) the downloader runs its cleanup sweep. |
| `BUILDER_CLEAN_INTERVAL` | `120000` | How often (ms) the builder runs its cleanup sweep. |
| `DOWNLOADER_MAX_QUEUE_SIZE` | `2` | Maximum concurrent download jobs. |
| `BUILDER_MAX_QUEUE_SIZE` | `2` | Maximum concurrent build jobs. |
| `DOWNLOADER_SOURCE_URL` | `https://raw.githubusercontent.com/highcharts/highcharts/` | Upstream source base URL. |
| `GITHUB_LOOKUP_CACHE_TTL` | `60000` | In-memory TTL (ms) for positive GitHub ref lookups. |
| `GITHUB_LOOKUP_NEGATIVE_CACHE_TTL` | `10000` | In-memory TTL (ms) for negative GitHub ref lookups. |
| `INFORMATION_LEVEL` | `2` | Log verbosity: `0` everything, `1` warnings and errors, `2` errors only. |

Copy `.env.example` to `.env` and fill in at least `INTERNAL_SERVICE_TOKEN` before starting.

## Running locally

### npm (processes, no Docker)

Start the three services in separate terminals. The downloader defaults to port 8081, the builder to 8082, and the router to 8080.

```bash
# Terminal 1
INTERNAL_SERVICE_TOKEN=dev-token node downloader-server.js

# Terminal 2
INTERNAL_SERVICE_TOKEN=dev-token DOWNLOADER_URL=http://127.0.0.1:8081 node builder-server.js

# Terminal 3
INTERNAL_SERVICE_TOKEN=dev-token DOWNLOADER_URL=http://127.0.0.1:8081 BUILDER_URL=http://127.0.0.1:8082 npm run start:router
```

### Docker Compose

```bash
# Copy the example env file and set a token
cp .env.example .env
# Edit .env: set INTERNAL_SERVICE_TOKEN and optionally GITHUB_TOKEN

# Build and start all three services; --wait blocks until all healthchecks pass
docker compose up --build --wait

# The router is available at http://localhost:8080
# Downloader and builder have no host ports and are accessible only by service name
```

#### Verify health

```bash
curl http://localhost:8080/health
# "OK"
```

#### Hurl integration tests

```bash
# Smoke test (requires a running stack)
hurl test/hurl/smoke.hurl

# Service-split contract tests (build modes, headers, status codes)
hurl test/hurl/service-split.hurl

# All tests
hurl test/hurl/*.hurl
```

#### Artillery load tests (local target)

```bash
# The package script writes a report to /tmp/artillery-report
npm run artillery-test
```

The Artillery configuration targets `localhost:8080` by default. Override the target before running if your router is on a different host or port.

#### Teardown

```bash
docker compose down
```

## Usage

### Basic examples

```
# Master branch
https://github.highcharts.com/master/highcharts.src.js

# Version tag
https://github.highcharts.com/v10.3.3/highcharts.src.js

# Commit SHA (full or short)
https://github.highcharts.com/abc1234/highcharts.src.js

# Feature branch
https://github.highcharts.com/feature/my-branch/highcharts.src.js

# Modules
https://github.highcharts.com/master/modules/exporting.src.js

# Stock / Maps / Gantt
https://github.highcharts.com/master/highstock.src.js
https://github.highcharts.com/master/highmaps.src.js
https://github.highcharts.com/master/highcharts-gantt.src.js

# Dashboards
https://github.highcharts.com/master/dashboards/dashboards.src.js
```

### Response headers

Every file response from the router includes:

| Header | Value |
|---|---|
| `ETag` | Full 40-character commit SHA |
| `Cache-Control` | `max-age=3600` (or `no-store` for 429 responses) |
| `X-Built-With` | `assembler` or `esbuild` (absent for static file hits) |
| `X-GitHub-RateLimit-Remaining` | Forwarded from GitHub when available |
| `X-GitHub-RateLimit-Reset` | Forwarded from GitHub when available |

## Build modes

The router automatically selects a build mode based on the branch and request. The following modes are available:

### Static files

Files that already exist in the downloaded source tree under `js/` (pre-built JavaScript, CSS) are served directly by the downloader without invoking the builder.

### Classic assembler (v10 and earlier)

TypeScript sources are compiled with `tsc` and then bundled with `@highcharts/highcharts-assembler` into UMD output. The `X-Built-With` response header is `assembler`.

### Webpack (v12)

Branches where `tsconfig.json` sets `"outDir": "code/es-modules/"` are built with webpack. The public `X-Built-With` header remains `assembler` to preserve compatibility with callers that check this header.

### Dashboards

Requests under `/<ref>/dashboards/` are compiled by the builder in `dashboards` mode.

### esbuild (explicit)

Append `?esbuild` to any request URL to compile with esbuild instead of the standard pipeline:

```
http://localhost:8080/master/highcharts.src.js?esbuild
http://localhost:8080/v11.4.0/modules/exporting.src.js?esbuild
```

The response includes `X-Built-With: esbuild`.

### esbuild (automatic, v13+)

Highcharts v13 introduced dynamic `import()` and ES2020 module syntax that the assembler cannot handle. When the downloader resolves a ref, it performs a HEAD request to check for `ts/masters/highcharts-autoload.src.ts` in that commit (5-second timeout, result cached in memory). If the file exists, the router forces esbuild mode regardless of whether `?esbuild` was supplied.

This detection is transparent: callers using v13+ branches receive `X-Built-With: esbuild` without any change to their request.

## Source archive roots

The downloader fetches the following directory trees from GitHub for each commit:

| Path | Required |
|---|---|
| `ts` | Yes |
| `css` | Yes |
| `js` | Optional (created as empty directory if absent) |
| `tools/webpacks` | Optional (created as empty directory if absent) |
| `tools/libs` | Optional (created as empty directory if absent) |

A `.complete` marker file is written after a successful download. Concurrent requests for the same commit wait on a shared job queue rather than triggering duplicate downloads. Duplicate cache misses between separate instances are accepted; there is no cross-instance coordination.

## Caching

Both internal services maintain ephemeral, isolated caches:

- **Downloader** stores source trees under `/app/downloader-cache` (container path). In Docker Compose this is mounted as a tmpfs and is discarded when the container stops.
- **Builder** stores compiled output under `/app/tmp` (container path). Also a tmpfs mount, also discarded on container stop.

There is no shared persistence or shared filesystem between services. Cache cleanup runs on a timer in each service; entries older than the configured lifetime are removed.

## Containers and images

Three Dockerfiles produce three GHCR images:

| Dockerfile | Image name | npm script |
|---|---|---|
| `Dockerfile.router` | `ghcr.io/${{ github.repository }}` | `start:router` |
| `Dockerfile.downloader` | `ghcr.io/${{ github.repository }}-downloader` | `start:downloader` |
| `Dockerfile.builder` | `ghcr.io/${{ github.repository }}-builder` | `start:builder` |

All three images:
- Use `node:lts-alpine` as the base.
- Run as the unprivileged `node` user.
- Use `tini` as PID 1 to handle signals and reap zombies.
- Mount their cache directories as tmpfs in Docker Compose.

The builder image includes all devDependencies (`npm ci` without `--omit=dev`) because it needs the TypeScript compiler, webpack, and esbuild at runtime. The router and downloader images install production dependencies only.

### Build-once, promote by tag

Images are built once per commit via `build_and_deploy.yml`. The initial tag format is:

```
<version>-build.<run_number>
```

The `docker_deploy.yml` workflow re-tags (promotes) the same immutable image to environment-specific tags without rebuilding:

```
<version>-dev        # development environment
<version>-staging    # staging environment
<version>            # production environment
```

Platform manifests, DNS configuration, and deployment credentials are managed outside this repository.

## Highsoft rollout procedure

This section describes the external operational procedure for promoting new service images through environments. It does not prescribe any specific infrastructure tooling.

**Order of promotion**: downloader → builder → router. Rolling back any service means pulling the previous immutable image tag for that service.

For each environment (development → staging → production):

1. Pull and tag the new image for the service being promoted.
2. Check `/health` on the new container before switching traffic.
3. Verify that internal 401 errors do not appear (token configuration is correct).
4. Run smoke requests through the router and confirm expected `X-Built-With` headers and HTTP 200 responses.
5. Monitor build latency, error rates, and queue-full 202 responses for several minutes.
6. Promote the next service in the chain.

To roll back, re-tag the prior image version to the environment tag and restart the container. The router can be rolled back independently of the internal services as long as its internal API expectations remain compatible.

## Monitoring

Watch these signals in production:

| Signal | What it indicates |
|---|---|
| `/health` returning non-200 | Service is unhealthy; do not promote to next environment |
| Internal 401 responses | `INTERNAL_SERVICE_TOKEN` mismatch between router and internal services |
| 5xx responses from builder | Compilation failures; check build logs for TypeScript or webpack errors |
| Service timeout (504) | Router could not reach downloader or builder within configured timeout |
| 202 (queue full) | Builder or downloader queue is saturated; consider increasing `MAX_QUEUE_SIZE` or adding capacity |
| `X-GitHub-RateLimit-Remaining` approaching zero | GitHub API rate limit is nearly exhausted; set or rotate `GITHUB_TOKEN` |
| GitHub 403 with rate remaining = 0 | Rate limit hit; router returns 429 to the public client |
| Build latency increasing | May indicate cold cache or resource contention in the builder |
| Downloader cache miss rate | High miss rate on a warm instance may indicate tmpfs pressure or frequent purges |
| Builder tmpfs disk use | Monitor `/app/tmp` usage; tmpfs is bounded by container memory |

## Updating the assembler

```bash
npm install highcharts/highcharts-assembler#<tag>
```

Update the version reference in `package.json`, commit, and proceed to deployment.

## Development

### Run tests

```bash
npm test
```

This runs `tsc`, then lint (`standard`), then unit tests with Mocha.

### Coverage

```bash
npm run coverage
```

### Lint

```bash
npm run lint
```

### Build deployment archive

```bash
npm run build
```

Produces `github.highcharts-<version>.zip`.

### Update version

```bash
npm version [patch|minor|major]
git push && git push --tags
```

The `VERSION` file (read by the CI workflow) must match `package.json` version.

## File structure

| Path | Description |
|---|---|
| `app/` | Application modules shared by all three services |
| `app/router.js` | Express router: public request handling, mode selection, service proxying |
| `app/downloader-service.js` | Downloader business logic: ref resolution, source download, esbuild detection |
| `app/builder-service.js` | Builder business logic: compilation dispatch, build caching |
| `app/service-client.js` | HTTP client used by the router (and builder) to call internal services |
| `app/esbuild.js` | esbuild compilation engine: UMD wrapper generation |
| `app/build.js` | Classic assembler and webpack build logic |
| `app/handlers.js` | Shared Express handlers (health, webhook, filesystem debug) |
| `app/interpreter.js` | URL parsing: branch extraction, file path resolution, type detection |
| `app/JobQueue.js` | Concurrency limiter used by downloader and builder |
| `assets/` | CSS, images, favicon |
| `static/` | HTML served directly by the router |
| `test/` | Unit tests and Hurl integration tests |
| `test/hurl/` | Hurl test files for smoke, service-split, esbuild, and dashboards |
| `scripts/` | Deployment tooling (not deployed with the application) |

## Code documentation

Each source file has a descriptive header. Public functions carry JSDoc comments.

## Troubleshooting

**Request returns 202 (Accepted)**
The build or download queue is full. The request was not processed. Retry after a moment or increase `MAX_QUEUE_SIZE`.

**Request returns 429**
The GitHub API rate limit has been hit. Set `GITHUB_TOKEN` in the downloader's environment to increase the limit from 60 to 5000 requests per hour.

**Build returns JavaScript with `console.error()`**
esbuild encountered a compilation error. The response is still executable JavaScript that logs the error to the console. Check the server logs for details.

**Unexpected cached result**
The builder and downloader caches are tmpfs mounts in Docker Compose and are discarded on container restart. For npm-only runs, delete the `tmp/` and `downloader-cache/` directories and retry.

**Branch not found**
Verify the branch exists in the Highcharts repository. Short SHAs (7 or 10 characters) are supported but must match an actual commit.

**Stale sources**
Sources are cached by full commit SHA and do not expire until the cache lifetime is reached. A branch name always resolves to the current tip commit; subsequent requests use the new SHA automatically.
