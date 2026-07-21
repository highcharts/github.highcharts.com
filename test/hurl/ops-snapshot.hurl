POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{
  "token": "{{token}}"
}
HTTP 201

# A service down before any success is unknown; the other slot remains fresh.
POST {{base_url}}/__ops-test/fixture
Content-Type: application/json
{
  "service": "builder",
  "snapshot": "disconnect",
  "resetCounts": true
}
HTTP 200

POST {{base_url}}/__ops-test/fixture
Content-Type: application/json
{
  "service": "downloader",
  "snapshot": "fresh",
  "resetCounts": true
}
HTTP 200

GET {{base_url}}/_ops/api/v1/snapshot
HTTP 200
[Asserts]
jsonpath "$.schemaVersion" == 1
jsonpath "$.services.downloader.freshness" == "fresh"
jsonpath "$.services.builder.freshness" == "unknown"
jsonpath "$.services.builder.error.code" == "SERVICE_UNAVAILABLE"
header "Content-Length" toInt < 1048576

# Recovery is visible on the next refresh.
POST {{base_url}}/__ops-test/fixture
Content-Type: application/json
{
  "service": "builder",
  "snapshot": "fresh"
}
HTTP 200

GET {{base_url}}/_ops/api/v1/snapshot
HTTP 200
[Asserts]
jsonpath "$.services.downloader.freshness" == "fresh"
jsonpath "$.services.builder.freshness" == "fresh"
jsonpath "$.services.downloader.snapshot.cache.entries" count == 1

# The 1.5 second downloader timeout is independent; builder remains fresh and
# the prior downloader success becomes stale.
POST {{base_url}}/__ops-test/fixture
Content-Type: application/json
{
  "service": "downloader",
  "snapshot": "slow"
}
HTTP 200

GET {{base_url}}/_ops/api/v1/snapshot
HTTP 200
[Asserts]
jsonpath "$.services.downloader.freshness" == "stale"
jsonpath "$.services.downloader.error.code" == "SERVICE_TIMEOUT"
jsonpath "$.services.builder.freshness" == "fresh"

# Oversized and malformed internal payloads are bounded and never forwarded.
POST {{base_url}}/__ops-test/fixture
Content-Type: application/json
{
  "service": "downloader",
  "snapshot": "oversized"
}
HTTP 200

GET {{base_url}}/_ops/api/v1/snapshot
HTTP 200
[Asserts]
jsonpath "$.services.downloader.freshness" == "stale"
jsonpath "$.services.downloader.error.code" == "SERVICE_RESPONSE_TOO_LARGE"
body not contains "padding"
header "Content-Length" toInt < 1048576

POST {{base_url}}/__ops-test/fixture
Content-Type: application/json
{
  "service": "downloader",
  "snapshot": "malformed"
}
HTTP 200

GET {{base_url}}/_ops/api/v1/snapshot
HTTP 200
[Asserts]
jsonpath "$.services.downloader.freshness" == "stale"
body not contains "not-json"
