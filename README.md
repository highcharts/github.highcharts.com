# github.highcharts.com
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)

Node.js server which runs a RESTful application to serve requested Highcharts distribution files for a given version. Used for testing purposes only.

## Install
Open a CLI and navigate to where you would like to install the application.

Clone the repository and install required dependencies by running the following command:
```
git clone https://github.com/highcharts/github.highcharts.com.git
cd github.highcharts.com
npm i
```

### Configure settings
The application requires a configuration file `./config.json` to be able to run. All possible configuration options is listed below.

| Setting | Description |
|---|---|
| informationLevel | The level of severity of the information outputted to the log. The severity can be 0 (everything), 1 (warnings and errors), 2 (only errors). Defaults to 2. You can override this per runtime by setting the `INFORMATION_LEVEL` environment variable. |
| port | The port the server application will listen to. Defaults to 80. |
| secureToken | The secret token used to validate the GitHub webhook post to /update. See [GitHub Developer - Securing your webhooks](https://developer.github.com/webhooks/securing/) for more information. |
| token | Personal access token used to gain access to GitHub API (unused in git-only mode). The token scope is requires only access to public repositories. See [GitHub Help - Creating a personal access token for the command line](https://help.github.com/en/github/authenticating-to-github/creating-a-personal-access-token-for-the-command-line) for more information. |
| cleanInterval | How often the server should check if it is time to clean. Defaults to every 2 hours (Note that the cleanup job|
| cleanThreshold | The amount of downloaded branches that will trigger the clean up job. Defaults to 1000 |
| tmpLifetime | How many hours since last request to keep a branch when cleaning up |

**Note on esbuild mode**: esbuild compilation requires no additional configuration. The feature is enabled by the `?esbuild` query parameter and uses the same cache cleanup settings as standard builds, but with separate `output-esbuild/` directories.

Example config file:
```json
{
    "informationLevel": 0,
    "port": 90,
    "token": "token",
    "secureToken": "secureToken",
    "cleanThreshold": 1500,
    "tmpLifetime": 168
}
```

To override logging without editing `config.json`, set an environment variable before starting the server, for example:

```bash
INFORMATION_LEVEL=0 npm start
```

Environment variables take precedence over values in `config.json`.

### Git-only runtime cache
This server now uses a local git clone under `tmp/git-cache/repo` for all source retrieval.
The GitHub API is not used in production.

Environment variables:
- `GIT_SYNC_INTERVAL_MS`: Interval for `git fetch` + `git checkout -B master origin/master` (default 30 minutes).
- `GIT_REF_CLEAN_INTERVAL_MS`: Interval for cleaning inactive refs in `tmp/` (default 30 minutes).

The cleanup process keeps active refs based on the `info.json` timestamp in each `tmp/{ref}` directory.

## Run the application
Open a CLI and run the command: `npm start`

Open `http://localhost:80` in a browser and you should see the index page of the app.
It is possible to configure which port the application listens to, see [Configure settings](#configure-settings).

## Usage

### Basic Examples

```
# Master branch
https://github.highcharts.com/master/highcharts.src.js

# Version tag
https://github.highcharts.com/v10.3.3/highcharts.src.js

# Commit SHA (full or short)
https://github.highcharts.com/abc1234/highcharts.src.js

# Feature branch
https://github.highcharts.com/feature/my-branch/highcharts.src.js

# Modules
https://github.highcharts.com/master/modules/exporting.src.js

# Stock/Maps/Gantt
https://github.highcharts.com/master/highstock.src.js
https://github.highcharts.com/master/highmaps.src.js
https://github.highcharts.com/master/highcharts-gantt.src.js
```

### esbuild Mode

Add `?esbuild` to any request to use esbuild compilation instead of the standard TypeScript + assembler pipeline:

```
# esbuild compilation
https://github.highcharts.com/master/highcharts.src.js?esbuild
https://github.highcharts.com/v11.4.0/modules/exporting.src.js?esbuild
https://github.highcharts.com/feature/my-branch/highstock.src.js?esbuild
```

**Benefits:**
- **Faster compilation**: esbuild typically 10-100x faster than TypeScript compiler
- **Same output format**: UMD bundles compatible with browsers, AMD, and CommonJS
- **Separate caching**: Uses `output-esbuild/` directory to avoid conflicts
- **Easy identification**: `X-Built-With: esbuild` response header indicates esbuild compilation
- **Error handling**: Compilation errors return JavaScript with helpful `console.error()` messages
- **Legacy compatibility**: Automatic support for older Highcharts versions via plugins
- **Performance logging**: Console output shows compilation time for debugging

**Response headers for esbuild requests:**
```
X-Built-With: esbuild
ETag: {commit-sha}
```

**Technical Implementation:**
- **Primary files** (e.g., `highcharts.src.js`, `highstock.src.js`) get full UMD wrappers
- **Module files** (e.g., `modules/exporting.src.js`) get dependency-aware UMD wrappers
- **ES modules support**: Files in `/es-modules/` paths receive ES module treatment
- **Version detection**: Automatic legacy plugin application for versions < 11.2.0
- **Namespace mapping**: Smart replacement of core dependencies to use existing globals
- **Error resilience**: Compilation failures return executable JavaScript with error logging

**Dependencies:**
- `esbuild` ^0.25.0 - Core compilation engine
- `esbuild-plugin-replace-regex` ^0.0.2 - Legacy compatibility patches
- `semver` ^7.6.0 - Version detection for compatibility features

### Supported Build Modes

- **Classic builds** (default): TypeScript → Assembler → UMD bundles
- **Webpack builds**: Detected when `tsconfig.json` has `"outDir": "code/es-modules/"`
- **esbuild builds**: Use `?esbuild` query parameter for faster compilation with esbuild

## Code documentation
Each file contains a descriptive header, mentioning its author, purpose and so on. Every function should contain a descriptive JSDoc header.

### File Structure

| Path | Description |
|---|---|
| app | Contains all the application JS code. |
| app/esbuild.js | esbuild compilation engine for faster builds with UMD wrapper generation |
| assets | Contains assets like CSS, images, etc. |
| scripts | Tooling scripts used for deployment and such. Should not be deployed with the application. |
| test | Contains all the unit-tests for the application. Should not be deployed with the application. |
| test/esbuild.js | Unit tests for esbuild compilation functionality |
| tmp | Where the temporary files used in the application is written. |
| tmp/{branch}/output | Final assembled files (classic builds) |
| tmp/{branch}/output-esbuild | esbuild compiled files (separate cache) |
| static | Where the HTML files are located. |

## Update the Highcharts assembler
Open a CLI and run the following command to install an updated version of the assembler:
```
npm install highcharts/highcharts-assembler#<tag>
```
Then update the version number in package.json, as normal when there is an important change.
Commit the changes to Github, and continue on to deployment.

## Deployment
Before deploying a new application, please ensure the following requirements are met.
### Requirements
1. Version number in `package.json` must have been updated since last deployment. See [Update version](#update-version).
2. Any updates must be committed to ensure the running application is tracked.
3. `config.json` is configured according to requirements. See [Configure settings](#configure-settings).

### Update version
Version number must be updated to keep track of which version of the application is currently in production, and which version will be eventually deployed.

Run `npm version [patch|minor|major]` to bump the version.
Then run `git push && git push --tags` to publish the new version to the GitHub repository.

### Packaging
Open a CLI and run the following command:
`npm run build`
The application will be packed into an archive named `github.highcharts-<version>.zip`. The zip is ready to be uploaded and unpacked on your server.

## Build Process

The application supports multiple build modes to compile TypeScript source files into JavaScript bundles:

### Standard Build Process (Default)

1. **Download**: Downloads TypeScript source files from GitHub for the specified branch/commit
2. **TypeScript Compilation**: Compiles `.ts` files to JavaScript using TypeScript compiler
3. **Assembly**: Uses `@highcharts/highcharts-assembler` to create UMD bundles with dependencies
4. **Caching**: Results are cached to speed up subsequent requests

### esbuild Process (with `?esbuild`)

1. **Download**: Downloads TypeScript source files from GitHub for the specified branch/commit
2. **esbuild Compilation**: Compiles TypeScript directly to JavaScript with UMD wrappers
3. **Module Resolution**: Applies post-processing for module compatibility and namespace mappings
4. **Caching**: Results are cached in separate `output-esbuild/` directory

**Key differences:**
- **Performance**: esbuild is significantly faster than tsc + assembler
- **Direct compilation**: TypeScript → JavaScript compilation with built-in bundling
- **UMD compatibility**: Same output format for browser/AMD/CommonJS compatibility
- **Isolated cache**: Separate cache to avoid conflicts with standard builds
- **Legacy support**: Compatibility for older Highcharts versions via plugins

**esbuild-specific features:**
- **Smart path resolution**: Automatic mapping of master file paths (e.g., `/es-modules/masters` → TypeScript sources)
- **Dual UMD modes**: Primary files get full UMD wrappers, modules get dependency-aware wrappers
- **Namespace injection**: Runtime replacement of core modules with existing global references
- **Version-aware processing**: Automatic legacy patches for TypeScript syntax changes
- **Build context preservation**: Maintains version strings and asset prefixes during compilation
- **Error recovery**: Failed compilations return executable error-reporting JavaScript

### Webpack Builds

Automatically detected when `tsconfig.json` has `"outDir": "code/es-modules/"`. Uses webpack for module bundling.

## Nice to know
The application does not do a full clone of the `highcharts` repo. It fetches only certain folders within that repo.
The files are downloaded via GitHub Contents API and stored in a local folder per branch/tag/ref the first time a particular branch/tag/ref is requested. For every subseqent request the local version will be used, which, means that the state of a particular branch won't be updated unless the application is redeployed.

TypeScript: When fetching a branch the downloaded contents are checked for the presence of a Typescript config - and if found it will run an additional step for compiling the files to Javascript.
Note that TypeScript files are not being served by this application.

For bundling master files, or custom files the `highcharts-assembler` is used.

### Troubleshooting

**Build Failures:**
- Check if the branch/commit exists on GitHub
- Verify the file path exists in that branch
- Check server logs for compilation errors
- Some older commits may not have TypeScript sources
- For esbuild mode: compilation errors are returned as JavaScript with `console.error()` messages

**esbuild-specific troubleshooting:**
- **Legacy version issues**: Versions < 11.2.0 automatically receive compatibility patches
- **Missing dependencies**: Check browser console for namespace resolution errors
- **UMD wrapper problems**: Verify that primary files use correct global names (`Highcharts`, `Dashboards`, etc.)
- **Performance debugging**: Check browser console for compilation time logs
- **Module conflicts**: esbuild cache is isolated in `output-esbuild/` to prevent cross-contamination

**Cache Issues:**
The temporary folder `tmp/` folder may become bloated or have a partial state if something goes wrong. This may cause unexpected behaviour. If you experience something similar then try to delete everything in the `tmp/` folder and retry your request.

**Performance:**
- Use `?esbuild` for faster compilation times
- esbuild cache is separate from standard builds (`output-esbuild/` vs `output/`)
- Both build modes support the same file types and UMD output format
