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

function compileWebpack(srcFolder: string, config ='highcharts.webpack.mjs') {
  const configDir = 'tools/webpacks';
  console.log('Compiling webpack for: ', srcFolder)

  const execAsync = promisify(exec);

  return execAsync(
    `npx webpack -c ${join(configDir, config)} --output-path ./output --stats errors-only`,
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

}

module.exports = {
  shouldUseWebpack,
  compileWebpack
}
