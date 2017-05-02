'use strict';
const fs = require('fs');
const archiver = require('archiver');
const versionNumber = require('../package.json').version;
const archiveName = 'github.highcharts-' + versionNumber + '.zip';
const folders = ['app', 'assembler', 'assets', 'source', 'views', 'tmp'];
const files = ['config.json', 'package.json', 'server.js'];
const output = fs.createWriteStream(archiveName);
const archive = archiver('zip', {
    store: true // Sets the compression method to STORE. 
});
const log = (s) => console.log(s); // eslint-disable-line no-console

// listen for all archive data to be written 
output.on('close', () => {
    log(archive.pointer() + ' total bytes');
    log('archiver has been finalized and the output file descriptor has closed.');
});

// good practice to catch this error explicitly 
archive.on('error', (err) => {
  throw err;
});

// pipe archive data to the file 
archive.pipe(output);

// append a file 
folders.forEach((f) => {
    // append files from a directory 
    archive.directory(f);
});

files.forEach((f) => {
    archive.file(f, { name: f });
});

// finalize the archive (ie we are done appending files but streams have to finish yet) 
archive.finalize();