'use strict';
const express = require('express');
const router = require('./app/router.js');
const config = require("./config.json");
const app = express();
const port = process.env.PORT || config.port || 80;

app.use('/', router); // Register router
app.listen(port); // Start server
