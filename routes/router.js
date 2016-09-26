'use strict';
const express = require('express');
const router = express.Router();
const D = require('../helper/download.js');
const I = require('../helper/interpreter.js');
const U = require('../helper/utilities.js');
const build = require('../assembler/build.js').build;
const tmpFolder = './tmp/' + U.randomString(8) + '/';
const outputFolder = tmpFolder + 'output/' ;
const downloadURL = 'https://raw.githubusercontent.com/highcharts/highcharts/';
const fileOptions = I.getFileOptions();
const handleError = (err, res) => {
	const date = new Date();
	const name = [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()].join('-') + 'T' + [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()].join('-');
	const content = (typeof err === 'object') ? err.message + '\n\r' + err.stack : err;
	try {
		U.writeFile('./logs/' + name + '.log', content);
	} catch (e) {
		U.debug(true, e.message);
	}
	res.status(500)
		.send('Something went wrong. Please contact <a href="http://www.highcharts.com/support">Highcharts support</a> if this happens repeatedly.');
};

const handleResult = (result, res) => {
	let promise;
	if (result.file) {
		res.sendFile(result.file, () => {
			if (U.exists(tmpFolder)) {
				promise = U.removeDirectory(tmpFolder);
			}
		});
	} else {
		res.status(result.status)
			.send(result.message, () => {
				if (U.exists(tmpFolder)) {
					promise = U.removeDirectory(tmpFolder);
				}
			});
	}
	return promise;
};

const serveStaticFile = (repositoryURL, requestURL, res) => {
	const branch = I.getBranch(requestURL);
	const file = I.getFile(branch, 'classic', requestURL);
	return new Promise(resolve => {
		D.downloadFile(repositoryURL + branch + '/js/', file, outputFolder)
			.then(result => {
				resolve({
					file: ((result.status === 200) ? U.cleanPath(__dirname + '/../' + outputFolder + file) : false),
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
	return D.downloadJSFolder(tmpFolder, repositoryURL + branch)
		.then(() => {
			let obj = {
				status: 404
			};
			if (U.exists(tmpFolder + 'js/masters/' + file)) {
				build({
					base: tmpFolder + 'js/masters/',
					output: outputFolder,
					files: [file],
					type: type,
					version: branch,
					fileOptions: fileOptions
				});
				obj = {
					file: U.cleanPath(__dirname + '/../' + outputFolder + file),
					status: 200
				}
			}
			return obj;
		})
		.catch(err => handleError(err, res));
}

const serveDownloadFile = (jsonParts, compile) => {
	return new Promise((resolve, reject) => {
		const parts = JSON.parse(jsonParts);
		const importFolder = '../../source/download/js/';
		const sourceFolder = './source/download/js/';
		const version = '5.0.0-custom'; // @todo Improve logic for versioning.
		let imports = ['import Highcharts from \'' + importFolder + 'parts/Globals.js\';'];
		imports = imports.concat(parts.reduce((arr, obj) => {
			let path = obj.baseUrl + '/' + obj.name + '.js'
			if (U.exists(sourceFolder + path)) {
				arr.push('import \'' + importFolder + path + '\';');
			}
			return arr;
		}, []));
		imports.push('exports Highcharts;\n\r');
		U.writeFile(tmpFolder + 'custom.js', imports.join('\n\r'));
		build({
			base: tmpFolder,
			jsBase: sourceFolder,
			output: outputFolder,
			files: ['custom.js'],
			type: 'classic',
			version: version
		});
		if (U.exists(outputFolder + 'custom.js')) {
			resolve({
				file: U.cleanPath(__dirname + '/../' + outputFolder + 'custom.js')
			})
		} else {
			reject('Could not find the compiled file. Path: ' + outputFolder + 'custom.js');
		}
	});
};


router.get('/favicon.ico', (req, res) => {
	const pathIndex = U.cleanPath(__dirname + '/../assets/favicon.ico');
	res.sendFile(pathIndex);  
});

router.get('/', (req, res) => {
	const parts = req.query.parts;
	const compile = req.query.compile === 'true';
	(parts ? serveDownloadFile(parts, compile) : Promise.resolve({ file: U.cleanPath(__dirname + '/../views/index.html') }))
		.then(result => handleResult(result, res))
		.catch(err => handleError(err, res));
});

router.get('*', (req, res) => {
	const branch = I.getBranch(req.url);
	D.urlExists(downloadURL + branch + '/assembler/build.js')
		.then(result => result ? serveBuildFile(downloadURL, req.url, res) : serveStaticFile(downloadURL, req.url, res))
		.then(result => handleResult(result, res))
		.catch(err => handleError(err, res));
});

module.exports = router;
