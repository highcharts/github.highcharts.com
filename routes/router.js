'use strict';
const express = require('express');
const path = require('path');
const router = express.Router();
const downloadJSFolder = require('../helper/download.js').downloadJSFolder;

router.get('/', (req, res) => {
	if (req.query.parts) {
		const branch = 'krevje';
		downloadJSFolder('./tmp', 'https://raw.githubusercontent.com/highcharts/highcharts/' + branch);
		res.json({
			message: 'return a file'
		});
	} else {
		const pathIndex = path.resolve(__dirname + '/../views/index.html');
		res.sendFile(pathIndex);  
	}
});

router.get('*', (req, res) => {
	const branch = 'krevje';
	downloadJSFolder('./tmp', 'https://raw.githubusercontent.com/highcharts/highcharts/' + branch);
	res.json({
		message: 'return a file'
	});
});

module.exports = router;
