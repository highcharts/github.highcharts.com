// @ts-check

const { join } = require('node:path')
const { stat, opendir, readFile, writeFile, symlink } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const { downloadSourceFolder, getBranchInfo, getCommitInfo } = require('./download')
const { compileTypeScript, log } = require('./utilities')
const { build } = require('@highcharts/highcharts-assembler/src/build')
const { JobQueue } = require('./JobQueue')

const PATH_TMP_DIRECTORY = join(__dirname, '../tmp')
const queue = new JobQueue()

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

  const fileOptions = []
  try {
    build({
      // TODO: Remove trailing slash when assembler has fixed path concatenation
      base: jsMastersDirectory + '/',
      output: pathOutputFolder,
      pretty: false,
      version: commit,
      fileOptions,
      assetPrefix: 'https://code.highcharts.com/dashboards',
      product: 'Highcharts Dashboards',
      namespace: 'Dashboards'
    })
  } catch (error) {
    log(2, `Dashboards assembler error: ${error.message}`)
  }

  /**
      * @param {string} dirPath
      */
  async function modifyFiles (dirPath) {
    const dir = await opendir(dirPath)
      .catch(error => {
        log(2, `Failed to open directory ${dirPath}: ${error.message}`)
        return null
      })

    if (dir) {
      for await (const dirent of dir) {
        if (dirent.isDirectory()) {
          await modifyFiles(join(dirPath, dirent.name))
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
          ).catch(error => {
            log(2, `Failed to create symlink in ${dirPath}: ${error.message}`)
            return null
          })
        }
      }
    }
  }

  await modifyFiles(pathOutputFolder)
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
*/
async function dashboardsHandler (req, res, next) {
  const { filepath } = req.params

  let commit

  function handleQueueError (error) {
    res.statusCode = 200
    if (error.name === 'QueueFullError') {
      res.statusCode = 202
    }

    return res.send(error.message)
  }

  if (req.params.commit) commit = req.params.commit

  if (commit && commit.length === 7) {
    const { sha } = await getCommitInfo(commit)
    if (sha) {
      commit = sha
    }
  }

  if (!commit && req.params.branch) {
    const isVersionTag = /v[0-9]+\./.test(req.params.branch) || req.params.branch.startsWith('dashborads-v')

    if (isVersionTag) {
      commit = req.params.branch
    } else {
      // get commit from branch
      const branchData = await getBranchInfo(req.params.branch)
      if (branchData) {
        // @ts-ignore
        commit = branchData.commit.sha
      }
    }
  }

  if (!commit) {
    res.sendStatus(404)
    return
  }

  const pathCacheDirectory = join(PATH_TMP_DIRECTORY, commit)
  const downloadURL = 'https://raw.githubusercontent.com/highcharts/highcharts/'

  try {
    await stat(join(pathCacheDirectory, 'js'))
  } catch (err) {
    if (err.code === 'ENOENT') {
      await Promise.resolve().then(() => queue.addJob(
        'download',
        commit,
        {
          func: downloadSourceFolder,
          args: [
            pathCacheDirectory,
            downloadURL,
            commit
          ]
        }
      )).catch(error => {
        log(2, `Failed to enqueue download for ${commit}: ${error.message}`)
        return handleQueueError(error)
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
      await Promise.resolve().then(() => queue.addJob(
        'compile',
        commit + filepath,
        {
          func: compileTypeScript,
          args: [
            commit,
            obj.compile.endsWith('.src.js')
              ? obj.compile
              : obj.compile.replace('.js', '.src.js')
          ]
        }
      )).catch(error => {
        log(2, `Failed to enqueue TypeScript compile for ${commit}${filepath}: ${error.message}`)
        return handleQueueError(error)
      })

      await Promise.resolve().then(() => queue.addJob(
        'compile',
        commit + filepath,
        {
          func: assembleDashboards,
          args: [pathCacheDirectory, commit]
        }
      )).catch(error => {
        log(2, `Failed to enqueue dashboard assembly for ${commit}${filepath}: ${error.message}`)
        return handleQueueError(error)
      })

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
