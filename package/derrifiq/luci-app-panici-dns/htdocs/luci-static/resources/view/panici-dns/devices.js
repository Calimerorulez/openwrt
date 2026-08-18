'use strict';
'require view';
'require fs';
'require ui';

var DEVICES = '/etc/unbound/panici/devices.tsv';
var OVERRIDES = '/etc/unbound/panici/device-overrides.tsv';
var TMP = '/tmp/panici-device-overrides.tsv.new';
var APPLY = '/usr/libexec/panici-dns-apply';

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

function parseOverrides(data) {
	var rows = parseTSV(data);
	var out = {};

	rows.forEach(function(r) {
		if (!r.mac)
			return;

		out[r.mac.toLowerCase()] = {
			mac: r.mac.toLowerCase(),
			canonical: r.canonical || '',
			description: r.description || '',
			room: r.room || '',
			type: r.type || '',
			identity: r.identity || ''
		};
	});

	return out;
}

function tsvSafe(v) {
	return String(v || '')
		.replace(/\t/g, ' ')
		.replace(/\r/g, ' ')
		.replace(/\n/g, ' ')
		.trim();
}

function canonicalShort(v) {
	v = v || '';

	return v
		.replace(/\.$/, '')
		.replace(/\.panici\.casa$/i, '');
}

function display(v) {
	return v && v !== '-' ? v : '—';
}

function escapeSelector(v) {
	return String(v).replace(/["\\]/g, '\\$&');
}

function saveData(devices, overrides) {
	var rows = [
		[
			'mac',
			'canonical',
			'description',
			'room',
			'type',
			'identity'
		].join('\t')
	];

	Object.keys(overrides)
		.sort()
		.forEach(function(mac) {
			var o = overrides[mac];

			if (!o || !o.canonical)
				return;

			rows.push([
				tsvSafe(mac),
				tsvSafe(o.canonical),
				tsvSafe(o.description),
				tsvSafe(o.room),
				tsvSafe(o.type),
				tsvSafe(o.identity || o.canonical)
			].join('\t'));
		});

	return rows.join('\n') + '\n';
}

return view.extend({
	load: function() {
		return Promise.all([
			fs.read(DEVICES),
			fs.read(OVERRIDES).catch(function() { return ''; })
		]);
	},

	render: function(data) {
		var self = this;
		var devices = parseTSV(data[0]);
		var overrides = parseOverrides(data[1]);

		var filterInput = E('input', {
			'class': 'cbi-input-text',
			'type': 'text',
			'placeholder': _('Filter by name, IP, MAC, vendor or room'),
			'style': 'width: 100%; max-width: 520px'
		});

		var tableBody = E('tbody');

		function renderTable(filter) {
			var q = String(filter || '').toLowerCase();

			tableBody.innerHTML = '';

			devices.forEach(function(d) {
				var mac = (d.mac || '').toLowerCase();
				var o = overrides[mac] || {};

				var haystack = [
					d.mac,
					d.ip,
					d.unifi_name,
					d.suggested_name,
					d.canonical,
					d.oui,
					o.description,
					o.room,
					o.type,
					o.identity
				].join(' ').toLowerCase();

				if (q && haystack.indexOf(q) < 0)
					return;

				var macStatus;

				if (d.mac_type === 'locally-administered') {
					macStatus = E('span', {
						'title': _('Locally administered MAC. This can be a fixed private address, rotating private address, virtual MAC or manually assigned MAC.')
					}, [
						'⚠ ',
						_('Stability unknown')
					]);
				}
				else {
					macStatus = _('Globally administered');
				}

				var canonical = canonicalShort(d.canonical);

				var row = E('tr', {
					'class': 'tr',
					'style': 'cursor:pointer'
				}, [
					E('td', { 'class': 'td' }, display(d.mac)),
					E('td', { 'class': 'td' }, display(d.ip)),
					E('td', { 'class': 'td' }, display(d.unifi_name)),
					E('td', { 'class': 'td' }, display(d.suggested_name)),
					E('td', { 'class': 'td' }, display(canonical)),
					E('td', { 'class': 'td' }, display(d.canonical_source)),
					E('td', { 'class': 'td' }, display(d.oui)),
					E('td', { 'class': 'td' }, macStatus)
				]);

				row.addEventListener('click', function() {
					self.openEditor(d, overrides, renderTable);
				});

				tableBody.appendChild(row);
			});
		}

		filterInput.addEventListener('input', function(ev) {
			renderTable(ev.target.value);
		});

		var table = E('table', {
			'class': 'table'
		}, [
			E('thead', {}, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, _('MAC')),
					E('th', { 'class': 'th' }, _('IP')),
					E('th', {
					'class': 'th',
					'title': _('Name stored for this client in UniFi Network.')
				}, _('UniFi name')),
					E('th', {
					'class': 'th',
					'title': _('Best automatically discovered name. This is only a suggestion until it becomes canonical.')
				}, _('Suggested name')),
					E('th', {
					'class': 'th',
					'title': _('Local DNS name currently used under panici.casa.')
				}, _('Canonical')),
					E('th', {
					'class': 'th',
					'title': _('Origin of the canonical name: manual override, fixed DNS configuration, or none.')
				}, _('Source')),
					E('th', { 'class': 'th' }, _('Vendor')),
					E('th', {
					'class': 'th',
					'title': _('Whether the MAC is globally or locally administered. Locally administered does not automatically mean rotating.')
				}, _('MAC status'))
				])
			]),
			tableBody
		]);

		renderTable('');

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Panici DNS Devices')),

			E('div', { 'class': 'cbi-map-descr' }, [
				E('p', {}, [
					_('This registry combines device information discovered from UniFi with local DNS configuration on Dobby. '),
					_('Normally you do not need to change anything. Use an override only when you want a device to have a stable, recognizable local DNS name.')
				]),

				E('p', {}, [
					E('strong', {}, _('How it works: ')),
					_('Suggested name is the best automatically discovered name. '),
					_('Canonical is the name actually used for local DNS and reverse DNS (PTR). '),
					_('An override lets you explicitly choose that canonical name.')
				]),

				E('p', {}, [
					E('strong', {}, _('Example: ')),
					_('entering hisense-tv as an override creates hisense-tv.panici.casa and the corresponding PTR record.')
				]),

				E('p', {}, [
					E('strong', {}, _('MAC address note: ')),
					_('a locally administered MAC can be a fixed private address, rotating private address, virtual MAC or manually assigned MAC. '),
					_('The registry therefore reports its stability as unknown instead of assuming that it is rotating.')
				]),

				E('p', {}, [
					E('strong', {}, _('Sources: ')),
					_('override = manually managed here; fixed-config = existing static/local DNS configuration; none = no canonical DNS name is currently assigned.')
				])
			]),

			E('div', {
				'class': 'cbi-section',
				'style': 'margin-bottom:1em'
			}, [
				filterInput
			]),
			E('div', { 'class': 'cbi-section' }, [
				table
			])
		]);
	},

	openEditor: function(device, overrides, refreshTable) {
		var mac = (device.mac || '').toLowerCase();
		var existing = overrides[mac] || {};

		var canonical = E('input', {
			'class': 'cbi-input-text',
			'type': 'text',
			'value': existing.canonical || ''
		});

		var description = E('input', {
			'class': 'cbi-input-text',
			'type': 'text',
			'value': existing.description || ''
		});

		var room = E('input', {
			'class': 'cbi-input-text',
			'type': 'text',
			'value': existing.room || ''
		});

		var type = E('input', {
			'class': 'cbi-input-text',
			'type': 'text',
			'value': existing.type || ''
		});

		var identity = E('input', {
			'class': 'cbi-input-text',
			'type': 'text',
			'value': existing.identity || ''
		});

		function field(label, control) {
			return E('div', {
				'class': 'cbi-value'
			}, [
				E('label', { 'class': 'cbi-value-title' }, label),
				E('div', { 'class': 'cbi-value-field' }, control)
			]);
		}

		var warnings = [];

		if (device.mac_type === 'locally-administered') {
			warnings.push(E('div', {
				'class': 'alert-message warning'
			}, [
				_('This MAC is locally administered. Its stability cannot be inferred automatically; it may be fixed private, rotating, virtual or manually assigned.')
			]));
		}

		var body = E('div', {}, warnings.concat([
			E('div', { 'class': 'cbi-map-descr' }, [
				E('p', {}, [
					_('Current DNS canonical shows what DNS uses now. '),
					_('Override canonical is the value you manage here. Leave it empty unless you intentionally want to create or replace a manual override.')
				]),
				E('p', {}, [
					_('Description, room, type and identity are local metadata for your registry and do not come from UniFi.')
				])
			]),

			E('div', { 'class': 'cbi-section' }, [
				field(_('MAC'), E('span', {}, display(device.mac))),
				field(_('IP'), E('span', {}, display(device.ip))),
				field(_('UniFi name'), E('span', {}, display(device.unifi_name))),
				field(_('DHCP hostname'), E('span', {}, display(device.dhcp_hostname))),
				field(_('Vendor'), E('span', {}, display(device.oui))),
				field(_('Fixed IP'), E('span', {}, display(device.fixed_ip))),
				field(_('MAC type'), E('span', {}, display(device.mac_type))),
				field(_('Current DNS canonical'), E('span', {},
					display(canonicalShort(device.canonical)))),
				field(_('Canonical source'), E('span', {},
					display(device.canonical_source))),
				field(_('Suggested name'), E('span', {},
					display(device.suggested_name))),
				field(_('Override canonical'), canonical),
				field(_('Description'), description),
				field(_('Room'), room),
				field(_('Type'), type),
				field(_('Identity'), identity)
			])
		]));

		var buttons = [
			E('button', {
				'class': 'btn',
				'click': ui.createHandlerFn(this, function() {
					ui.hideModal();
				})
			}, _('Cancel'))
		];

		if (existing.canonical) {
			buttons.push(E('button', {
				'class': 'btn cbi-button-negative',
				'click': ui.createHandlerFn(this, function() {
					delete overrides[mac];
					return this.writeAndApply(overrides).then(function() {
						refreshTable('');
						ui.hideModal();
						ui.addNotification(null,
							E('p', {}, _('Override removed and DNS synchronized.')));
					});
				})
			}, _('Remove override')));
		}

		buttons.push(E('button', {
			'class': 'btn cbi-button-positive important',
			'click': ui.createHandlerFn(this, function() {
				var c = canonicalShort(canonical.value);

				if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(c)) {
					ui.addNotification(null,
						E('p', {}, _('Invalid canonical hostname.')),
						'error');
					return;
				}

				overrides[mac] = {
					mac: mac,
					canonical: c,
					description: tsvSafe(description.value),
					room: tsvSafe(room.value),
					type: tsvSafe(type.value),
					identity: tsvSafe(identity.value || c)
				};

				return this.writeAndApply(overrides).then(function() {
					refreshTable('');
					ui.hideModal();
					ui.addNotification(null,
						E('p', {}, _('Override saved and DNS synchronized.')));
				});
			})
		}, _('Save & Apply')));

		ui.showModal(
			_('Panici DNS device') + ' — ' + display(device.ip),
			[
				body,
				E('div', {
					'class': 'right',
					'style': 'margin-top:1em'
				}, buttons)
			]
		);
	},

	writeAndApply: function(overrides) {
		var payload = saveData(null, overrides);

		return fs.write(TMP, payload)
			.then(function() {
				return fs.exec(APPLY, []);
			})
			.then(function(res) {
				if (!res || res.code !== 0) {
					var msg = res && (res.stderr || res.stdout)
						? (res.stderr || res.stdout)
						: _('Unknown apply error');

					throw new Error(msg);
				}
			})
			.catch(function(err) {
				ui.addNotification(null,
					E('p', {}, _('Could not apply override: ') + err.message),
					'error');

				throw err;
			});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
