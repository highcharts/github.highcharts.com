'use strict'
const fs = require('fs')
const archiver = require('archiver')
const versionNumber = require('../package.json').version
const archiveName = 'github.highcharts-' + versionNumber + '.zip'
const folders = ['.ebextensions', 'app', 'assets', 'views']
const emptyFolders = ['tmp']
const files = ['config.json', 'package.json', 'server.js']
const output = fs.createWriteStream(archiveName)
const placeholder = 'EMPTY.md'
const archive = archiver('zip', {
  zlib: { level: 9 }
})
const log = (s) => console.log(s) // eslint-disable-line no-console

// listen for all archive data to be written
output.on('close', () => {
  log(archive.pointer() + ' total bytes')
  log('archiver has been finalized and the output file descriptor has closed.')
})

// good practice to catch this error explicitly
archive.on('error', (err) => {
  throw err
})

// pipe archive data to the file
archive.pipe(output)

// append a file
folders.forEach((f) => {
  // append files from a directory
  archive.directory(f)
})

// Can't put empty folders into the archive, so we use a placeholder.
emptyFolders.forEach((f) => {
  archive.file(placeholder, { name: f + '/' + placeholder })
})

files.forEach((f) => {
  archive.file(f, { name: f })
})

// finalize the archive (ie we are done appending files but streams have to finish yet)
archive.finalize()
