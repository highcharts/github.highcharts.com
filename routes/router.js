'use strict';
const express = require('express');
const path = require('path');
const router = express.Router();
const helper = require('../helper/download.js');
const interpreter = require('../helper/interpreter.js');
const downloadJSFolder = helper.downloadJSFolder;
const downloadAssembler = helper.downloadAssembler;

router.get('/favicon.ico', (req, res) => {
	const pathIndex = path.resolve(__dirname + '/../assets/favicon.ico');
	res.sendFile(pathIndex);  
});

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
	const branch = interpreter.getBranch(req.url);
	const file = interpreter.getFile(branch, req.url);
	const url = 'https://raw.githubusercontent.com/highcharts/highcharts/' + branch;
	downloadAssembler('./tmp', url)
		.then(result => (result[0].status === 200) ? downloadJSFolder('./tmp', url) : false)
		.then(result => {
			let msg = false;
			if (result !== false) {
				msg = 'we have an assembler';
			}
			return msg;
		})
		.then(result => {
			let msg = result;
			if (result === false) {
				msg = 'no assembler, return static file or 404';
			}
			return msg;
		})
		.then(result => {
			res.json({
				branch: branch,
				url: req.url,
				msg: result
			})
		});
});

module.exports = router;
