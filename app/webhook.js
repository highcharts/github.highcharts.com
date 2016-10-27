'use strict';
const sha1 = (secret, data) => {
	const crypto = require('crypto');
	return crypto
		.createHmac('sha1', secret)
		.update(data)
		.digest('hex');
};

const validSignature = (signature, body) => {
	const secret = require('../config.json').secureToken;
	const hash = 'sha1=' + sha1(secret, body);
	return signature === hash;
};

const validateWebHook = request => {
	const body = request.body;
	const signature = request.headers['x-hub-signature'];
	let valid = false;
	let message = '';
	console.log('@validateWebHook', (!(body && Object.keys(body).length > 0)))
	if (!(body && Object.keys(body).length > 0)) {
		message = 'Missing payload';
	} else if (!validSignature(signature, JSON.stringify(body))) {
		message = 'Invalid signature';
	} else if (!body.ref) {
		message = 'Missing Git ref';
	} else {
		valid = true;
	}
	return {
		valid: valid,
		message: message
	};
}

module.exports = {
	sha1,
	validSignature,
	validateWebHook
}