/**
 * Setup of url routing, takes care of serving any result, and handling of errors.
 * @author Jon Arild Nygard
 */
'use strict';
const express = require('express');
const router = express.Router();
const D = require('./download.js');
const I = require('./interpreter.js');
const U = require('./utilities.js');
const build = require('../assembler/build.js').build;
const tmpFolder = './tmp/';
const downloadURL = 'https://raw.githubusercontent.com/highcharts/highcharts/';

/**
 * Handle any errors that is catched in the routers.
 * Respond with a proper message to the requester.
 * @param  {Error|string} err Can either be an Error object
 * @param  {object} res Express response object.
 * @return {undefined}
 * @todo Stop logging the error in seperate files, output them to the same log file in stead.
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
	.then(() => (result.delete && result.file) ? U.removeFile(result.file) : '');
};

/**
 * Used to handle a request for a static file.
 * @param  {string} repositoryURL Url to download the file.
 * @param  {string} requestURL The url which the request was sent to.
 * @return {Promise} Returns a promise which resolves after file is downloaded.
 */
const serveStaticFile = (repositoryURL, requestURL) => {
	const branch = I.getBranch(requestURL);
	const file = I.getFile(branch, 'classic', requestURL);
	const folder = tmpFolder + branch + '/';
	const outputFolder = folder + 'output/';
	return new Promise((resolve, reject) => {
		(U.exists(outputFolder + file) ? 
			Promise.resolve({ status: 200 }) : 
			D.downloadFile(repositoryURL + branch + '/js/', file, outputFolder)
		).then(result => {
			resolve({
				file: ((result.status === 200) ? U.cleanPath(__dirname + '/../' + outputFolder + file) : false),
				status:((result.status === 200) ? 200 : 404),
				message: ((result.status === 200) ? false : 'Could not find file ' + branch + '/' + file)
			})
		})
		.catch(reject)
	});
}

/**
 * Used to handle requests for non-static files.
 * Downloads the source files for the given branch/tag/commit if they are not already in the filesystem.
 * Builds the requested file, if the file already exists it skips the build and serves the existing one. 
 * @param  {string} repositoryURL Url to download the file.
 * @param  {string} requestURL The url which the request was sent to.
 * @return {Promise} Returns a promise which resolves after file is built.
 */
const serveBuildFile = (repositoryURL, requestURL) => {
	const branch = I.getBranch(requestURL);
	const type = I.getType(branch, requestURL);
	const file = I.getFile(branch, type, requestURL);
	const folder = tmpFolder + branch + '/';
	const outputFolder = folder + 'output/';
	return (U.exists(folder + 'js/masters/') ? Promise.resolve() : D.downloadJSFolder(folder, repositoryURL, branch))
		.then(() => {
			let obj = {
				file: U.cleanPath(__dirname + '/../' + outputFolder + (type === 'css' ? 'js/' : '') + file),
				status: 200
			};
			const fileExists = U.exists(outputFolder + (type === 'css' ? 'js/' : '') + file);
			const mastersExists = U.exists(folder + 'js/masters/' + file);
			if (!mastersExists) {
				obj = {
					status: 404
				};
			} else if (!fileExists) {
				const fileOptions = I.getFileOptions(folder + 'js/masters/');
				build({
					base: folder + 'js/masters/',
					output: outputFolder,
					files: [file],
					pretty: false,
					type: type,
					version: branch,
					fileOptions: fileOptions
				});
			}
			return obj;
		})
		.catch(Promise.reject);
}

/**
 * Used to handle request from the Highcharts Download Builder.
 * @param  {string} jsonParts Requested part files.
 * @param  {boolean} compile Wether or not to run the Closure Compiler on result.
 * @return {Promise} Returns a promise which resolves after file is built.
 */
const serveDownloadFile = (jsonParts, compile) => {
	return new Promise((resolve, reject) => {
		const C = require('./compiler.js');
		const parts = JSON.parse(jsonParts);
		const importFolder = '../../source/download/js/';
		const sourceFolder = './source/download/js/';
		const version = '5.0.14 custom build'; // @todo Improve logic for versioning.
		const folder = tmpFolder + 'download/';
		const outputFolder = folder + 'output/'; 
		let outputFile = 'custom.src.js';
		let imports = ['/**', ' * @license @product.name@ JS v@product.version@ (@product.date@)', ' *', ' * (c) 2009-2016 Torstein Honsi', ' *', ' * License: www.highcharts.com/license', ' */'];
		imports.push('\'use strict\';');
		imports.push('import Highcharts from \'' + importFolder + 'parts/Globals.js\';');
		imports = imports.concat(parts.reduce((arr, path) => {
			if (U.exists(sourceFolder + path)) {
				arr.push('import \'' + importFolder + path + '\';');
			}
			return arr;
		}, []));
		imports.push('export default Highcharts;\r\n');
		U.writeFile(folder + outputFile, imports.join('\r\n'));
		build({
			base: folder,
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
			resolve({ 
				file: U.cleanPath(__dirname + '/../' + outputFolder + outputFile),
				delete: true
			});
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
 * Listens to push events from a Github Webhook.
 * Validates if the payload is secure, then removes the cached source files which needs an update.
 * The removed source files will get a fresh download next time they are requested.
 */
router.post('/update', (req, res) => {
	const W = require('./webhook.js');
	const body = req.body;
	let hook = W.validateWebHook(req);
	let status = 500;
	let	message = hook.message;
	let exists = false;
	let path = '';
	if (hook.valid) {
		const ref = body.ref;
		const branch = ref.split('/').pop();
		if (branch) {
			path = tmpFolder + branch;
			exists = U.exists(path);
			message = exists ? 'OK' : `Folder of branch "${branch}" did not exists`;
			status = exists ? 200 : status;
		} else {
			message = 'Referenced branch was not valid';
		}
	}

	(exists ? U.removeDirectory(path) : Promise.resolve(false))
	.then(() => ({
		status: status,
		message: message
	}))
	.then(result => handleResult(result, res))
	.catch(err => handleError(err, res));
});

/**
 * Requests to /favicon.ico
 * Always returns the icon file.
 * @todo Use express.static in stead if send file.
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
		.then(result => result ? serveBuildFile(downloadURL, req.url) : serveStaticFile(downloadURL, req.url))
		.then(result => handleResult(result, res))
		.catch(err => handleError(err, res));
});

module.exports = router;
