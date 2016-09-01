'use strict';
const express = require('express');
const bodyParser = require('body-parser');
const app = express();
const port = process.env.PORT || 8085;
const router = express.Router();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

router.get('/', (req, res) => {
    res.sendFile(__dirname + '/views/index.html');   
});

router.get('*', (req, res) => {
	res.json({
		message: 'Hello World'
	});
});

app.use('/', router); // Register router
app.listen(port); // Start server