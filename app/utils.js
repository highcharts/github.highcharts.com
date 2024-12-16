'use strict'
Object.defineProperty(exports, '__esModule', { value: true })
/* eslint-disable camelcase */
const node_path_1 = require('node:path')
const node_util_1 = require('node:util')
const node_child_process_1 = require('node:child_process')
function shouldUseWebpack (tsconfig) {
  if (/"outDir":.*code\/es-modules\/"/.test(tsconfig)) {
    return true
  }
  return false
}
function compileWebpack (srcFolder, config = 'highcharts.webpack.mjs') {
  const configDir = 'tools/webpacks'
  console.log('Compiling webpack for: ', srcFolder)
  const execAsync = (0, node_util_1.promisify)(node_child_process_1.exec)
  return execAsync(`npx webpack -c ${(0, node_path_1.join)(configDir, config)} --output-path ./output --stats errors-only`, { timeout: 7000, cwd: srcFolder }).then(({ stdout, stderr }) => {
    if (stderr) {
      console.error(stderr)
      return
    }
    console.log(stdout)
  }).catch(err => {
    throw new Error('Failed running webpack', { cause: err })
  })
}
module.exports = {
  shouldUseWebpack,
  compileWebpack
}
// # sourceMappingURL=utils.js.map
