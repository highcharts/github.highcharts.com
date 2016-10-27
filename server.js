/**
 * Server application. 
 * Fires up a server using ExpressJS, and registers routers, and starts listening to a port.
 * All processes related to startup belongs in this script.
 * @author Jon Arild Nygard
 * @todo Add license
 */
'use strict';
const express = require('express');
const router = require('./app/router.js');
const bodyParser = require('body-parser');
const config = require('./config.json');
const app = express();
const port = process.env.PORT || config.port || 80;

console.log('Listening to port: ' + port);

app.use(bodyParser.json());
app.use('/', router); // Register router
app.listen(port); // Start server
