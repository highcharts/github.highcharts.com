'use strict';
/**
 * Compile a single file.
 * @param {string} path Path to source file
 * @return {Promise} Returns a promise which resolves when the file is compiled.
 */
const compile = (path) => {
    const closureCompiler = require('google-closure-compiler-js');
    const fs = require('fs');
    const U = require('./utilities.js');
    const outputPath = path.replace('.src.js', '.js');
    const src = U.getFile(path);
    const out = closureCompiler.compile({
        compilationLevel: 'ADVANCED',
        jsCode: [{
            src: src
        }],
        languageIn: 'ES5',
        languageOut: 'ES5'
    });
    U.writeFile(outputPath, out.compiledCode);
};

module.exports = {
    compile
}