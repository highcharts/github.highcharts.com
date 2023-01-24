/**
 * Interprets a request URL from the client, finds which version, and file from
 * the Highcharts library to return to the client.
 * @author Jon Arild Nygard
 * @todo Add license
 */
'use strict'

// Import dependencies, sorted by path name.
const {
  getOrderedDependencies
} = require('highcharts-assembler/src/dependencies.js')
const { join, sep, relative } = require('path')

// Constants
const BRANCH_TYPES = [
  'bugfix',
  'feature',
  'enhancement',
  'ts',
  'refactor',
  'db',
  'dashboards'
]
const PRODUCTS = ['stock', 'maps', 'gantt']
const replaceAll = (str, search, replace) => str.split(search).join(replace)

/**
 * Finds which branch, tag, or commit that is requested by the client. Defaults
 * to master. Returns a string with the resulting reference.
 *
 * @param  {string} url The request URL.
 */
async function getBranch (url) {
  const folders = ['adapters', 'indicators', 'modules', 'parts-3d', 'parts-map',
    'parts-more', 'parts', 'themes']
  const isValidBranchName = (str) => (
    !['css', 'js'].includes(str) && // Not a type
    !PRODUCTS.includes(str) && // Not a lib type
    !folders.includes(str) && // Not a parts folder
    !(str.endsWith('.js') || str.endsWith('.css')) // Not a file
  )

  let branch = 'master'
  const sections = url.substring(1).split('/')
  // We have more than one section
  if (sections.length > 1 && BRANCH_TYPES.includes(sections[0])) {
    branch = (
      (sections.length > 2 && isValidBranchName(sections[1]))
        ? sections[0] + '/' + sections[1]
        : sections[0]
    )
  /**
   * If the url has more then 1 section, and the first section is not indicating
   * one of the js folders, then assume first section is a branch/tag/commit
   */
  } else if (isValidBranchName(sections[0])) {
    branch = sections[0]
  }
  return branch
}

/**
 * Finds the requested filename. Returns a string with the filename, or false if
 * it is not a js file.
 *
 * @param  {string} branch The requested branch.
 * @param  {string} branch The requested mode.
 * @param  {string} url The request URL.
 */
function getFile (branch, type, url) {
  // Replace branches in url, since we save by commit sha
  url = url.replace(/^\/master/, '')
  const regex = new RegExp(`^\\/(${BRANCH_TYPES.join('|')})\\/([A-Za-z]|[0-9]|-)+\\/`)
  if (regex.test(url)) {
    url = url.replace(regex, '/')
  }
  const sections = [
    x => x === branch.split('/')[0], // Remove first section of branch name
    x => x === branch.split('/')[1], // Remove second section of branch name
    x => PRODUCTS.includes(x), // Remove product folder.
    x => type === 'css' && x === 'js' // Remove js folder in styled mode.
  ].reduce((sections, filter) => {
    if (filter(sections[0])) {
      sections.splice(0, 1)
    }
    return sections
  }, url.substring(1).split('/'))

  let filename = sections.join('/')
  // Redirect .js requests to .src.js
  if (!filename.endsWith('.src.js')) {
    filename = filename.replace('.js', '.src.js')
  }

  // Return the resulting filename.
  return filename.endsWith('.js') ? filename : false
}

/**
 * Get fileOptions used in the build script for the assembler. Returns an object
 * with the resulting file options.
 * @todo Move this functionality to the build script.
 */
function getFileOptions (files, pathJS) {
  const pathHighcharts = join(pathJS, 'masters/highcharts.src.js')
  const highchartsFiles = replaceAll(
    getOrderedDependencies(pathHighcharts)
      .map((path) => relative(pathJS, path))
      .join('|'),
    sep,
    `\\${sep}`
  )
  // Modules should not be standalone, and they should exclude all parts files.
  const fileOptions = files
    .reduce((obj, file) => {
      if (
        file.includes('modules') ||
        file.includes('themes') ||
        file.includes('gantt/') ||
        file.includes('indicators')
      ) {
        obj[file] = {
          exclude: new RegExp(highchartsFiles),
          umd: false
        }
      }
      return obj
    }, {})

  /**
   * Special cases
   * solid-gauge should also exclude gauge-series
   * highcharts-more and highcharts-3d is also not standalone.
   */
  if (fileOptions['modules/solid-gauge.src.js']) {
    fileOptions['modules/solid-gauge.src.js'].exclude =
      new RegExp([highchartsFiles, 'GaugeSeries\\.js$'].join('|'))
  }
  if (fileOptions['modules/map.src.js']) {
    fileOptions['modules/map.src.js'].product = 'Highmaps'
  }
  if (fileOptions['modules/map-parser.src.js']) {
    fileOptions['modules/map-parser.src.js'].product = 'Highmaps'
  }
  Object.assign(fileOptions, {
    'highcharts-more.src.js': {
      exclude: new RegExp(highchartsFiles),
      umd: false
    },
    'highcharts-3d.src.js': {
      exclude: new RegExp(highchartsFiles),
      umd: false
    },
    'highmaps.src.js': {
      product: 'Highmaps'
    },
    'highstock.src.js': {
      product: 'Highstock'
    }
  })
  return fileOptions
}

/**
 * Finds the requested type. Returns a string with the resultign type, can be
 * either classic or css.
 * @param  {string} branch The requested branch.
 * @param  {string} url The request URL.
 */
const getType = (branch, url) => {
  const sections = [
    x => x === branch.split('/')[0], // Remove first section of branch name
    x => x === branch.split('/')[1], // Remove second section of branch name
    x => PRODUCTS.includes(x) // Remove product folder.
  ].reduce((sections, filter) => {
    if (filter(sections[0])) {
      sections.splice(0, 1)
    }
    return sections
  }, url.substring(1).split('/'))

  return sections[0] === 'js' ? 'css' : 'classic'
}

// Export interpreter functionality
module.exports = {
  getBranch,
  getFile,
  getFileOptions,
  getType
}
