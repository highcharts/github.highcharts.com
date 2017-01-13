'use strict';
const EasyZip = require('easy-zip').EasyZip;
const getFilesInFolder = require('../app/utilities.js').getFilesInFolder;
const zip = new EasyZip();
const archive = 'github.highcharts.com.zip';
const folders = ['app', 'assembler', 'assets', 'source', 'views'];

// Add the content of the folders and the additional files. 
let files = folders.reduce((arr, folder) => {
        let result = getFilesInFolder('../', folder, true);
        return arr.concat(result);
    }, [])
    .concat(['config.json', 'package.json', 'server.js']);

// Create the zip config, and add config to create an empty tmp folder
let batch = files.map(file => ({ target: file, source: file }))
    .concat({
        target: 'tmp' // Create empty tmp folder
    });

// Zip it all together and write to file
zip.batchAdd(batch, () => {
    zip.writeToFile(archive);
});
