'use strict';
const express = require('express');
const path = require('path');
const router = express.Router();
const D = require('../helper/download.js');
const I = require('../helper/interpreter.js');
const U = require('../helper/utilities.js');
const build = require('../assembler/build.js').build;
const output = './tmp';
const downloadURL = 'https://raw.githubusercontent.com/highcharts/highcharts/';
const fileOptions = I.getFileOptions();
const handleError = (err, res) => {
	const date = new Date();
	const name = [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()].join('-') + 'T' + [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()].join('-');
	const content = err.message + '\n\r' + err.stack;
	try {
		U.writeFile('./logs/' + name + '.log', content);
	} catch (e) {
		U.debug(true, e.message);
	}
	res.status(500)
		.send('Something went wrong. Please contact <a href="http://www.highcharts.com/support">Highcharts support</a> if this happens repeatedly.');
};

const serveStaticFile = (repositoryURL, requestURL, res) => {
	const branch = I.getBranch(requestURL);
	const file = I.getFile(branch, 'classic', requestURL);
	return new Promise(resolve => {
		D.downloadFile(repositoryURL + branch + '/js/', file, output + '/output/')
			.then(result => {
				resolve({
					file: ((result.status === 200) ? path.resolve(__dirname + '/../tmp/output/' + file) : false),
					status:((result.status === 200) ? 200 : 404)
				})
			})
			.catch(err => handleError(err, res))
	});
}

const serveBuildFile = (repositoryURL, requestURL, res) => {
	const branch = I.getBranch(requestURL);
	const type = I.getType(branch, requestURL);
	const file = I.getFile(branch, type, requestURL);
	return D.downloadJSFolder(output, repositoryURL + branch)
		.then(() => {
			let obj = {
				status: 404
			};
			if (U.exists(output + '/js/masters/' + file)) {
				build({
					base: output + '/js/masters/',
					output: output + '/output/',
					files: [file],
					type: type,
					fileOptions: fileOptions
				});
				obj = {
					file: path.resolve(__dirname + '/../tmp/output/' + file),
					status: 200
				}
			}
			return obj;
		})
		.catch(err => handleError(err, res));
}


router.get('/favicon.ico', (req, res) => {
	const pathIndex = path.resolve(__dirname + '/../assets/favicon.ico');
	res.sendFile(pathIndex);  
});

router.get('/', (req, res) => {
	if (req.query.parts) {
		const branch = 'krevje';
		D.downloadJSFolder(output, downloadURL + branch);
		res.json({
			message: 'return a file'
		});
	} else {
		const pathIndex = path.resolve(__dirname + '/../views/index.html');
		res.sendFile(pathIndex);  
	}
});

router.get('*', (req, res) => {
	const branch = I.getBranch(req.url);
	D.urlExists(downloadURL + branch + '/assembler/build.js')
		.then(result => result ? serveBuildFile(downloadURL, req.url, res) : serveStaticFile(downloadURL, req.url, res))
		.then(result => {
			if (result.file) {
				res.sendFile(result.file);
			} else {
				res.status(result.status)
					.send('Invalid file path ' + req.url + '.<br>Do you think this is an error, or you need help to continue, please contact <a href="http://www.highcharts.com/support">Highcharts support</a>.');
			}
		})
		.catch(err => handleError(err, res));
});

module.exports = router;
