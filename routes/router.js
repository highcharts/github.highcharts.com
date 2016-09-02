'use strict';
const express = require('express');
const path = require('path');
const router = express.Router();
router.get('/', (req, res) => {
	const pathIndex = path.resolve(__dirname + '/../views/index.html');
    res.sendFile(pathIndex);   
});

router.get('*', (req, res) => {
	res.json({
		message: 'Hello World'
	});
});

module.exports = router;
