/**
 * Contains all processes related to compiling of files.
 * @author Jon Arild Nygard
 * @todo Add license
 */
'use strict'
const closureCompiler = require('google-closure-compiler-js')
const {
  getFilePromise,
  writeFilePromise
} = require('./filesystem.js')
const {
  fork
} = require('child_process')

/**
 * Compile source code.
 * @param {String} src Source code to compile
 * @return {Object} Returns an object containing the result.
 */
const compileSync = (src) => {
  // Run closure compiler
  const out = closureCompiler.compile({
    compilationLevel: 'SIMPLE_OPTIMIZATIONS',
    jsCode: [{ src }],
    languageIn: 'ES5',
    languageOut: 'ES5'
  })
  return out
}

const compile = (src) => new Promise((resolve, reject) => {
  const forked = fork('./app/fork.js')
  forked.on('message', (result) => {
    const {
      value: out,
      error
    } = result
    if (error) {
      reject(error)
    } else if (out.errors.length) {
      const getErrorMessage = (e) => {
        return [
          '- - Type: ' + e.type,
          '- Line: ' + e.lineNo,
          '- Char : ' + e.charNo,
          '- Description: ' + e.description
        ].join('\n')
      }
      const msg = out.errors.map(getErrorMessage).join('\n')
      reject(new Error(msg))
    } else {
      resolve(out.compiledCode)
    }
  })
  // NOTE fork.send does not support sending functions, so instead we are
  // sending a name of function to execute.
  forked.send({
    fnName: 'compileSync',
    args: [src]
  })
})

const compileFile = (filepath, outputPath) => {
  const writeToOutput = (data) => writeFilePromise(outputPath, data)
  return getFilePromise(filepath)
    .then(compile)
    .then(writeToOutput)
}

module.exports = {
  compile,
  compileFile,
  compileSync
}
