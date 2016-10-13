'use strict';
const getFilesInFolder = (base, path, includeSubfolders) => {
    const fs = require('fs');
    let filenames = [],
        filepath,
        isDirectory;
    path = (typeof path === 'undefined') ? '' : path + '/';
    let folderPath = __dirname + '/' + base + path;
    fs.readdirSync(folderPath).forEach((filename) => {
        filepath = folderPath + filename;
        isDirectory = fs.lstatSync(filepath).isDirectory();
        if (isDirectory && includeSubfolders) {
            filenames = filenames.concat(getFilesInFolder(base, path + filename, includeSubfolders));
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

const getFile = path => {
    const fs = require('fs');
    return (exists(path) ? fs.readFileSync(path, 'utf8') : null);
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

/**
 * Removes a file.
 * Creates a promise which resolves when the file is deleted.
 * Promise is rejected if the file does not exist.
 * @param  {string} path Path to file
 * @returns {Promise} Returns a promise which resolves when the file is deleted.
 */
const removeFile = path => new Promise((resolve, reject) => {
    const fs = require('fs');
    if (exists(path)) {
        fs.unlink(path, () => {
            resolve(true);
        });
    } else {
        reject('File does not exist: ' + path);
    }
});

/**
 * Removes a directory.
 * Creates a promise which resolves when the directory is deleted.
 * Promise is rejected if the file does not exist.
 * @param  {string} path Path to file
 * @returns {Promise} Returns a promise which resolves when the file is deleted.
 */
const removeDirectory = path => new Promise((resolve, reject) => {
    const fs = require('fs');
    if (exists(path)) {
        const files = fs.readdirSync(path);
        const promises = files.map(file => path + '/' + file)
            .map(itemPath => (fs.statSync(itemPath).isDirectory()) ? removeDirectory(itemPath) : removeFile(itemPath));
        Promise.all(promises).then(() => {
            fs.rmdirSync(path);
            resolve(true);
        })
        .catch(err => reject(err.message + '\n\r' + err.stack));
    } else {
        reject('Directory does not exist: ' + path);
    }
});

const debug = (d, text) => {
    if (d) {
        /* eslint-disable no-console */
        console.log(text);
        /* eslint-enable no-console */
    }
};

const randomString = (length) => {
    const possible = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const arr = Array.from({ length: length });
    return arr.map(() => {
        const index = Math.floor(Math.random() * possible.length);
        return possible.charAt(index);
    }).join('');
}

const cleanPath = path => {
    let p = path;
    while (p.indexOf('/./') > -1) {
        p = p.replace('/./', '/');
    }
    while (p.indexOf('/../') > -1) {
        p = p.replace(/[\\\/]([^\\\/]+[\\\/]\.\.[\\\/])/g, '/');
    }
    return p;
};

module.exports = {
    cleanPath,
    copyFile,
    createDirectory,
    debug,
    exists,
    folder,
    getFile,
    getFilesInFolder,
    randomString,
    removeDirectory,
    removeFile,
    writeFile
};