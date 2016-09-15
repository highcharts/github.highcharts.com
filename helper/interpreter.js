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
	return {
		'modules/accessibility.src.js': {
			exclude: new RegExp(folders.parts),
			umd: false
		},
		'modules/annotations.src.js': {
			exclude: new RegExp(folders.parts),
			umd: false
		},
		'modules/boost.src.js': {
			exclude: new RegExp(folders.parts),
			umd: false
		},
		'modules/broken-axis.src.js': {
			exclude: new RegExp(folders.parts),
			umd: false
		},
		'modules/canvasrenderer.experimental.src.js': {
			exclude: new RegExp(folders.parts),
			umd: false
		},
		'modules/canvgrenderer-extended.src.js': {
			exclude: new RegExp(folders.parts),
			umd: false
		},
		'modules/data.src.js': {
			exclude: new RegExp(folders.parts),
			umd: false
		},
		'modules/drilldown.src.js': {
			exclude: new RegExp(folders.parts),
			umd: false
		},
		'modules/exporting.src.js': {
			exclude: new RegExp(folders.parts),
			umd: false
		},
		'modules/funnel.src.js': {
			exclude: new RegExp(folders.parts),
			umd: false
		},
		'modules/heatmap.src.js': {
			exclude: new RegExp(folders.parts),
			umd: false
		},
		'modules/map.src.js': {
			exclude: new RegExp(folders.parts),
			umd: false
		},
		'modules/map-parser.src.js': {
			exclude: new RegExp([folders.parts, 'data\.src\.js$'].join('|')),
			umd: false
		},
		'modules/no-data-to-display.src.js': {
			exclude: new RegExp(folders.parts),
			umd: false
		},
		'modules/offline-exporting.src.js': {
			exclude: new RegExp(folders.parts),
			umd: false
		},
		'modules/overlapping-datalabels.src.js': {
			exclude: new RegExp(folders.parts),
			umd: false
		},
		'modules/series-label.src.js': {
			exclude: new RegExp(folders.parts),
			umd: false
		},
		'modules/solid-gauge.src.js': {
			exclude: new RegExp([folders.parts, 'GaugeSeries\.js$'].join('|')),
			umd: false
		},
		'modules/treemap.src.js': {
			exclude: new RegExp(folders.parts),
			umd: false
		},
		'highcharts-more.src.js': {
			exclude: new RegExp(folders.parts),
			umd: false
		},
		'highcharts-3d.src.js': {
			exclude: new RegExp(folders.parts),
			umd: false
		}
	};
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
	if (sections.length > 1 && folders.indexOf(sections[0]) === -1) {
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
	// Remove branch from path
	if (type === 'css' && sections[0] === 'js') {
		sections.splice(0, 1);
	}
	// Check if it is a .js file
	if (sections[sections.length - 1].endsWith('.js')) {
		filename = sections.join('/');
	}
	return filename;
};

module.exports = {
	getBranch,
	getFile,
	getFileOptions,
	getType
};