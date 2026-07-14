'use strict'

const { expect } = require('chai')
const http = require('node:http')
const fs = require('node:fs')
const { join } = require('node:path')
const { describe, it } = require('mocha')
const { createApp } = require('../app/server')
const { createRouter } = require('../app/router')

describe('public server', () => {
  it('serves health without starting a listener or calling services', async () => {
    const unavailable = () => { throw new Error('service called') }
    const app = createApp({ router: createRouter({ downloader: { json: unavailable }, builder: {}, disableRateLimit: true }) })
    const response = await request(app, '/health')
    expect(response).to.include({ status: 200, body: 'OK' })
  })

  it('has no public build registry, periodic cleanup, or server-handler cycle', () => {
    const server = fs.readFileSync(join(__dirname, '../app/server.js'), 'utf8')
    const handlers = fs.readFileSync(join(__dirname, '../app/handlers.js'), 'utf8')
    expect(server).not.to.include('typescriptJobs')
    expect(server).not.to.include('setInterval')
    expect(handlers).not.to.include("require('./server.js')")
  })
})

function request (app, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      http.get({ port: server.address().port, path }, res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          server.close()
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })
        })
      }).on('error', reject)
    })
  })
}
