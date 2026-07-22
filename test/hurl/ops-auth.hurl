# Invalid credentials are generic and never reflected.
POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{
  "token": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
}
HTTP 401
[Asserts]
jsonpath "$.error.code" == "UNAUTHORIZED"
body not contains "BBBB"
header "Cache-Control" == "no-store"
header "Content-Security-Policy" == "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'"
header "X-Content-Type-Options" == "nosniff"
header "Referrer-Policy" == "no-referrer"
header "Permissions-Policy" == "camera=(), microphone=(), geolocation=()"
header "Cross-Origin-Opener-Policy" == "same-origin"
header "Cross-Origin-Resource-Policy" == "same-origin"
header "X-Frame-Options" == "DENY"
header "Access-Control-Allow-Origin" not exists

# Loopback mode uses the non-Secure development cookie.
POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{
  "token": "{{token}}"
}
HTTP 201
[Captures]
old_cookie: header "Set-Cookie" regex "ghhc-console-dev=([^;]+)"
csrf: jsonpath "$.csrfToken"
[Asserts]
header "Set-Cookie" matches /^ghhc-console-dev=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/$/
header "Set-Cookie" not contains "Secure"
jsonpath "$.authenticated" == true

GET {{base_url}}/_ops/api/v1/session
Cookie: ghhc-console-dev={{old_cookie}}
HTTP 200
[Asserts]
jsonpath "$.authenticated" == true

# Replacement login rotates the session ID and revokes the old session.
POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
Cookie: ghhc-console-dev={{old_cookie}}
{
  "token": "{{token}}"
}
HTTP 201
[Captures]
new_cookie: header "Set-Cookie" regex "ghhc-console-dev=([^;]+)"
csrf: jsonpath "$.csrfToken"
[Asserts]
variable "new_cookie" != "{{old_cookie}}"

GET {{base_url}}/_ops/api/v1/session
Cookie: ghhc-console-dev={{old_cookie}}
HTTP 401

GET {{base_url}}/_ops/api/v1/session
Cookie: ghhc-console-dev={{new_cookie}}
HTTP 200

# Server-side token rotation revokes every current session.
POST {{base_url}}/__ops-test/rotate
{}
HTTP 200

GET {{base_url}}/_ops/api/v1/session
Cookie: ghhc-console-dev={{new_cookie}}
HTTP 401

# Expiry is deterministic through the injected clock.
POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{
  "token": "{{token}}"
}
HTTP 201
[Captures]
expiring_cookie: header "Set-Cookie" regex "ghhc-console-dev=([^;]+)"

POST {{base_url}}/__ops-test/clock
Content-Type: application/json
{
  "advanceMs": 1800000
}
HTTP 200

GET {{base_url}}/_ops/api/v1/session
Cookie: ghhc-console-dev={{expiring_cookie}}
HTTP 401

# Logout clears and revokes the active cookie.
POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{
  "token": "{{token}}"
}
HTTP 201
[Captures]
logout_cookie: header "Set-Cookie" regex "ghhc-console-dev=([^;]+)"
logout_csrf: jsonpath "$.csrfToken"

DELETE {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
X-Ops-CSRF: {{logout_csrf}}
Cookie: ghhc-console-dev={{logout_cookie}}
HTTP 204
[Asserts]
header "Set-Cookie" contains "Max-Age=0"

GET {{base_url}}/_ops/api/v1/session
Cookie: ghhc-console-dev={{logout_cookie}}
HTTP 401

# Origin, Fetch Metadata, content type, CSRF, method, and CORS negatives.
POST {{base_url}}/_ops/api/v1/session
Origin: http://evil.invalid
Content-Type: application/json
{
  "token": "{{token}}"
}
HTTP 403
[Asserts]
jsonpath "$.error.code" == "ORIGIN_REJECTED"

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Sec-Fetch-Site: cross-site
Content-Type: application/json
{
  "token": "{{token}}"
}
HTTP 403
[Asserts]
jsonpath "$.error.code" == "FETCH_METADATA_REJECTED"

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: text/plain
{
  "token": "{{token}}"
}
HTTP 415

HEAD {{base_url}}/_ops/api/v1/session
HTTP 404

OPTIONS {{base_url}}/_ops/api/v1/session
HTTP 404
[Asserts]
header "Access-Control-Allow-Origin" not exists

# The global 30-attempt login limit produces a bounded 429 with Retry-After.
POST {{base_url}}/__ops-test/clock
Content-Type: application/json
{
  "advanceMs": 900000
}
HTTP 200

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 401

POST {{base_url}}/_ops/api/v1/session
Origin: {{base_url}}
Content-Type: application/json
{"token":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}
HTTP 429
[Asserts]
jsonpath "$.error.code" == "RATE_LIMITED"
header "Retry-After" matches /^\d+$/
