'use strict';
const U = require('./utilities.js');

/**
 * Download a single file.
 * @param  {string} base   Base url
 * @param  {string} path   Location of file. Url is base + '/' + path
 * @param  {string} output Where to output the file
 * @return {Promise} Returns a promise when resolved contains the status code and path to the file. 
 */
const downloadFile = (base, path, output) => {
    return new Promise((resolve) => {
        const fs = require('fs');
        const https = require('https');
        let url = base + '/' + path;
        let outputPath = output + '/' + path;
        U.createDirectory(U.folder(outputPath));
        https.get(url, response => {
            if (response.statusCode === 200) {
                let file = fs.createWriteStream(outputPath);
                response.pipe(file);
                file.on('finish', () => {
                    resolve({
                        status: response.statusCode,
                        path: outputPath
                    });
                });
            } else {
                resolve({
                    status: response.statusCode
                });
            }
        });
    });
};

/**
 * Downloads a series of files using the same base url
 * @param  {string} base The base url
 * @param  {[string]} filePaths Array of filepaths.
 * @param  {string} output Where to output the file
 * @return {Promise} Returns a promise which is resolved when all files are downloaded
 */
const downloadFiles = (base, filePaths, output) => {
    return new Promise((resolve) => {
        let promises = filePaths.map(path => downloadFile(base, path, output));
        Promise.all(promises).then((values) => resolve(values));
    });
};

/**
 * Download all the files in the js folder of the repository
 * @param  {string} output Where to output all the files
 * @param  {string} url Url to the repository in raw format
 * @return {Promise} Returns a promise which is resolved when all files are downloaded
 */
const downloadJSFolder = (output, url) => {
    return downloadFiles(url, [
        'css/highcharts.scss',
        'js/masters/highcharts-3d.src.js',
        'js/masters/highcharts-more.src.js',
        'js/masters/highcharts.src.js',
        'js/masters/highmaps.src.js',
        'js/masters/highstock.src.js',
        'js/masters/modules/annotations.src.js',
        'js/masters/modules/boost.src.js',
        'js/masters/modules/broken-axis.src.js',
        'js/masters/modules/canvasrenderer.experimental.src.js',
        'js/masters/modules/canvgrenderer-extended.src.js',
        'js/masters/modules/data.src.js',
        'js/masters/modules/drilldown.src.js',
        'js/masters/modules/exporting.src.js',
        'js/masters/modules/funnel.src.js',
        'js/masters/modules/heatmap.src.js',
        'js/masters/modules/map-parser.src.js',
        'js/masters/modules/map.src.js',
        'js/masters/modules/no-data-to-display.src.js',
        'js/masters/modules/offline-exporting.src.js',
        'js/masters/modules/overlapping-datalabels.src.js',
        'js/masters/modules/series-label.src.js',
        'js/masters/modules/solid-gauge.src.js',
        'js/masters/modules/treemap.src.js',
        'js/modules/accessibility.src.js',
        'js/modules/annotations.src.js',
        'js/modules/boost.src.js',
        'js/modules/broken-axis.src.js',
        'js/modules/canvasrenderer.experimental.src.js',
        'js/modules/canvgrenderer-extended.src.js',
        'js/modules/data.src.js',
        'js/modules/drilldown.src.js',
        'js/modules/exporting.src.js',
        'js/modules/funnel.src.js',
        'js/modules/map-parser.src.js',
        'js/modules/map.src.js',
        'js/modules/no-data-to-display.src.js',
        'js/modules/offline-exporting.src.js',
        'js/modules/overlapping-datalabels.src.js',
        'js/modules/series-label.src.js',
        'js/modules/solid-gauge.src.js',
        'js/modules/treemap.src.js',
        'js/parts/AreaSeries.js',
        'js/parts/AreaSplineSeries.js',
        'js/parts/Axis.js',
        'js/parts/BarSeries.js',
        'js/parts/CandlestickSeries.js',
        'js/parts/CanVGRenderer.js',
        'js/parts/CenteredSeriesMixin.js',
        'js/parts/Chart.js',
        'js/parts/Color.js',
        'js/parts/ColumnSeries.js',
        'js/parts/DataGrouping.js',
        'js/parts/DataLabels.js',
        'js/parts/DateTimeAxis.js',
        'js/parts/Dynamics.js',
        'js/parts/Facade.js',
        'js/parts/FlagsSeries.js',
        'js/parts/Globals.js',
        'js/parts/Html.js',
        'js/parts/Interaction.js',
        'js/parts/Intro.js',
        'js/parts/JQueryAdapter.js',
        'js/parts/Legend.js',
        'js/parts/LineSeries.js',
        'js/parts/LogarithmicAxis.js',
        'js/parts/MSPointer.js',
        'js/parts/OHLCSeries.js',
        'js/parts/Options.js',
        'js/parts/OrdinalAxis.js',
        'js/parts/Outro.js',
        'js/parts/PathAnimation.js',
        'js/parts/PieSeries.js',
        'js/parts/PlotBandSeries.experimental.js',
        'js/parts/PlotLineOrBand.js',
        'js/parts/Point.js',
        'js/parts/Pointer.js',
        'js/parts/RangeSelector.js',
        'js/parts/Responsive.js',
        'js/parts/ScatterSeries.js',
        'js/parts/Scrollbar.js',
        'js/parts/Scroller.js',
        'js/parts/Series.js',
        'js/parts/SplineSeries.js',
        'js/parts/Stacking.js',
        'js/parts/StackItem.js',
        'js/parts/StockChart.js',
        'js/parts/StockNavigation.js',
        'js/parts/SvgRenderer.js',
        'js/parts/Tick.js',
        'js/parts/Tooltip.js',
        'js/parts/TouchPointer.js',
        'js/parts/Utilities.js',
        'js/parts/VmlRenderer.js',
        'js/parts-3d/Axis.js',
        'js/parts-3d/Chart.js',
        'js/parts-3d/Column.js',
        'js/parts-3d/Globals.js',
        'js/parts-3d/Intro.js',
        'js/parts-3d/Math.js',
        'js/parts-3d/Pie.js',
        'js/parts-3d/Scatter.js',
        'js/parts-3d/SVGRenderer.js',
        'js/parts-3d/VMLRenderer.js',
        'js/parts-map/ColorAxis.js',
        'js/parts-map/ColorSeriesMixin.js',
        'js/parts-map/GeoJSON.js',
        'js/parts-map/HeatmapIntro.js',
        'js/parts-map/HeatmapSeries.js',
        'js/parts-map/Intro.js',
        'js/parts-map/IntroMapModule.js',
        'js/parts-map/Map.js',
        'js/parts-map/MapAxis.js',
        'js/parts-map/MapBubbleSeries.js',
        'js/parts-map/MapLineSeries.js',
        'js/parts-map/MapNavigation.js',
        'js/parts-map/MapPointer.js',
        'js/parts-map/MapPointSeries.js',
        'js/parts-map/MapSeries.js',
        'js/parts-more/AreaRangeSeries.js',
        'js/parts-more/AreaSplineRangeSeries.js',
        'js/parts-more/BoxPlotSeries.js',
        'js/parts-more/BubbleSeries.js',
        'js/parts-more/ColumnRangeSeries.js',
        'js/parts-more/ErrorBarSeries.js',
        'js/parts-more/GaugeSeries.js',
        'js/parts-more/Intro.js',
        'js/parts-more/Pane.js',
        'js/parts-more/Polar.js',
        'js/parts-more/PolygonSeries.js',
        'js/parts-more/RadialAxis.js',
        'js/parts-more/WaterfallSeries.js',
        'js/themes/dark-blue.js',
        'js/themes/dark-green.js',
        'js/themes/dark-unica.js',
        'js/themes/gray.js',
        'js/themes/grid-light.js',
        'js/themes/grid.js',
        'js/themes/sand-signika.js',
        'js/themes/skies.js'
    ], output);
};

/**
 * Download all the files in the assembler folder of the repository
 * @param  {string} output Where to output all the files
 * @param  {string} url Url to the repository in raw format
 * @return {Promise} Returns a promise which is resolved when all files are downloaded
 */
const downloadAssembler = (output, url) => {
    return downloadFiles(url, [
        'assembler/build.js',
        'assembler/dependencies.js',
        'assembler/process.js',
        'assembler/utilities.js'
    ], output);
};

module.exports = {
    downloadAssembler: downloadAssembler,
    downloadFile: downloadFile,
    downloadFiles: downloadFiles,
    downloadJSFolder: downloadJSFolder
};
