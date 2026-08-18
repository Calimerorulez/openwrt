'use strict';
'require view';
'require fs';
'require ui';

function parseTSV(data) {
	var lines = (data || '').trim().split(/\n/);

	if (!lines.length || !lines[0])
		return [];

	var headers = lines.shift().split('\t');

	return lines.filter(function(line) {
		return line.length > 0;
	}).map(function(line) {
		var values = line.split('\t');
		var row = {};

		headers.forEach(function(key, idx) {
			row[key] = values[idx] || '';
		});

		return row;
	});
}

function cell(value) {
	return value && value !== '-' ? value : '—';
}

return view.extend({
	load: function() {
		return fs.read('/etc/unbound/panici/devices.tsv');
	},

	render: function(data) {
		var devices = parseTSV(data);

		var table = E('table', {
			'class': 'table'
		}, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', { 'class': 'th' }, _('MAC')),
				E('th', { 'class': 'th' }, _('IP')),
				E('th', { 'class': 'th' }, _('UniFi name')),
				E('th', { 'class': 'th' }, _('Suggested')),
				E('th', { 'class': 'th' }, _('Canonical')),
				E('th', { 'class': 'th' }, _('Source')),
				E('th', { 'class': 'th' }, _('Vendor')),
				E('th', { 'class': 'th' }, _('MAC status'))
			])
		]);

		devices.forEach(function(d) {
			var macStatus;

			if (d.mac_type === 'locally-administered') {
				macStatus = E('span', {
					'title': _('Locally administered MAC. This may be a fixed private address, rotating private address, virtual MAC, or manually assigned MAC.')
				}, [
					'⚠ ',
					_('Stability unknown')
				]);
			}
			else {
				macStatus = _('Globally administered');
			}

			table.appendChild(E('tr', { 'class': 'tr' }, [
				E('td', { 'class': 'td' }, cell(d.mac)),
				E('td', { 'class': 'td' }, cell(d.ip)),
				E('td', { 'class': 'td' }, cell(d.unifi_name)),
				E('td', { 'class': 'td' }, cell(d.suggested_name)),
				E('td', { 'class': 'td' }, cell(d.canonical)),
				E('td', { 'class': 'td' }, cell(d.canonical_source)),
				E('td', { 'class': 'td' }, cell(d.oui)),
				E('td', { 'class': 'td' }, macStatus)
			]));
		});

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Panici DNS Devices')),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('Discovered clients and canonical panici.casa identities. UniFi data is read-only; canonical overrides are managed locally on Dobby.')
			]),
			E('div', { 'class': 'cbi-section' }, [
				table
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
