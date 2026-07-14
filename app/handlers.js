'use strict'

const { join } = require('path')
const directoryTree = require('directory-tree')
const { secureToken } = require('../config.json')
const { response } = require('./message.json')
const { validateWebHook } = require('./webhook.js')

const PATH_TMP_DIRECTORY = join(__dirname, '../tmp')

function catchAsyncErrors (handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next)
}

function setPublicHeaders (res, status, rate = {}) {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept')
  res.header('Cache-Control', status === 429 ? 'no-store' : 'max-age=3600')
  res.header('CDN-Cache-Control', status === 429 ? 'no-store' : 'max-age=3600')
  if (rate.remaining !== undefined) res.header('X-GitHub-RateLimit-Remaining', String(rate.remaining))
  if (rate.reset !== undefined) res.header('X-GitHub-RateLimit-Reset', String(rate.reset))
  if (status === 429 && rate.reset !== undefined) {
    res.header('Retry-After', String(Math.max(0, rate.reset - Math.floor(Date.now() / 1000))))
  }
}

function respondToClient (result, res, req) {
  if (req.connectionAborted || res.headersSent) return
  const status = result.status || 200
  setPublicHeaders(res, status, result.rate)
  if (result.file) return res.sendFile(result.file)
  return res.status(status).send(result.body)
}

function handlerHealth (req, res) {
  return respondToClient(response.ok, res, req)
}

function handlerIcon (req, res) {
  return respondToClient({ file: join(__dirname, '/../assets/favicon.ico') }, res, req)
}

function handlerRobots (req, res) {
  return respondToClient({ file: join(__dirname, '../assets/robots.txt') }, res, req)
}

function handlerUpdate (req, res) {
  let result = response.notFound
  const webhookSecret = process.env.WEBHOOK_SECRET || secureToken
  if (String(req.get('user-agent')) === 'GitHub-Hookshot/0a3a2d2' || validateWebHook(req, webhookSecret).valid) result = response.ok
  return respondToClient(result, res, req)
}

function printTreeChildren (children, level = 1, carry = []) {
  for (const child of children) {
    carry.push('-'.repeat(level) + child.name)
    if (child.children) printTreeChildren(child.children, level + 1, carry)
  }
  return carry.join('\n')
}

function handlerFS (req, res) {
  const commit = req.query.commit
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) return respondToClient(response.missingFile, res, req)
  const tree = directoryTree(join(PATH_TMP_DIRECTORY, commit, 'output'))
  const body = tree?.children
    ? `<pre>${printTreeChildren(tree.children)}</pre>`
    : 'no output folder found for this commit'
  return respondToClient({ status: 200, body }, res, req)
}

module.exports = {
  catchAsyncErrors,
  handlerFS,
  handlerHealth,
  handlerIcon,
  handlerRobots,
  handlerUpdate,
  respondToClient,
  setPublicHeaders
}
