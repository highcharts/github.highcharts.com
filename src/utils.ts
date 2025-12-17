/* eslint-disable camelcase */
import { join } from "node:path";
import { promisify } from 'node:util';
import { exec } from 'node:child_process';

import { symlinkSync, existsSync } from 'node:fs';

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
    `npx webpack -c ${join(configDir, config)} --stats errors-only`,
    { timeout: 15000, cwd: srcFolder }
  ).then(({stdout, stderr}) => {
    if (stderr) {
      console.error(stderr);
      return;
    }

    // Symlink files to ./output
    const outputDir = join(srcFolder, '/output');
    const codeDir = join(srcFolder, '/code');
    if (existsSync(codeDir) && !existsSync(outputDir)){
      symlinkSync(codeDir, outputDir);
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
