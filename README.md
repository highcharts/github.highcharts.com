# github.highcharts.com
Node.js server which runs a RESTful application to serve Highcharts scripts built from the Highcharts build script.

## Code documentation
Each file contains a descriptive header, mentioning its author, purpose and so on. Every function contains a JSDoc header.

## Install
Clone repository and put the repository folder in the same folder which the Highcharts repository folder is located.

Open a CLI and run the command: `npm install`

## Run the application
Open a CLI and run the command: `node app.js`

Open `http://localhost:8085` in a browser and you should see the index page of the app.

## Update the Highcharts version used in the Download Builder
Open a CLI and run the following command:
```
npm run update-download-source
```
Commit the changes to Github.

Do deployment of new version.

`@todo` Publish the part files as ES6 modules on NPM and then require them. This way it will always be up to date.
## Update the Highcharts assembler
Open a CLI and run the following command:
```
npm run update-assembler
```
Commit the changes to Github.

Do deployment of new version.

`@todo` Publish the assembler on NPM and then require it. This way it will always be up to date.

## File Structure
### Folders
```
- assembler
- assets
- helper
- logs
- node_modules
- source
- tmp
- views
```

#### assembler
All the files of the Highcharts assembler, copied directly from the Highcharts repository.

#### assets
Contains assets like CSS, images, etc.

#### helper
Contains all the application JS code.

`@todo` Rename folder to `app`

#### logs
Temporary folder where error logs are written to.

Important: Shall not be committed to Github, nor deployed.

`@todo` Write log files to `tmp` folder, in stead of `logs`.
#### node_modules
Where the Node modules are installed.

Important: Shall not be committed to Github, nor deployed.

#### source
Where the source files of the Download Builder is located.

#### tmp
Where the temporary files used in the application is written. The temporary files are deleted by the application after use.

Important: Shall not be committed to Github, nor deployed.

#### views
Where the HTML files are located.
## Deployment
