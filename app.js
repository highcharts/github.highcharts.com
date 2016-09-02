'use strict';
const express = require('express');
const router = require('./routes/router.js');
const app = express();
const port = process.env.PORT || 8085;

app.use('/', router); // Register router
app.listen(port); // Start server
