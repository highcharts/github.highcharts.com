'use strict';
/**
 * Returns fileOptions for the build script
 * @return {Object} Object containing all fileOptions
 */
const getFileOptions = () => {
	const DS = '[\\\\\\\/][^\\\\\\\/]'; // Regex: Single directory seperator
	const folders = {
		'parts': 'parts' + DS + '+\.js$',
		'parts-more': 'parts-more' + DS + '+\.js$'
	};
	// @todo Shorten this logic and make it more dynamic
	let fileOptions = [
		'accessibility',
		'annotations',
		'boost',
		'broken-axis',
		'canvasrenderer.experimental',
		'canvgrenderer-extended',
		'data',
		'drilldown',
		'exporting',
		'funnel',
		'gantt',
		'grid-axis',
		'highcharts-3d',
		'highcharts-more',
		'heatmap',
		'map',
		'map-parser',
		'no-data-to-display',
		'offline-exporting',
		'overlapping-datalabels',
		'series-label',
		'solid-gauge',
		'treemap',
		'xrange-series'
	].reduce((obj, file) => {
		obj['modules/' + file + '.src.js'] = {
			exclude: new RegExp(folders.parts),
			umd: false
		};
		return obj;
	}, {});
	fileOptions['modules/solid-gauge.src.js'].exclude = new RegExp([folders.parts, 'GaugeSeries\.js$'].join('|'));
	Object.assign(fileOptions, {
		'highcharts-more.src.js': {
			exclude: new RegExp(folders.parts),
			umd: false
		},
		'highcharts-3d.src.js': {
			exclude: new RegExp(folders.parts),
			umd: false
		}
	});
	return fileOptions;
};

/**
 * Return which branch/tag/commit to gather the file from. Defaults to master.
 * @param  {string} url Request url
 * @return {string} Returns which branch/tag/commit to look in.
 */
const getBranch = url => {
	const folders = ['adapters', 'modules', 'parts-3d', 'parts-map', 'parts-more', 'parts', 'themes'];
	let branch = 'master';
	let sections = url.substring(1).split('/');
	/**
	 *  If the url has more then 1 section, 
	 *  and the first section is not indicating one of the js folders,
	 *  then assume first section is a branch/tag/commit
	 */
	if (sections.length > 1 && 
		['stock', 'maps'].indexOf(sections[0]) === -1 && 
		folders.indexOf(sections[0]) === -1) {
		branch = sections[0];
	}
	return branch;
};

/**
 * Returns which type of Highcharts build to serve. Can either be classic or css. Defaults to classic.
 * @param  {string} branch Branch to look in
 * @param  {string} url Request url
 * @returns {string} Returns which type to build
 */
const getType = (branch, url) => {
	let type = 'classic';
	let sections = url.substring(1).split('/');
	// Remove branch from path
	if (sections[0] === branch) {
		sections.splice(0, 1);
	}
	/**
	 * If the first section is either stock or maps, then remove it.
	 */
	if (sections[0] === 'stock' || sections[0] === 'maps') {
		sections.splice(0, 1);
	}
	// Check if it is a .js file
	if (sections[0] === 'js') {
		type = 'css';
	}
	return type;
};

/**
 * Returns the filename, or false if it is not a js file.
 * @param  {string} branch Branch to look in
 * @param  {string} url Request url
 * @return {boolean|string} Returns false if not a js file. Otherwise returns filename.
 */
const getFile = (branch, type, url) => {
	let filename = false;
	let sections = url.substring(1).split('/');
	// Remove branch from path
	if (sections[0] === branch) {
		sections.splice(0, 1);
	}
	/**
	 * If the first section is either stock or maps, then remove it.
	 */
	if (sections[0] === 'stock' || sections[0] === 'maps') {
		sections.splice(0, 1);
	}
	// Remove branch from path
	if (type === 'css' && sections[0] === 'js') {
		sections.splice(0, 1);
	}
	// Check if it is a .js file
	if (sections[sections.length - 1].endsWith('.js')) {
		filename = sections.join('/');
		// Redirect .js requests to .src.js
		if (!filename.endsWith('.src.js')) {
			filename = filename.replace('.js', '.src.js');
		}
	}
	return filename;
};

module.exports = {
	getBranch,
	getFile,
	getFileOptions,
	getType
};