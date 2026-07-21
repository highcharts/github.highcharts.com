POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{
  "token": "{{token}}"
}
HTTP 201
[Captures]
csrf: jsonpath "$.csrfToken"

POST {{base_url}}/__ops-test/reset-audits
{}
HTTP 200

POST {{base_url}}/__ops-test/fixture
Content-Type: application/json
{
  "service": "downloader",
  "cache": "healthy",
  "resetCounts": true
}
HTTP 200

# Named healthy operation completes with one dispatch and one sanitized audit.
POST {{base_url}}/_ops/api/v1/cache-operations
Origin: {{base_url}}
X-Ops-CSRF: {{csrf}}
Content-Type: application/json
{
  "operation": "cache.clear",
  "targets": ["downloader"]
}
HTTP 200
[Asserts]
jsonpath "$.outcome" == "completed"
jsonpath "$.targets[0].outcome" == "completed"
header "Content-Length" toInt < 65536

GET {{base_url}}/__ops-test/status
HTTP 200
[Asserts]
jsonpath "$.audits" == 1
jsonpath "$.auditSafe" == true
jsonpath "$.downloader.cache" == 1

# Wrong Origin and CSRF never dispatch a mutation.
POST {{base_url}}/_ops/api/v1/cache-operations
Origin: http://evil.invalid
X-Ops-CSRF: {{csrf}}
Content-Type: application/json
{"operation":"cache.clear","targets":["downloader"]}
HTTP 403

POST {{base_url}}/_ops/api/v1/cache-operations
Origin: {{base_url}}
X-Ops-CSRF: wrong
Content-Type: application/json
{"operation":"cache.clear","targets":["downloader"]}
HTTP 403

GET {{base_url}}/__ops-test/status
HTTP 200
[Asserts]
jsonpath "$.downloader.cache" == 1
jsonpath "$.audits" == 3
jsonpath "$.auditSafe" == true

# An unavailable target fails once without retry.
POST {{base_url}}/__ops-test/fixture
Content-Type: application/json
{
  "service": "builder",
  "cache": "disconnect",
  "resetCounts": true
}
HTTP 200

POST {{base_url}}/_ops/api/v1/cache-operations
Origin: {{base_url}}
X-Ops-CSRF: {{csrf}}
Content-Type: application/json
{"operation":"cache.clear","targets":["builder"]}
HTTP 200
[Asserts]
jsonpath "$.outcome" == "failed"
jsonpath "$.targets[0].error.code" == "SERVICE_UNAVAILABLE"
header "Content-Length" toInt < 65536

GET {{base_url}}/__ops-test/status
HTTP 200
[Asserts]
jsonpath "$.builder.cache" == 1
jsonpath "$.audits" == 4

# A response beyond ten seconds is ambiguous, bounded, audited, and not retried.
POST {{base_url}}/__ops-test/fixture
Content-Type: application/json
{
  "service": "builder",
  "cache": "slow",
  "resetCounts": true
}
HTTP 200

POST {{base_url}}/_ops/api/v1/cache-operations
Origin: {{base_url}}
X-Ops-CSRF: {{csrf}}
Content-Type: application/json
{"operation":"cache.clear","targets":["builder"]}
HTTP 200
[Asserts]
jsonpath "$.outcome" == "unknown"
jsonpath "$.targets[0].error.code" == "SERVICE_TIMEOUT"
header "Content-Length" toInt < 65536

GET {{base_url}}/__ops-test/status
HTTP 200
[Asserts]
jsonpath "$.builder.cache" == 1
jsonpath "$.audits" == 5
jsonpath "$.auditSafe" == true
