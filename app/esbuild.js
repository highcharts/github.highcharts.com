// @ts-check
/**
 * Esbuild-based compile-on-demand functionality.
 * Uses @highcharts/highcharts-utils/lib/compile-on-demand-core.js for core compilation.
 *
 * @module esbuild
 */

const { join } = require('node:path')
const { readFile, writeFile, mkdir } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const { log } = require('./utilities')

/**
 * Cached promise for the dynamically imported compile-on-demand-core module
 * @type {Promise<typeof import('@highcharts/highcharts-utils/lib/compile-on-demand-core.js')> | null}
 */
let coreModulePromise = null

/**
 * Cached promise for the dynamically imported esbuild module
 * @type {Promise<typeof import('esbuild')> | null}
 */
let esbuildPromise = null

/**
 * Dynamically import the compile-on-demand-core module (ESM)
 * @returns {Promise<typeof import('@highcharts/highcharts-utils/lib/compile-on-demand-core.js')>}
 */
async function getCompileCore () {
  if (!coreModulePromise) {
    coreModulePromise = import('@highcharts/highcharts-utils/lib/compile-on-demand-core.js')
  }
  return coreModulePromise
}

/**
 * Dynamically import esbuild (ESM)
 * @returns {Promise<typeof import('esbuild')>}
 */
async function getEsbuild () {
  if (!esbuildPromise) {
    esbuildPromise = import('esbuild')
  }
  return esbuildPromise
}

/**
 * Get package version from package.json in the source directory
 * @param {string} highchartsDir - Path to the Highcharts source directory
 * @returns {Promise<string>} The package version
 */
async function getPackageVersion (highchartsDir) {
  try {
    const packageJsonPath = join(highchartsDir, 'package.json')
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'))
    return packageJson.version || '0.0.0'
  } catch (e) {
    return '999.0.0' // Default to a high version to skip legacy plugins
  }
}

/**
 * Compile a file and write it to the output directory
 * @param {string} branch - The branch/commit SHA
 * @param {string} requestFilename - The requested filename (e.g., 'highcharts.src.js')
 * @param {Object} [options] - Compilation options
 * @param {boolean} [options.minify=false] - Whether to minify the output
 * @returns {Promise<{file?: string, body?: string, status: number}>} Result with file path or error
 */
async function compileWithEsbuild (branch, requestFilename, options = {}) {
  const { minify = false } = options
  const core = await getCompileCore()

  const pathCacheDirectory = join(__dirname, '../tmp', branch)
  const outputDir = join(pathCacheDirectory, 'output-esbuild')

  // Normalize the filename to have a leading slash for the compile function
  const normalizedFilename = requestFilename.startsWith('/')
    ? requestFilename
    : `/${requestFilename}`

  // Determine output filename - use .js for minified, .src.js for non-minified
  const outputFilename = minify
    ? requestFilename.replace('.src.js', '.js')
    : requestFilename

  // Output file path
  const outputFilePath = join(outputDir, outputFilename)

  // Check if already compiled
  if (existsSync(outputFilePath)) {
    log(0, `Serving cached esbuild file: ${outputFilePath}`)
    return { file: outputFilePath, status: 200 }
  }

  // Ensure output directory exists (use try/catch to handle race conditions)
  const outputFileDir = join(outputDir, ...outputFilename.split('/').slice(0, -1))
  try {
    await mkdir(outputFileDir, { recursive: true })
  } catch (error) {
    // EEXIST is fine; directory already exists (race condition with parallel requests)
    if (error.code !== 'EEXIST') {
      throw error
    }
  }

  log(0, `Compiling with esbuild: ${normalizedFilename} for ${branch}${minify ? ' (minified)' : ''}`)

  /** @type {{code: string, duration: number}} */
  let result
  try {
    result = await core.compile(normalizedFilename, {
      highchartsDir: pathCacheDirectory,
      branchName: branch,
      getPackageVersion: () => getPackageVersion(pathCacheDirectory)
    })

    let code = result.code

    // Minify if requested
    if (minify) {
      const esbuild = await getEsbuild()
      const minifyResult = await esbuild.transform(code, {
        minify: true,
        target: 'es2020'
      })
      code = minifyResult.code
    }

    // Write to output directory
    await writeFile(outputFilePath, code, 'utf-8')

    log(0, `esbuild compilation complete: ${outputFilename} (${result.duration}ms)${minify ? ' [minified]' : ''}`)

    return { file: outputFilePath, status: 200 }
  } catch (error) {
    log(2, `esbuild compilation failed: ${error.message}`)
    const errorJs = `console.error('esbuild compilation failed: ${error.message.replace(/'/g, "\\'")}');`
    await writeFile(outputFilePath, errorJs, 'utf-8')
    return { file: outputFilePath, status: 200 }
  }
}

module.exports = {
  compileWithEsbuild,
  // Re-export from core for any external usage
  getCompileCore
}
