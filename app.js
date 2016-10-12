'use strict';

const initRepository = () => {
	const U = require('./helper/utilities.js');
	const workingDir = 'github';
	U.createDirectory(workingDir);
	const repository = 'https://github.com/highcharts/highcharts.git';
	const simpleGit = require('simple-git')(__dirname + '/' + workingDir);
	return simpleGit
		.init()
		.then(() => {
			U.writeFile(workingDir + '/.git/info/sparse-checkout', '/js/');
		})
		.addConfig('core.sparsecheckout', 'true')
		.addRemote('origin', repository)
		.fetch()
		.checkout('origin', 'master');
};

const start = () => {
	const express = require('express');
	const router = require('./routes/router.js');
	const app = express();
	const port = process.env.PORT || 8085;
	const U = require('./helper/utilities.js');
	(U.exists('github') ? Promise.resolve('Exists') : initRepository())
		.then((res) => {
			app.use('/', router); // Register router
			app.listen(port); // Start server
		})
};

start();
