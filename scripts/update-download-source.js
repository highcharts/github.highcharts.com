/**
 * Script to update the version of Highcharts JS used with the Highcharts Download Builder.
 * @author Jon Arild Nygard
 * @todo Add license
 * @todo Cache multiple Highcharts versions, then use the cached version in stead of a manually updated library.
 */
'use strict'
const { createDirectory, getFilesInFolder } = require('../app/filesystem.js')
const { createReadStream, createWriteStream } = require('fs')
const { dirname, join } = require('path')

function copyFile (ph, output) {
  const inputPath = join(__dirname, ph)
  const outputPath = join(__dirname, output)
  createDirectory(dirname(outputPath))
  createReadStream(inputPath).pipe(createWriteStream(outputPath))
}

let files = getFilesInFolder('../highcharts/', true, 'js').concat(getFilesInFolder('../highcharts/', true, 'css'))
files.filter(file => (file.endsWith('.js') || file.endsWith('.scss'))).forEach(file => {
  copyFile('../../highcharts/' + file, '../source/download/' + file)
})
