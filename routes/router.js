'use strict';
const express = require('express');
const path = require('path');
const router = express.Router();
const helper = require('../helper/download.js');
const interpreter = require('../helper/interpreter.js');
const build = require('../assembler/build.js').build;
const downloadJSFolder = helper.downloadJSFolder;
const downloadAssembler = helper.downloadAssembler;
const output = './tmp';

router.get('/favicon.ico', (req, res) => {
	const pathIndex = path.resolve(__dirname + '/../assets/favicon.ico');
	res.sendFile(pathIndex);  
});

router.get('/', (req, res) => {
	if (req.query.parts) {
		const branch = 'krevje';
		downloadJSFolder(output, 'https://raw.githubusercontent.com/highcharts/highcharts/' + branch);
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
	const type = interpreter.getType(branch, req.url);
	const file = interpreter.getFile(branch, type, req.url);
	const url = 'https://raw.githubusercontent.com/highcharts/highcharts/' + branch;
	downloadAssembler(output, url)
		.then(result => (result[0].status === 200) ? downloadJSFolder(output, url) : false)
		.then(result => {
			let msg = false;
			if (result !== false) {
				try {
					build({
						base: output + '/js/masters/',
						output: output + '/output/',
						files: [file],
						type: type
					});
					msg = path.resolve(__dirname + '/../tmp/output/' + file);
				} catch (err) {
					console.log(err)
					console.log(err.stack)
				}
			}
			return msg;
		})
		.then(result => {
			if (result) {
				res.sendFile(result);
			} else {
				res.status(404)
					.send('Invalid file path ' + req.url + '.<br>Do you think this is an error, or you need help to continue, please contact <a href="http://www.highcharts.com/support">Highcharts support</a>.');
			}
		});
});

module.exports = router;
