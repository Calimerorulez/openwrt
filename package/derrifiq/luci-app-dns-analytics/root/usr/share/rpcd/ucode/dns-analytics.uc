'use strict';

import { popen } from 'fs';

function call_helper(command) {
	let process = popen(command, 'r');

	if (!process)
		return {
			error: 'backend_start_failed'
		};

	let output = process.read('all');
	let status = process.close();

	if (status != 0)
		return {
			error: 'backend_failed',
			exit_code: status
		};

	let result;

	try {
		result = json(output);
	}
	catch (e) {
		return {
			error: 'invalid_backend_response',
			message: `${e}`
		};
	}

	return result;
}

function call_overview() {
	return call_helper(
		'/usr/libexec/dns-analytics/luci-overview'
	);
}

function call_top_domains() {
	return call_helper(
		'/usr/libexec/dns-analytics/luci-top-domains'
	);
}

function call_top_categories() {
	return call_helper(
		'/usr/libexec/dns-analytics/luci-top-categories'
	);
}

return {
	'dns-analytics': {
		overview: {
			call: call_overview
		},

		'top-domains': {
			call: call_top_domains
		},

		'top-categories': {
			call: call_top_categories
		}
	}
};
