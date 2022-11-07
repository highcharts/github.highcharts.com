/**
 * Simple testing tool to be used before/after changes
 * Will iterate over the the modules in modules.mjs and query the server for them.
 *
 * Run with `node ./test/post-build.mjs`
 *
 * Use the `--branch` argument to set the branch
 * `--delay=1000` to change the delay between queries in millseconds (defaults to 500)
 * `--baseUrl` to set the base url (defaults to http://localhost:8080)
 *
 * Testing procedures
 *   - test master branch
 *   - test a more complex branch name, i.e. the latest bugfix/... branch
 */

import paths from './modules.mjs';
import ky from 'ky-universal';

const options = {
    baseUrl: 'http://localhost:8080',
    delay: 500, // wait time between queries
    branch: '',
    retry: 2
};

const args = process.argv.splice(2);
args.forEach(arg => {
    arg = arg.replace(/^-+/, ''); // remove - or --
    const [argName, value] = arg.split('=');

    options[argName] = value;
});

async function waitFor(time) {
    await new Promise((resolve) => {
        setTimeout(() => {
            resolve()
        }, parseInt(time));
    })
}

const urls = paths.map(path => {
    const { baseUrl, branch } = options;
    return (branch.length ? [baseUrl, branch, path] : [baseUrl, path]).join('/');
});

(async () => {
    for (const url of urls) {
        try {
            const result = await ky(url, {
                headers: {
                    Referer: 'http://highcharts.local'
                },
                timeout: 10000,
                retry: options.retry
            });

            console.log(result.url, result.status);
            await waitFor(options.delay);
        } catch (error) {
            if (error.response) {
                console.error(error.response.url, error.response.status)
            }
            else console.error(`fetching ${url} failed with error:`, error)
        }
    }
})();
