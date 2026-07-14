'use strict'

const { existsSync } = require('node:fs')
const { readFile } = require('node:fs/promises')
const { join } = require('node:path')
const { buildModules, buildDistFromModules } = require('@highcharts/highcharts-assembler/src/build')
const { compileTypeScript, compileTypeScriptProject } = require('./utilities')
const { compileWebpack, shouldUseWebpack } = require('./utils')
const { compileWithEsbuild } = require('./esbuild')
const { buildDashboards } = require('./dashboards')
const { getFileNamesInDirectory, writeFile } = require('./filesystem')
const { getFileOptions } = require('./interpreter')
const { JobQueue } = require('./JobQueue')

function createBuilder (options = {}) {
  const queue = options.queue || new JobQueue()
  const cacheRoot = options.cacheRoot || join(__dirname, '../tmp')
  const dependencies = {
    buildDashboards,
    compileTypeScript,
    compileTypeScriptProject,
    compileWebpack,
    compileWithEsbuild,
    buildModules,
    buildDistFromModules,
    getFileNamesInDirectory,
    getFileOptions,
    ...options.dependencies
  }
  const typescriptJobs = {}
  const assemblyJobs = {}

  function addTypescriptJob (commit, file, project = false) {
    const projectJob = typescriptJobs[commit + 'project']
    if (projectJob) return projectJob
    const id = commit + (project ? 'project' : file)
    if (!typescriptJobs[id]) {
      if (project) {
        typescriptJobs[id] = dependencies.compileTypeScriptProject(commit, join(cacheRoot, commit))
          .finally(() => { delete typescriptJobs[id] })
      } else {
        typescriptJobs[id] = readFile(join(cacheRoot, commit, 'ts/tsconfig.json'), 'utf8').then(tsconfig => {
          const outDir = shouldUseWebpack(tsconfig) ? 'code/es-modules' : 'js'
          const compile = () => dependencies.compileTypeScript(commit, file, outDir, join(cacheRoot, commit))
          return ['highcharts', 'highstock', 'highcharts-gantt', 'highmaps']
            .some(master => file.includes(`/${master}.src.ts`))
            ? compile()
            : addTypescriptJob(commit, 'masters/highcharts.src.ts').then(compile)
        })
      }
    }
    return typescriptJobs[id]
  }

  async function enqueue (id, func, args) {
    try {
      await queue.addJob('compile', id, { func, args })
    } catch (error) {
      if (error.name === 'QueueFullError') {
        error.code = 'QUEUE_FULL'
        error.status = 503
      }
      throw error
    }
  }

  async function build (request) {
    const { commit, path, mode, options: buildOptions = {} } = request
    const root = join(cacheRoot, commit)
    if (mode === 'esbuild') {
      return { ...(await dependencies.compileWithEsbuild(commit, path, { minify: Boolean(buildOptions.minify), workspaceRoot: root })), builtWith: 'esbuild' }
    }
    if (mode === 'dashboards') {
      const file = await dependencies.buildDashboards(root, commit, path, queue)
      return { file, status: 200, builtWith: 'dashboards' }
    }
    if (mode === 'webpack') {
      await enqueue('webpack', dependencies.compileWebpack, [root, buildOptions.config])
      return { file: join(root, 'output', path), status: 200, builtWith: 'webpack' }
    }

    const type = buildOptions.type === 'css' ? 'css' : 'classic'
    const mastersQuery = path.startsWith('masters/')
    const master = path.replace(/^masters\//, '').replace(/\.src\.js$/, '.src.ts')
    const isMaster = existsSync(join(root, 'ts/masters', master))
    const tsFile = join(isMaster && !mastersQuery ? 'masters' : '', path.replace(isMaster ? '.js' : '.src.js', '.ts'))
    if (existsSync(join(root, 'ts', mastersQuery ? '' : tsFile))) {
      await addTypescriptJob(commit, tsFile, mastersQuery).catch(() => {})
    }
    const output = join(root, 'output', type === 'css' ? 'js' : '', path)
    const id = commit + (isMaster ? path : 'project')
    if (!assemblyJobs[id]) {
      assemblyJobs[id] = enqueue(id, assemble, []).finally(() => {
        setTimeout(() => { delete assemblyJobs[id] }, 2500).unref()
        delete typescriptJobs[commit + tsFile]
      })
    }
    await assemblyJobs[id]
    if (!existsSync(output)) {
      const error = new Error('Could not assemble this file. It is likely an error located in the source files.')
      error.code = 'INVALID_BUILD'
      error.status = 400
      throw error
    }
    return { file: output, status: 200, builtWith: 'assembler' }

    async function assemble () {
      const tsconfig = await readFile(join(root, 'ts/tsconfig.json'), 'utf8')
      if (shouldUseWebpack(tsconfig)) return dependencies.compileWebpack(root)
      const files = await dependencies.getFileNamesInDirectory(join(root, 'js/masters'))
      const fileOptions = dependencies.getFileOptions(files, join(root, 'js'))
      dependencies.buildModules({ base: join(root, 'js') + '/', type: [type], namespace: 'Highcharts', output: join(root, 'output'), version: commit })
      dependencies.buildDistFromModules({ base: join(root, 'output/es-modules/masters') + '/', debug: true, fileOptions, files, namespace: 'Highcharts', output: join(root, 'output'), type: [type], version: commit })
      const contents = await readFile(output, 'utf8')
      const source = `code.highcharts.com/${commit}/`
      if (contents.includes(source)) await writeFile(output, contents.replace(new RegExp(source, 'g'), 'code.highcharts.com/'))
    }
  }

  return { build, state: { assemblyJobs, typescriptJobs } }
}

module.exports = { createBuilder }
