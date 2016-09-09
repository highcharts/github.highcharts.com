'use strict';
const U = require('./utilities.js');
const files = U.getFilesInFolder('../../highcharts/', 'assembler', true);
files.forEach(file => {
	U.copyFile('../../highcharts/' + file, '../' + file);
});