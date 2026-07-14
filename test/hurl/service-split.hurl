# Router health
GET http://localhost:8080/health
HTTP 200
[Asserts]
body == "OK"

# Existing static asset
GET http://localhost:8080/test.html
HTTP 200
[Asserts]
body contains "<title>Test chart please ignore</title>"

# Explicit esbuild
GET http://localhost:8080/master/highcharts-autoload.src.js?esbuild
HTTP 200
[Asserts]
header "X-Built-With" == "esbuild"
header "Cache-Control" == "max-age=3600"
header "ETag" exists
body contains "Highcharts"

# Automatic esbuild
GET http://localhost:8080/master/highcharts-autoload.src.js
HTTP 200
[Asserts]
header "X-Built-With" == "esbuild"
header "ETag" exists
body contains "Highcharts"

# Pre-webpack assembler release
GET http://localhost:8080/v10.3.3/highcharts.src.js
HTTP 200
[Asserts]
header "X-Built-With" == "assembler"
header "ETag" exists
body contains "Highcharts"

# Webpack release (public header retains the assembler contract)
GET http://localhost:8080/v12.4.0/highcharts.src.js
HTTP 200
[Asserts]
header "X-Built-With" == "assembler"
header "ETag" exists
body contains "Highcharts"

# Dashboards
GET http://localhost:8080/master/dashboards/dashboards.src.js
HTTP 200
[Asserts]
header "ETag" exists
body contains "Dashboards"
