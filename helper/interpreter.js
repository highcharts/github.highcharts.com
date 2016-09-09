'use strict';
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
 * Returns the filename, or false if it is not a js file.
 * @param  {string} branch Branch to look in
 * @param  {string} url Request url
 * @return {boolean|string} Returns false if not a js file. Otherwise returns filename.
 */
const getFile = (branch, url) => {
	let filename = false;
	let sections = url.substring(1).split('/');
	// Remove branch from path
	if (sections[0] === branch) {
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
	getFile
};