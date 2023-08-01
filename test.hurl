GET http://localhost:8080
HTTP 200

GET http://localhost:8080/master/dashboards/dashboards.src.js
HTTP 201

# can I comment like this?

GET http://localhost:8080/master/dashboards/dashboards.js
HTTP 200

# GET http://localhost:8080/master/dashboards/Dashboards/Globals.js
# HTTP 200

GET http://localhost:8080/master/dashboards/modules/dashboards-plugin.js
HTTP 201
