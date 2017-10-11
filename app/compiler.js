/**
 * Contains all processes related to compiling of files.
 * @author Jon Arild Nygard
 * @todo Add license
 */
'use strict'
const {
  getFile,
  writeFile
} = require('./filesystem.js')
/**
 * Compile a single file.
 * @param {string} path Path to source file
 * @return {Promise} Returns a promise which resolves when the file is compiled.
 */
const compile = (path) => {
  const closureCompiler = require('google-closure-compiler-js')
  const outputPath = path.replace('.src.js', '.js')
  const src = getFile(path)
  const out = closureCompiler.compile({
    compilationLevel: 'SIMPLE_OPTIMIZATIONS',
    jsCode: [{
      src: src
    }],
    languageIn: 'ES5',
    languageOut: 'ES5'
  })
  writeFile(outputPath, out.compiledCode)
}

module.exports = {
  compile
}
