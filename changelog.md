# Changelog

## 1.1.0
- Added `getDownloadFiles` to dynamically know which files to download from the Github repository.
- Installed [forever](https://www.npmjs.com/package/forever) to ensure continuously running of application.
- Renamed the folder `helper` to `app`.
- Renamed `app.js` to `server.js`.
- Updated `getFileOptions` to dynamically know what fileOptions should be.

## 1.2.0
- Configured [forever](https://www.npmjs.com/package/forever) log files. 
- Keep already built Highcharts files for improved performance.
- Added functionality to validate a Webhook from Github.
- Added /update which listens to push events from repository, and removes the stored source files.
- On startup the server outputs which port it listens to.
- Updated assembler files.
- Updated source files used in download builder to v5.0.2.

## 1.3.0 [WIP]
- Fixed issue with validation of Github Webhook.
- Fixed issue with custom body parser.
- Updated source files used in download builder to v5.0.14.
- Modified download builder router to receive more compact requests.
- Created deploy script to package application files into a zip archive.
- Updated assembler files.
- Fixed issue with themes UMD wrap.
- Fixed issue with missing tmp folder when using deploy script.
