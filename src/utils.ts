/* eslint-disable camelcase */
import { join } from "node:path";
import { promisify } from 'node:util';
import { exec } from 'node:child_process';

function shouldUseWebpack(tsconfig: string) : boolean {
  if (/"outDir":.*code\/es-modules\/"/.test(tsconfig)) {
    return true;
  }

  return false;
}

function compileWebpack(srcFolder: string) {
  const configDir = 'tools/webpacks';

  const configs = ['highcharts.webpack.mjs'];
  const execAsync = promisify(exec);

  const promises = []

  for (const c of configs) {
    const execProm = execAsync(
      `npx webpack -c ${join(configDir, c)} --output-path ./output`,
      { timeout: 7000, cwd: srcFolder }
    ).then(({stdout, stderr}) => {
      if (stderr) {
        console.error(stderr);
        return;
      }
      console.log(stdout)
    }).catch(err => {
      throw new Error('Failed running webpack', { cause: err })
    })

    promises.push(execProm)
  }

  return Promise.all(promises)
}

module.exports = {
  shouldUseWebpack,
  compileWebpack
}
