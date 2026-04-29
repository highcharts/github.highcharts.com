# Autoload esbuild integration tests
GET http://localhost:8080/trettan/highcharts-autoload.src.js?esbuild
HTTP 200
X-Built-With: esbuild

GET http://localhost:8080/trettan/highcharts-autoload.js?esbuild
HTTP 200
X-Built-With: esbuild

# Data sorting module (source)
GET http://localhost:8080/trettan/modules/data-sorting.src.js?esbuild
HTTP 200
[Asserts]
header "X-Built-With" == "esbuild"

# Data sorting module (minified)
GET http://localhost:8080/trettan/modules/data-sorting.js?esbuild
HTTP 200
[Asserts]
header "X-Built-With" == "esbuild"

# Auto-detect v13+ branch → force esbuild (no ?esbuild param)
GET http://localhost:8080/trettan/highcharts-autoload.src.js
HTTP 200
[Asserts]
header "X-Built-With" == "esbuild"
