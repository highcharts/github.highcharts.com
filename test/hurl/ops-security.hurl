# This suite runs after the stack is restarted with the console disabled.
GET {{base_url}}/_ops
HTTP 404

GET {{base_url}}/_ops/
HTTP 404

GET {{base_url}}/_ops/login
HTTP 404

GET {{base_url}}/_ops/console.js
HTTP 404

GET {{base_url}}/_ops/api/v1/session
HTTP 404

POST {{base_url}}/_ops/api/v1/session
Content-Type: application/json
{}
HTTP 404

GET {{base_url}}/health
HTTP 200
[Asserts]
body == "OK"

GET {{base_url}}/
HTTP 200
[Asserts]
body contains "github.highcharts.com"

GET {{base_url}}/cleanup?true
HTTP 200
