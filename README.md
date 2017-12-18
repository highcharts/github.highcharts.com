# github.highcharts.com
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)

Node.js server which runs a RESTful application to serve Highcharts scripts built from the Highcharts build script.

## Code documentation
Each file contains a descriptive header, mentioning its author, purpose and so on. Every function contains a JSDoc header.

## Install
Clone repository and put the repository folder in the same folder which the Highcharts repository folder is located.

Open a CLI and run the command: `npm install`

## Run the application
Open a CLI and run the command: `npm start`

Open `http://localhost:80` in a browser and you should see the index page of the app.
You can edit which port the application listens to, by setting the attribute `port` in `config.json`.

## Update the Highcharts version used in the Download Builder
Open a CLI and run the following command:
```
npm run update-download-source
```
Commit the changes to Github.

Do deployment of new version.

`@todo` Publish the part files as ES6 modules on NPM and then require them. This way it will always be up to date.
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
1. Version number in `package.json` must have been updated since last deployment.
2. Any updates must be committed to ensure the running application is tracked.
3. `config.json` is configured according to guide. (Contents of config.json stored in 1password)

### Packaging
Open a CLI and run the following command:
`npm run build`
The application will be packed into an archive named `github.highcharts-<version>.zip`. The zip is ready to be uploaded and unpacked on your server.

## File Structure
### Folders
```
- app
- assets
- tmp
- views
```

#### app
Contains all the application JS code.

#### assembler
All the files of the Highcharts assembler, copied directly from the Highcharts repository.

#### assets
Contains assets like CSS, images, etc.

#### tmp
Where the temporary files used in the application is written.

#### views
Where the HTML files are located.

