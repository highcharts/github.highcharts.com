'use strict';
const getFilesInFolder = (base, path, includeSubfolders) => {
    const fs = require('fs');
    let filenames = [],
        filepath,
        isDirectory;
    base = __dirname + '/' + base;
    path = (typeof path === 'undefined') ? '' : path + '/';
    fs.readdirSync(base + path).forEach((filename) => {
        filepath = base + path + filename;
        isDirectory = fs.lstatSync(filepath).isDirectory();
        if (isDirectory && includeSubfolders) {
            filenames = filenames.concat(getFilesInFolder(base, includeSubfolders, path + filename + '/'));
        } else if (!isDirectory) {
            filenames.push(path + filename);
        }
    });
    return filenames;
};

const exists = path => {
    const fs = require('fs');
    let exists = true;
    try {
        fs.statSync(path);
    } catch (err) {
        exists = false;
    }
    return exists;
};

/**
 * Gets directory path from a file path
 * @param  {string} path File path
 * @return {string} Path to directory where the file is located
 */
const folder = path => {
    let folderPath = '.';
    if (path !== '') {
        folderPath = path.substring(0, path.lastIndexOf('/'));
    }
    return folderPath + '/';
};

/**
 * Takes a folder path and creates all the missing folders
 * @param  {string} path Path to directory
 * @return {undefined} Returns nothing
 */
const createDirectory = path => {
    const fs = require('fs');
    const folders = path.split('/');
    folders.reduce((base, name) => {
        const path = base + name;
        try {
            fs.statSync(path);
        } catch (err) {
            fs.mkdirSync(path);
        }
        return path + '/';
    }, '');
}

const copyFile = (path, output) => {
    const fs = require('fs');
    const base = __dirname + '/';
    const outFile = base + output;
    createDirectory(folder(outFile));
    fs.createReadStream(base + path).pipe(fs.createWriteStream(outFile));
};

const writeFile = (path, content) => {
    const fs = require('fs');
    createDirectory(folder(path));
    fs.writeFileSync(path, content);
};

const debug = (d, text) => {
    if (d) {
        /* eslint-disable no-console */
        console.log(text);
        /* eslint-enable no-console */
    }
};

module.exports = {
    copyFile,
    createDirectory,
    debug,
    exists,
    folder,
    getFilesInFolder,
    writeFile
};