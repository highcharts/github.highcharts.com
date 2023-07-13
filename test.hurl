GET http://localhost:8080
HTTP 200

GET http://localhost:8080/94575e3d713ccb18c96485745cbc865857c81909/dashboards/dashboards.src.js
HTTP 200

# can I comment like this?

GET http://localhost:8080/94575e3d713ccb18c96485745cbc865857c81909/dashboards/dashboards.js
HTTP 404

GET http://localhost:8080/94575e3d713ccb18c96485745cbc865857c81909/dashboards/Dashboards/Globals.js
HTTP 200
