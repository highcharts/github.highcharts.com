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

/**
 * Handle any errors that is catched in the routers.
 * Respond with a proper message to the requester.
 * @param  {Error|string} err Can either be an Error object
 * @param  {object} res Express response object.
 * @return {undefined}
 */
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

/**
 * Handle result after processing the request.
 * Respond with a proper message to the requester.
 * @param  {object} result Object containing information of the result of the request.
 * @param  {object} res Express response object.
 * @return {Promise} Returns a promise which resolves after response is sent, and temp folder is deleted.
 */
const handleResult = (result, res) => {
	return new Promise((resolve, reject) => {
		if (result.file) {
			res.sendFile(result.file, (err) => (err ? reject(err) : resolve()));
		} else {
			res.status(result.status).send(result.message);
			resolve();
		}
	})
	.then(() => (U.exists(tmpFolder) ? U.removeDirectory(tmpFolder) : false))
};

/**
 * Used to handle a request for a static file.
 * @param  {string} repositoryURL Url to download the file.
 * @param  {string} requestURL The url which the request was sent to.
 * @param  {object} res Express response object.
 * @return {Promise} Returns a promise which resolves after file is downloaded.
 */
const serveStaticFile = (repositoryURL, requestURL, res) => {
	const branch = I.getBranch(requestURL);
	const file = I.getFile(branch, 'classic', requestURL);
	return new Promise(resolve => {
		D.downloadFile(repositoryURL + branch + '/js/', file, outputFolder)
			.then(result => {
				resolve({
					file: ((result.status === 200) ? U.cleanPath(__dirname + '/../' + outputFolder + file) : false),
					status:((result.status === 200) ? 200 : 404),
					message: ((result.status === 200) ? false : 'Could not find file ' + branch + '/' + file)
				})
			})
			.catch(err => handleError(err, res))
	});
}

/**
 * Used to handle requests for non-static files.
 * @param  {string} repositoryURL Url to download the file.
 * @param  {string} requestURL The url which the request was sent to.
 * @param  {object} res Express response object.
 * @return {Promise} Returns a promise which resolves after file is built.
 */
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
					pretty: false,
					type: type,
					version: branch,
					fileOptions: fileOptions
				});
				obj = {
					file: U.cleanPath(__dirname + '/../' + outputFolder + (type === 'css' ? 'js/' : '') + file),
					status: 200
				}
			}
			return obj;
		})
		.catch(err => handleError(err, res));
}

/**
 * Used to handle request from the Highcharts Download Builder.
 * @param  {string} jsonParts Requested part files.
 * @param  {boolean} compile Wether or not to run the Closure Compiler on result.
 * @return {Promise} Returns a promise which resolves after file is built.
 */
const serveDownloadFile = (jsonParts, compile) => {
	return new Promise((resolve, reject) => {
		const C = require('../helper/compiler.js');
		const parts = JSON.parse(jsonParts);
		const importFolder = '../../source/download/js/';
		const sourceFolder = './source/download/js/';
		const version = '5.0.0 custom build'; // @todo Improve logic for versioning.
		let outputFile = 'custom.src.js';
		let imports = ['/**', ' * @license @product.name@ JS v@product.version@ (@product.date@)', ' *', ' * (c) 2009-2016 Torstein Honsi', ' *', ' * License: www.highcharts.com/license', ' */'];
		imports.push('\'use strict\';');
		imports.push('import Highcharts from \'' + importFolder + 'parts/Globals.js\';');
		imports = imports.concat(parts.reduce((arr, obj) => {
			let path = obj.baseUrl + '/' + obj.name + '.js'
			if (U.exists(sourceFolder + path)) {
				arr.push('import \'' + importFolder + path + '\';');
			}
			return arr;
		}, []));
		imports.push('export default Highcharts;\r\n');
		U.writeFile(tmpFolder + outputFile, imports.join('\r\n'));
		build({
			base: tmpFolder,
			jsBase: sourceFolder,
			output: outputFolder,
			files: [outputFile],
			type: 'classic',
			version: version
		});
		if (compile) {
			C.compile(outputFolder + outputFile);
			outputFile = 'custom.js';
		}
		if (U.exists(outputFolder + outputFile)) {
			resolve({ file: U.cleanPath(__dirname + '/../' + outputFolder + outputFile) })
		} else {
			reject('Could not find the compiled file. Path: ' + outputFolder + outputFile);
		}
	});
};

/**
 * Health check url
 */
router.get('/health', (req, res) => {
	res.sendStatus(200);
});

/**
 * Requests to /favicon.ico
 * Always returns the icon file.
 */
router.get('/favicon.ico', (req, res) => {
	const pathIndex = U.cleanPath(__dirname + '/../assets/favicon.ico');
	res.sendFile(pathIndex);  
});

/**
 * Requests to /
 * When the parameter parts is sent, then it is a request from the Download Builder.
 * Otherwise respond with the homepage.
 */
router.get('/', (req, res) => {
	const parts = req.query.parts;
	const compile = req.query.compile === 'true';
	(parts ? serveDownloadFile(parts, compile) : Promise.resolve({ file: U.cleanPath(__dirname + '/../views/index.html') }))
		.then(result => handleResult(result, res))
		.catch(err => handleError(err, res));
});

/**
 * Everything not matching the previous routers.
 * Requests for distribution file, built with part files from github.
 */
router.get('*', (req, res) => {
	const branch = I.getBranch(req.url);
	D.urlExists(downloadURL + branch + '/assembler/build.js')
		.then(result => result ? serveBuildFile(downloadURL, req.url, res) : serveStaticFile(downloadURL, req.url, res))
		.then(result => handleResult(result, res))
		.catch(err => handleError(err, res));
});

module.exports = router;
