// @ts-check

const { join } = require('node:path')
const { stat, opendir, readFile, writeFile, symlink } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const { downloadSourceFolder, getBranchInfo, getCommitInfo } = require('./download')
const { compileTypeScript } = require('./utilities')
const { build } = require('@highcharts/highcharts-assembler/src/build')
const { JobQueue } = require('./JobQueue')

const PATH_TMP_DIRECTORY = join(__dirname, '../tmp')

/**
 * @param {import('express').Response} res
    * @param {string} path
 *
*/
async function serveIfExists (res, path) {
  try {
    if (await stat(path)) {
      res.sendFile(path)
    }
  } catch (error) {
    return false
  }

  return true
}

/**
* @param {string} pathCacheDirectory
* @param {string} commit
 *
*/
async function assembleDashboards (pathCacheDirectory, commit) {
  const jsMastersDirectory = join(pathCacheDirectory, 'js', 'masters-dashboards')
  const pathOutputFolder = join(pathCacheDirectory, 'dashboards-output')

  const files = [
    'dashboards.src.js',
    'datagrid.src.js',
    'modules/dashboards-plugin.src.js'
  ]
  const fileOptions = []
  try {
    const output = build({
      // TODO: Remove trailing slash when assembler has fixed path concatenation
      base: jsMastersDirectory + '/',
      output: pathOutputFolder,
      files,
      pretty: false,
      version: commit,
      fileOptions,
      namespace: 'Dashboards'
    })

    console.log({ output })
  } catch (error) {
    console.log('assembler error: ', error)
  }

  /**
     * @param {string} dirPath
     */
  async function doThingsToDir (dirPath) {
    const dir = await opendir(dirPath)
      .catch(() => null)

    if (dir) {
      for await (const dirent of dir) {
        if (dirent.isDirectory()) {
          console.log(dirPath)
          console.log(dirent.name)
          await doThingsToDir(join(dirPath, dirent.name))
        } else if (dirent.name.endsWith('.src.js')) {
          const contents = await readFile(join(dirPath, dirent.name), 'utf-8')
                    const toReplace = 'code.highcharts.com.*' + commit + '\/' // eslint-disable-line
          if (contents) {
            await writeFile(
              join(dirPath, dirent.name),
              contents.replace(new RegExp(toReplace, 'g'), 'code.highcharts.com/')
            )
          }

          await symlink(
            join(dirPath, dirent.name),
            join(dirPath, dirent.name.replace('.src', ''))
          )
        }
      }
    }
  }

  await doThingsToDir(pathOutputFolder)
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
*/
async function dashboardsHandler (req, res) {
  const { filepath } = req.params

  let commit

  console.log(req.params)

  if (req.params.commit) commit = req.params.commit

  if (commit && commit.length === 7) {
    const { sha } = await getCommitInfo(commit)
    if (sha) {
      commit = sha
    }
  }

  if (!commit && req.params.branch) {
    // get commit from branch
    const branchData = await getBranchInfo(req.params.branch)
    if (branchData) {
      // @ts-ignore
      commit = branchData.commit.sha
    }
  }

  const queue = new JobQueue()

  const pathCacheDirectory = join(PATH_TMP_DIRECTORY, commit)
  const downloadURL = 'https://raw.githubusercontent.com/highcharts/highcharts/'

  try {
    await stat(join(pathCacheDirectory, 'js'))
  } catch (err) {
    // If it does not exist, try to download and proceed
    // TODO: add deduping
    if (err.code === 'ENOENT') {
      await queue.addDownloadJob(
        commit,
        downloadSourceFolder(
          pathCacheDirectory,
          downloadURL,
          commit
        )
      ).catch(() => {
        res.sendStatus(500)
      })
    } else {
      return res.sendStatus(404)
    }
  }

  const mastersDirName = 'masters-dashboards'
  const hasMastersFile = existsSync(
    join(
      pathCacheDirectory,
      'ts',
      mastersDirName,
      filepath
        .replace(/\.js|.src\.js/, '.src.ts')
    )
  )

  console.log(filepath, { hasMastersFile })

  const obj = {
    compile: filepath, // path to TS compile
    assembled: join(pathCacheDirectory, 'dashboards-output', filepath) // path to where assembled file should be
  }

  if (hasMastersFile) {
    obj.compile = join(mastersDirName, obj.compile)
  }

  const compiledFile = join(pathCacheDirectory, 'js', obj.compile)

  const strategies = [
    () => serveIfExists(res, obj.assembled), // serve already assembled file
    () => (!filepath.endsWith('.src.js'))
      ? serveIfExists(res, join(pathCacheDirectory, 'js', filepath))
      : Promise.resolve(false),
    // try to build and assemble file
    async () => {
      await queue.addCompileJob(
        commit,
        compileTypeScript(
          commit,
          obj.compile.endsWith('.src.js')
            ? obj.compile
            : obj.compile.replace('.js', '.src.js')

        ).then(() =>
          assembleDashboards(pathCacheDirectory, commit)
        )
      )

      res.status(201)

      return serveIfExists(res, obj.assembled)
    },
    // serve compiled file if no assembled file
    () => serveIfExists(res, compiledFile),
    () => (!filepath.endsWith('.src.js'))
      ? serveIfExists(res, join(pathCacheDirectory, 'js', filepath))
      : Promise.resolve(false)
  ]

  // doing this to avoid repeating if-statements
  for (const strategy of strategies) {
    try {
      const result = await strategy()

      if (result === true) {
        break
      }
    } catch (error) {
      console.error(error)
      res.sendStatus(500)
      return
    }
  }
}

module.exports = {
  dashboardsHandler
}