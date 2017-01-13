/**
 * Script to update the Highcharts Assembler.
 * To execute run: npm run update-assembler
 * @author Jon Arild Nygard
 * @todo Add license
 * @todo Publish the assembler to NPM to always keep it up to date.
 */
'use strict';
const U = require('../app/utilities.js');
const files = U.getFilesInFolder('../../highcharts/', 'assembler', true);
files.forEach(file => {
	U.copyFile('../../highcharts/' + file, '../' + file);
});