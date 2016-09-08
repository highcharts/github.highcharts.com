'use strict';
const express = require('express');
const path = require('path');
const router = express.Router();
const helper = require('../helper/download.js');
const downloadJSFolder = helper.downloadJSFolder;
const downloadAssembler = helper.downloadAssembler;

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
	const url = 'https://raw.githubusercontent.com/highcharts/highcharts/' + branch;
	downloadAssembler('./tmp', url)
		.then(result => (result[0].status === 200) ? downloadJSFolder('./tmp', url) : false)
		.then(result => {
			let msg = '';
			if (result === false) {
				msg = 'no assembler, return static file or 404';
			} else {
				msg = 'we have an assembler';
			}
			res.json({
				message: msg
			});
		});
});

module.exports = router;
