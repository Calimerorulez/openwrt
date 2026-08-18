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

function canonicalFQDN(v) {
        var shortName = canonicalShort(v);

        return shortName ? shortName + '.panici.casa' : '';
}

function deviceLabel(d) {
        return canonicalShort(d.canonical) ||
                (d.unifi_name && d.unifi_name !== '-' ? d.unifi_name : '') ||
                (d.suggested_name && d.suggested_name !== '-' ? d.suggested_name : '') ||
                (d.dhcp_hostname && d.dhcp_hostname !== '-' && d.dhcp_hostname !== '*' ? d.dhcp_hostname : '') ||
                d.ip ||
                d.mac ||
                '';
}

function sourceLabel(v) {
        switch (v) {
        case 'override':
                return _('Override');
        case 'fixed-config':
                return _('Fixed config');
        case 'none':
        case '':
        case '-':
                return _('None');
        default:
                return v;
        }
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
                                        canonicalFQDN(d.canonical),
                                        deviceLabel(d),
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
                                var fqdn = canonicalFQDN(d.canonical);

                                var row = E('tr', {
                                        'class': 'tr',
                                        'style': 'cursor:pointer'
                                }, [
                                        E('td', { 'class': 'td' }, display(deviceLabel(d))),
                                        E('td', { 'class': 'td' }, display(d.ip)),
                                        E('td', { 'class': 'td' }, display(fqdn)),
                                        E('td', { 'class': 'td' }, sourceLabel(d.canonical_source)),
                                        E('td', { 'class': 'td' }, display(d.unifi_name)),
                                        E('td', { 'class': 'td' }, display(d.oui)),
                                        E('td', { 'class': 'td' }, display(d.mac)),
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
                                        E('th', {
                                                'class': 'th',
                                                'title': _('Best recognizable name for this device.')
                                        }, _('Device')),
                                        E('th', { 'class': 'th' }, _('IP')),
                                        E('th', {
                                                'class': 'th',
                                                'title': _('Fully qualified local DNS name currently published under panici.casa.')
                                        }, _('FQDN')),
                                        E('th', {
                                                'class': 'th',
                                                'title': _('Origin of the local DNS name.')
                                        }, _('DNS source')),
                                        E('th', {
                                                'class': 'th',
                                                'title': _('Name stored for this client in UniFi Network.')
                                        }, _('UniFi name')),
                                        E('th', { 'class': 'th' }, _('Vendor')),
                                        E('th', { 'class': 'th' }, _('MAC')),
                                        E('th', {
                                                'class': 'th',
                                                'title': _('Locally administered does not automatically mean rotating.')
                                        }, _('MAC status'))
                                ])			]),
			tableBody
		]);

		renderTable('');

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Panici DNS Devices')),

			E('div', { 'class': 'cbi-map-descr' }, [
                                E('p', {}, [
                                        _('Panici DNS assigns stable local names under '),
                                        E('strong', {}, 'panici.casa'),
                                        _('. Device information is discovered automatically from UniFi. Click a device to assign or change its local DNS hostname.')
                                ]),

                                E('p', {}, [
                                        E('strong', {}, _('FQDN: ')),
                                        _('the complete local DNS name clients can use, for example '),
                                        E('code', {}, 'hisense-tv.panici.casa'),
                                        _('.')
                                ]),

                                E('p', {}, [
                                        E('strong', {}, _('DNS source: ')),
                                        _('Override = manually managed here; Fixed config = existing local DNS configuration; None = no local DNS name is currently assigned.')
                                ]),

                                E('p', {}, [
                                        E('strong', {}, _('Editing: ')),
                                        _('enter only the hostname, for example '),
                                        E('code', {}, 'hisense-tv'),
                                        _('. The suffix '),
                                        E('code', {}, '.panici.casa'),
                                        _(' is added automatically. A and PTR records are synchronized together.')
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
                var fqdnPreview = E('strong', {}, '');

                function updateFQDNPreview() {
                        var c = canonicalShort(canonical.value);

                        fqdnPreview.textContent = c
                                ? c + '.panici.casa'
                                : _('No manual hostname entered');
                }

                canonical.addEventListener('input', updateFQDNPreview);
                updateFQDNPreview();

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
                                        _('Enter only the hostname below. The suffix '),
                                        E('code', {}, '.panici.casa'),
                                        _(' is added automatically.')
                                ])
                        ]),

                        E('h3', {}, _('Local DNS')),
                        E('div', { 'class': 'cbi-section' }, [
                                field(_('Current FQDN'), E('strong', {},
                                        display(canonicalFQDN(device.canonical)))),
                                field(_('DNS source'), E('span', {},
                                        sourceLabel(device.canonical_source))),
                                field(_('Suggested hostname'), E('span', {},
                                        display(device.suggested_name))),
                                field(_('Custom hostname'), E('div', {}, [
                                        canonical,
                                        E('div', { 'class': 'cbi-value-description' },
                                                _('Hostname only; .panici.casa is added automatically.'))
                                ])),
                                field(_('Resulting FQDN'), fqdnPreview)
                        ]),

                        E('h3', {}, _('Device information')),
                        E('div', { 'class': 'cbi-section' }, [
                                field(_('Device'), E('span', {}, display(deviceLabel(device)))),
                                field(_('IP'), E('span', {}, display(device.ip))),
                                field(_('MAC'), E('span', {}, display(device.mac))),
                                field(_('UniFi name'), E('span', {}, display(device.unifi_name))),
                                field(_('DHCP hostname'), E('span', {}, display(device.dhcp_hostname))),
                                field(_('Vendor'), E('span', {}, display(device.oui))),
                                field(_('Fixed IP'), E('span', {}, display(device.fixed_ip))),
                                field(_('MAC type'), E('span', {}, display(device.mac_type)))
                        ]),

                        E('h3', {}, _('Local metadata')),
                        E('div', { 'class': 'cbi-map-descr' }, [
                                E('p', {}, _('Optional local information. These fields are not written back to UniFi.'))
                        ]),
                        E('div', { 'class': 'cbi-section' }, [
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
