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
| token | Personal access token used to gain access to GitHub API. The token scope is requires only access to public repositories. See [GitHub Help - Creating a personal access token for the command line](https://help.github.com/en/github/authenticating-to-github/creating-a-personal-access-token-for-the-command-line) for more information. |
| cleanInterval | How often the server should check if it is time to clean. Defaults to every 2 hours (Note that the cleanup job|
| cleanThreshold | The amount of downloaded branches that will trigger the clean up job. Defaults to 1000 |
| tmpLifetime | How many hours since last request to keep a branch when cleaning up |

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

## Run the application
Open a CLI and run the command: `npm start`

Open `http://localhost:80` in a browser and you should see the index page of the app.
It is possible to configure which port the application listens to, see [Configure settings](#configure-settings).

## Code documentation
Each file contains a descriptive header, mentioning its author, purpose and so on. Every function should contain a descriptive JSDoc header.

### File Structure
| Path | Description |
|---|---|
| app | Contains all the application JS code. |
| assets | Contains assets like CSS, images, etc. |
| scripts | Tooling scripts used for deployment and such. Should not be deployed with the application. |
| test | Contains all the unit-tests for the application. Should not be deployed with the application. |
| tmp | Where the temporary files used in the application is written. |
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

## Nice to know
The application does not do a full clone of the `highcharts` repo. It fetches only certain folders within that repo.
The files are downloaded via GitHub Contents API and stored in a local folder per branch/tag/ref the first time a particular branch/tag/ref is requested. For every subseqent request the local version will be used, which, means that the state of a particular branch won't be updated unless the application is redeployed.

TypeScript: When fetching a branch the downloaded contents are checked for the presence of a Typescript config - and if found it will run an additional step for compiling the files to Javascript.
Note that TypeScript files are not being served by this application.

For bundling master files, or custom files the `highcharts-assembler` is used.

### Troubleshooting
The temporary folder `tmp/` folder may become bloated or have a partial state if something goes wrong. This may cause unexpected behaviour. If you experience something similar then try to delete everything in the  `tmp/` folder and retry your request.
