'use strict'

const { spawnSync } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const { basename, resolve } = require('node:path')

const root = resolve(__dirname, '..')
const composeFile = 'compose.ops-test.yaml'
const project = `ops-console-integration-${process.pid}`
const deploymentComposeFile = 'compose.yaml'
const deploymentProject = `ops-console-deployment-${process.pid}`
const deploymentToken = randomBytes(32).toString('base64url')
const hostPort = Number(process.env.OPS_TEST_HOST_PORT || 8080)
const baseURL = `http://localhost:${hostPort}`
const loginToken = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const internalToken = 'ops-internal-fixture-token'
const verifier = 'v1.b1e4_y5sjzm8L9Huzft19Xt3WUAydm4b5LZxUljLqBc'
const composeArgs = ['compose', '-p', project, '-f', composeFile]
const deploymentComposeArgs = ['compose', '-p', deploymentProject, '-f', deploymentComposeFile]
const deploymentEnvironment = { ...process.env, INTERNAL_SERVICE_TOKEN: deploymentToken }
let cleaning = false

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    cleanup()
    process.exit(128 + (signal === 'SIGINT' ? 2 : 15))
  })
}

main().catch(error => {
  process.stderr.write(`Operations integration failed: ${error.message}\n`)
  process.exitCode = 1
}).finally(cleanup)

async function main () {
  inspectDeploymentTopology()
  try {
    deploymentCompose(['up', '--build', '--wait', '--remove-orphans', 'downloader', 'builder'])
    checkPrivateAuthentication(deploymentCompose)
  } finally {
    cleanupDeployment()
  }

  inspectTopology()
  compose(['up', '--build', '--wait', '--remove-orphans'])
  checkPrivateAuthentication()

  hurl('test/hurl/ops-snapshot.hurl')
  hurl('test/hurl/ops-cache.hurl')
  await checkConcurrentCommands()
  checkLogs()

  compose(['down', '--volumes', '--remove-orphans'])
  compose(['up', '--build', '--wait', '--remove-orphans'])
  hurl('test/hurl/ops-auth.hurl')
  checkLogs()

  compose(['down', '--volumes', '--remove-orphans'])
  compose(['up', '--build', '--wait', '--remove-orphans'], { OPS_TEST_CONSOLE_ENABLED: 'false' })
  hurl('test/hurl/ops-security.hurl')
  hurl('test/hurl/smoke.hurl')
  hurl('test/hurl/service-split.hurl')
  checkLogs()
}

function inspectDeploymentTopology () {
  const output = deploymentCompose(['config', '--format', 'json'], true)
  const config = JSON.parse(output)
  const published = Object.entries(config.services).filter(([, service]) => service.ports?.length)
  if (published.length !== 1 || published[0][0] !== 'router' || published[0][1].ports.length !== 1 || Number(published[0][1].ports[0].target) !== 8080) {
    throw new Error('deployable topology must publish only router:8080')
  }
  for (const name of ['downloader', 'builder']) {
    if (config.services[name].ports?.length) throw new Error(`deployable ${name} publishes a port`)
  }
}

function inspectTopology () {
  const output = compose(['config', '--format', 'json'], {}, true)
  const config = JSON.parse(output)
  const published = Object.entries(config.services).filter(([, service]) => service.ports?.length)
  if (published.length !== 1 || published[0][0] !== 'router' || published[0][1].ports.length !== 1 || Number(published[0][1].ports[0].target) !== 8080) {
    throw new Error('only router:8080 may be published')
  }
  for (const name of ['downloader', 'builder']) {
    if (config.services[name].ports?.length) throw new Error(`${name} publishes a port`)
  }
}

function checkPrivateAuthentication (runCompose = compose) {
  const source = `
    const paths = [
      ['GET', '/v1/ops/snapshot'],
      ['POST', '/v1/ops/cache-operations']
    ];
    Promise.all(paths.flatMap(([method, path]) => [undefined, 'Bearer wrong'].map(async authorization => {
      const response = await fetch('http://127.0.0.1:8080' + path, {
        method,
        headers: authorization ? { Authorization: authorization } : {}
      });
      if (response.status !== 401) throw new Error(method + ' ' + path + ' returned ' + response.status);
    }))).catch(error => { console.error(error.message); process.exit(1) });
  `
  for (const service of ['downloader', 'builder']) runCompose(['exec', '-T', service, 'node', '-e', source])
}

async function checkConcurrentCommands () {
  const login = await fetch(`${baseURL}/_ops/api/v1/session`, {
    method: 'POST',
    headers: { Origin: baseURL, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: loginToken })
  })
  if (login.status !== 201) throw new Error('concurrency login failed')
  const cookie = login.headers.get('set-cookie').split(';', 1)[0]
  const { csrfToken } = await login.json()
  await control('/reset-audits', {})
  await Promise.all(['downloader', 'builder'].map(service => control('/fixture', { service, cache: 'healthy', resetCounts: true })))
  const responses = await Promise.all(['downloader', 'builder'].map(service => fetch(`${baseURL}/_ops/api/v1/cache-operations`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: baseURL, 'X-Ops-CSRF': csrfToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation: 'cache.purge_expired', targets: [service] })
  })))
  if (responses.some(response => response.status !== 200)) throw new Error('concurrent cache command failed')
  const status = await (await fetch(`${baseURL}/__ops-test/status`)).json()
  if (status.audits !== 2 || !status.auditSafe || status.downloader.cache !== 1 || status.builder.cache !== 1) {
    throw new Error('concurrent commands were retried or incorrectly audited')
  }
  checkLogs([cookie, csrfToken])
}

async function control (path, body) {
  const response = await fetch(`${baseURL}/__ops-test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!response.ok) throw new Error(`test control ${path} failed`)
}

function hurl (file) {
  const legacyURL = ['test/hurl/smoke.hurl', 'test/hurl/service-split.hurl'].includes(file)
  run(resolve(root, 'node_modules/.bin/hurl'), [
    '--test', '--jobs', '1', '--retry', '0', '--no-output',
    ...(file === 'test/hurl/ops-auth.hurl' ? ['--no-cookie-store'] : []),
    ...(legacyURL && hostPort !== 8080 ? ['--connect-to', `localhost:8080:127.0.0.1:${hostPort}`] : []),
    '--secret', `token=${loginToken}`,
    '--variable', `base_url=${baseURL}`,
    file
  ])
}

function checkLogs (additionalSecrets = []) {
  const logs = compose(['logs', '--no-color', 'router', 'downloader', 'builder'], {}, true)
  const forbidden = [loginToken, internalToken, verifier, ...additionalSecrets]
  if (forbidden.some(value => value && logs.includes(value)) || /"(?:authorization|cookie|csrfToken|token)"/i.test(logs) || /ghhc-console-dev=[A-Za-z0-9_-]{43}/.test(logs)) {
    throw new Error('sensitive value found in service logs')
  }
  if (/\b(?:Error:|at \/app\/|node:internal)\b/.test(logs)) throw new Error('stack trace found in service logs')
}

function compose (args, environment = {}, capture = false) {
  return run('docker', [...composeArgs, ...args], { ...process.env, ...environment }, capture)
}

function deploymentCompose (args, capture = false) {
  return run('docker', [...deploymentComposeArgs, ...args], deploymentEnvironment, capture)
}

function run (command, args, environment = process.env, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: environment,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${basename(command)} exited with ${result.status}`)
  return capture ? result.stdout : ''
}

function cleanup () {
  if (cleaning) return
  cleaning = true
  cleanupDeployment()
  spawnSync('docker', [...composeArgs, 'down', '--volumes', '--remove-orphans'], { cwd: root, stdio: 'ignore' })
}

function cleanupDeployment () {
  spawnSync('docker', [...deploymentComposeArgs, 'down', '--volumes', '--remove-orphans'], {
    cwd: root,
    env: deploymentEnvironment,
    stdio: 'ignore'
  })
}
