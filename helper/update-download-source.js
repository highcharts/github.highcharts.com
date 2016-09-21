'use strict';
const U = require('./utilities.js');
let files = U.getFilesInFolder('../../highcharts/', 'js', true).concat(U.getFilesInFolder('../../highcharts/', 'css', true));
files.filter(file => (file.endsWith('.js') || file.endsWith('.scss'))).forEach(file => {
	U.copyFile('../../highcharts/' + file, '../source/download/' + file);
});