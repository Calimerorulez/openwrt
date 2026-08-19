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
			identity: r.identity || '',
			lifecycle: r.lifecycle || 'active'
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
        v = (v || '').trim();

        if (!v || v === '-')
                return '';

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
                (d.suggested_name && d.suggested_name !== '-' ? d.suggested_name : '') ||
                (d.unifi_name && d.unifi_name !== '-' ? d.unifi_name : '') ||
                (d.dhcp_hostname && d.dhcp_hostname !== '-' && d.dhcp_hostname !== '*' ? d.dhcp_hostname : '') ||
                d.ip ||
                d.mac ||
                '';
}

function sourceLabel(v, device) {
        if (device && device.lifecycle === 'retired')
                return _('Verouderd');

        if (device && device.canonical_conflict)
                return _('Conflict');

        switch (v) {
        case 'override':
                return _('Handmatig');
        case 'fixed-config':
                return _('Vaste configuratie');
        case 'automatic':
                return _('Automatisch');
        case 'none':
        case '':
        case '-':
                return _('Geen');
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
			'identity',
			'lifecycle'
		].join('\t')
	];

	Object.keys(overrides)
		.sort()
		.forEach(function(mac) {
			var o = overrides[mac];

			if (!o)
				return;

			var lifecycle = o.lifecycle || 'active';

			if (!o.canonical && lifecycle !== 'retired')
				return;

			rows.push([
				tsvSafe(mac),
				tsvSafe(o.canonical),
				tsvSafe(o.description),
				tsvSafe(o.room),
				tsvSafe(o.type),
				tsvSafe(o.identity || o.canonical),
				tsvSafe(o.lifecycle || 'active')
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
                devices.forEach(function(d) {
                        var identity = String(d.identity || '').trim();

                        if (!identity) {
                                d._identity_interfaces = '';
                                return;
                        }

                        d._identity_interfaces = devices
                                .filter(function(x) {
                                        return String(x.identity || '').trim() === identity;
                                })
                                .sort(function(a, b) {
                                        return String(a.ip || '').localeCompare(
                                                String(b.ip || ''),
                                                undefined,
                                                { numeric: true }
                                        );
                                })
                                .map(function(x) {
                                        return (x.ip || '—') + ' / ' + (x.mac || '—');
                                })
                                .join('; ');

                        /*
                         * Alleen als deze identity werkelijk meerdere
                         * interfaces bevat, tonen we de groepsweergave.
                         */
                        if (d._identity_interfaces.indexOf('; ') < 0)
                                d._identity_interfaces = '';
                });


		var filterInput = E('input', {
			'class': 'cbi-input-text',
			'type': 'text',
			'placeholder': _('Filter op naam, IP, MAC, fabrikant of ruimte'),
			'style': 'width: 100%; max-width: 520px'
		});

                var tableBody = E('tbody');
                var sortKey = 'device';
                var sortDir = 1;
                var sortHeaders = {};

                function cleanSortValue(v) {
                        v = String(v || '').trim();

                        if (!v || v === '-' || v === '—' || v === '*')
                                return '';

                        return v;
                }

                function ipv4SortValue(v) {
                        v = cleanSortValue(v);

                        if (!v)
                                return '';

                        if (/^\d+\.\d+\.\d+\.\d+$/.test(v)) {
                                return v.split('.').map(function(part) {
                                        return ('000' + Number(part)).slice(-3);
                                }).join('.');
                        }

                        return v.toLowerCase();
                }

                function getSortValue(d, key) {
                        switch (key) {
                        case 'device':
                                return cleanSortValue(
                                        canonicalShort(d.canonical) ||
                                        (d.suggested_name && d.suggested_name !== '-' ? d.suggested_name : '') ||
                                        (d.unifi_name && d.unifi_name !== '-' ? d.unifi_name : '') ||
                                        (d.dhcp_hostname && d.dhcp_hostname !== '-' && d.dhcp_hostname !== '*' ? d.dhcp_hostname : '')
                                );
                        case 'ip':
                                return ipv4SortValue(d.ip);
                        case 'fqdn':
                                return cleanSortValue(
                                        canonicalFQDN(d.canonical) ||
                                        d.canonical_conflict
                                );
                        case 'source':
                                return cleanSortValue(sourceLabel(d.canonical_source, d));
                        case 'unifi':
                                return cleanSortValue(d.unifi_name);
                        case 'vendor':
                                return cleanSortValue(d.oui);
                        case 'mac':
                                return cleanSortValue(d.mac);
                        case 'macstatus':
                                if (d.mac_type === 'locally-administered')
                                        return _('Lokaal beheerd');
                                if (d.mac_type === 'globally-administered')
                                        return _('Globaal toegewezen');
                                return cleanSortValue(d.mac_type);
                        default:
                                return '';
                        }
                }

                function compareDevices(a, b) {
                        var av = getSortValue(a, sortKey);
                        var bv = getSortValue(b, sortKey);

                        /* Onbekende/lege waarden altijd onderaan. */
                        if (!av && !bv)
                                return 0;
                        if (!av)
                                return 1;
                        if (!bv)
                                return -1;

                        var result = String(av).localeCompare(String(bv), 'nl', {
                                numeric: true,
                                sensitivity: 'base'
                        });

                        return result * sortDir;
                }

                function updateSortHeaders() {
                        Object.keys(sortHeaders).forEach(function(key) {
                                sortHeaders[key].textContent =
                                        key === sortKey
                                                ? (sortDir > 0 ? ' ▲' : ' ▼')
                                                : '';
                        });
                }

                function makeSortHeader(label, key, title) {
                        var indicator = E('span', {}, '');

                        sortHeaders[key] = indicator;

                        var th = E('th', {
                                'class': 'th',
                                'style': 'cursor:pointer; user-select:none',
                                'title': title
                        }, [
                                label,
                                indicator
                        ]);

                        th.addEventListener('click', function(ev) {
                                ev.stopPropagation();

                                if (sortKey === key)
                                        sortDir = -sortDir;
                                else {
                                        sortKey = key;
                                        sortDir = 1;
                                }

                                updateSortHeaders();
                                renderTable(filterInput.value);
                        });

                        return th;
                }

                function renderTable(filter) {
                        var q = String(filter || '').toLowerCase();

                        tableBody.innerHTML = '';

                        var visible = devices.filter(function(d) {
                                var mac = (d.mac || '').toLowerCase();
                                var o = overrides[mac] || {};

                                var haystack = [
                                        d.mac,
                                        d.ip,
                                        d.unifi_name,
                                        d.suggested_name,
                                        d.canonical,
                                        canonicalFQDN(d.canonical),
                                        d.canonical_conflict,
                                        d.canonical_conflict_with,
                                        deviceLabel(d),
                                        d.oui,
                                        o.description,
                                        o.room,
                                        o.type,
                                        o.identity,
                                        d.lifecycle,
                                        o.lifecycle
                                ].join(' ').toLowerCase();

                                return !q || haystack.indexOf(q) >= 0;
                        });

                        visible.sort(compareDevices);

                        visible.forEach(function(d) {
                                var macStatus;

                                if (d.mac_type === 'locally-administered') {
                                        macStatus = E('span', {
                                                'title': _('Lokaal beheerd MAC-adres. Dit kan een vast privé-adres, wisselend privé-adres, virtueel MAC-adres of handmatig ingesteld MAC-adres zijn.')
                                        }, [
                                                '⚠ ',
                                                _('Stabiliteit onbekend')
                                        ]);
                                }
                                else if (d.mac_type === 'globally-administered') {
                                        macStatus = _('Globaal toegewezen');
                                }
                                else {
                                        macStatus = display(d.mac_type);
                                }

                                var fqdn = canonicalFQDN(d.canonical);
                                var fqdnCell;

                                if (d.canonical_conflict) {
                                        fqdnCell = E('span', {
                                                'title': _('Naamconflict met: ') +
                                                        display(d.canonical_conflict_with)
                                        }, [
                                                '⚠ ',
                                                d.canonical_conflict
                                        ]);
                                }
                                else {
                                        fqdnCell = display(fqdn);
                                }

                                var row = E('tr', {
                                        'class': 'tr',
                                        'style': 'cursor:pointer'
                                }, [
                                        E('td', { 'class': 'td' }, display(deviceLabel(d))),
                                        E('td', { 'class': 'td' }, display(d.ip)),
                                        E('td', { 'class': 'td' }, fqdnCell),
                                        E('td', { 'class': 'td' }, sourceLabel(d.canonical_source, d)),
                                        E('td', { 'class': 'td' }, display(d.unifi_name)),
                                        E('td', { 'class': 'td' }, display(d.oui)),
                                        E('td', { 'class': 'td' }, display(d.mac)),
                                        E('td', { 'class': 'td' }, macStatus)
                                ]);

                                row.addEventListener('click', function() {
                                        self.openEditor(
                                                d,
                                                overrides,
                                                renderTable,
                                                d._identity_interfaces || ''
                                        );
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
                                        makeSortHeader(
                                                _('Apparaat'),
                                                'device',
                                                _('Best herkenbare naam voor dit apparaat. Klik om te sorteren.')
                                        ),
                                        makeSortHeader(
                                                _('IP'),
                                                'ip',
                                                _('Klik om numeriek op IP-adres te sorteren.')
                                        ),
                                        makeSortHeader(
                                                _('FQDN'),
                                                'fqdn',
                                                _('Volledige lokale DNS-naam. Klik om te sorteren.')
                                        ),
                                        makeSortHeader(
                                                _('DNS-bron'),
                                                'source',
                                                _('Herkomst van de lokale DNS-naam. Klik om te sorteren.')
                                        ),
                                        makeSortHeader(
                                                _('UniFi-naam'),
                                                'unifi',
                                                _('Naam uit UniFi Network. Klik om te sorteren.')
                                        ),
                                        makeSortHeader(
                                                _('Fabrikant'),
                                                'vendor',
                                                _('Klik om op fabrikant te sorteren.')
                                        ),
                                        makeSortHeader(
                                                _('MAC'),
                                                'mac',
                                                _('Klik om op MAC-adres te sorteren.')
                                        ),
                                        makeSortHeader(
                                                _('MAC-status'),
                                                'macstatus',
                                                _('Klik om op MAC-status te sorteren.')
                                        )
                                ])
                        ]),
                        tableBody
                ]);

                updateSortHeaders();
                renderTable('');

		return E('div', { 'class': 'cbi-map' }, [
			E('h2', {}, _('Panici DNS-apparaten')),

			E('div', { 'class': 'cbi-map-descr' }, [
                                E('p', {}, [
                                        _('Panici DNS kent apparaten stabiele lokale namen toe binnen '),
                                        E('strong', {}, 'panici.casa'),
                                        _('. Apparaatgegevens worden automatisch uit UniFi opgehaald. Klik op een apparaat om de lokale DNS-naam of aanvullende gegevens te wijzigen.')
                                ]),

                                E('p', {}, [
                                        E('strong', {}, _('FQDN: ')),
                                        _('de volledige lokale DNS-naam die clients kunnen gebruiken, bijvoorbeeld '),
                                        E('code', {}, 'hisense-tv.panici.casa'),
                                        _('.')
                                ]),

                                E('p', {}, [
                                        E('strong', {}, _('DNS-bron: ')),
                                        _('Automatisch = Panici DNS heeft een geldige unieke voorgestelde naam toegewezen; Handmatig = hier ingesteld; Vaste configuratie = afkomstig uit bestaande lokale DNS-configuratie; Geen = er is momenteel geen lokale DNS-naam.')
                                ]),

                                E('p', {}, [
                                        E('strong', {}, _('Bewerken: ')),
                                        _('vul alleen de hostnaam in, bijvoorbeeld '),
                                        E('code', {}, 'hisense-tv'),
                                        _('. Het achtervoegsel '),
                                        E('code', {}, '.panici.casa'),
                                        _(' wordt automatisch toegevoegd. Het A- en PTR-record worden samen bijgewerkt.')
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

	openEditor: function(device, overrides, refreshTable, identityInterfaceList) {
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

		var currentLifecycle =
			existing.lifecycle ||
			device.lifecycle ||
			'active';

		var lifecycle = E('select', {
			'class': 'cbi-input-select'
		}, [
			E('option', {
				'value': 'active'
			}, _('Actief / behouden')),
			E('option', {
				'value': 'retired'
			}, _('Verouderd / vervangen'))
		]);

		lifecycle.value =
			currentLifecycle === 'retired'
				? 'retired'
				: 'active';
                var fqdnPreview = E('strong', {}, '');

                function updateFQDNPreview() {
                        var c = canonicalShort(canonical.value);
                        var current = canonicalFQDN(device.canonical);

                        if (c) {
                                fqdnPreview.textContent = c + '.panici.casa';
                        }
                        else if (current) {
                                fqdnPreview.textContent =
                                        current + ' (' + _('geen wijziging') + ')';
                        }
                        else if (device.canonical_conflict) {
                                fqdnPreview.textContent =
                                        '⚠ ' + device.canonical_conflict +
                                        ' — ' + _('naamconflict');
                        }
                        else {
                                fqdnPreview.textContent = _('Geen DNS-naam');
                        }
                }

                canonical.addEventListener('input', updateFQDNPreview);
                updateFQDNPreview();

		function field(label, control, description) {
			return E('div', {
				'class': 'cbi-value'
			}, [
				E('label', { 'class': 'cbi-value-title' }, label),
				E('div', { 'class': 'cbi-value-field' }, [
					control,
					description
						? E('div', {
							'class': 'cbi-value-description'
						}, description)
						: ''
				])
			]);
		}

		var warnings = [];

		if (device.mac_type === 'locally-administered') {
			warnings.push(E('div', {
				'class': 'alert-message warning'
			}, [
				_('Dit MAC-adres wordt lokaal beheerd. De stabiliteit kan niet automatisch worden bepaald; het kan een vast privé-adres, wisselend privé-adres, virtueel MAC-adres of handmatig ingesteld MAC-adres zijn.')
			]));
		}

                if (device.canonical_conflict) {
                        warnings.push(E('div', {
                                'class': 'alert-message warning'
                        }, [
                                E('strong', {}, _('DNS-naamconflict: ')),
                                device.canonical_conflict,
                                E('br'),
                                _('Deze naam wordt niet automatisch gepubliceerd. Conflicterende apparaten: '),
                                E('code', {}, display(device.canonical_conflict_with)),
                                E('br'),
                                _('Kies hieronder desgewenst een unieke aangepaste hostnaam.')
                        ]));
                }

		var body = E('div', {}, warnings.concat([
                        E('div', { 'class': 'cbi-map-descr' }, [
                                E('p', {}, [
                                        _('Vul hieronder alleen de hostnaam in. Het achtervoegsel '),
                                        E('code', {}, '.panici.casa'),
                                        _(' wordt automatisch toegevoegd.')
                                ])
                        ]),

                        E('h3', {}, _('Lokale DNS')),
                        E('div', { 'class': 'cbi-section' }, [
                                field(_('Huidige FQDN'), E('strong', {},
                                        display(canonicalFQDN(device.canonical)))),
                                field(_('DNS-bron'), E('span', {},
                                        sourceLabel(device.canonical_source, device))),
                                field(_('Voorgestelde hostnaam'), E('span', {},
                                        display(device.suggested_name))),
                                field(_('Aangepaste hostnaam'), E('div', {}, [
                                        canonical,
                                        E('div', { 'class': 'cbi-value-description' },
                                                _('Alleen de hostnaam; .panici.casa wordt automatisch toegevoegd.'))
                                ])),
                                field(_('Resulterende FQDN'), fqdnPreview)
                        ]),

                        E('h3', {}, _('Apparaatgegevens')),
                        E('div', { 'class': 'cbi-section' }, [
                                field(_('Apparaat'), E('span', {}, display(deviceLabel(device)))),
                                field(_('IP'), E('span', {}, display(device.ip))),
                                field(_('MAC'), E('span', {}, display(device.mac))),
                                field(_('UniFi-naam'), E('span', {}, display(device.unifi_name))),
                                field(_('DHCP-hostnaam'), E('span', {}, display(device.dhcp_hostname))),
                                field(_('Fabrikant'), E('span', {}, display(device.oui))),
                                field(_('Vast IP-adres'), E('span', {}, display(device.fixed_ip))),
                                field(_('MAC-type'), E('span', {}, device.mac_type === 'locally-administered'
                                                ? _('Lokaal beheerd')
                                                : device.mac_type === 'globally-administered'
                                                        ? _('Globaal toegewezen')
                                                        : display(device.mac_type)))
                        ]),

                        E('h3', {}, _('Lokale metadata')),
                                device.identity
                                        ? field(_('Identiteit'), E('strong', {},
                                                display(device.identity)))
                                        : '',
                                device.identity_warning
                                        ? field(_('Waarschuwing'), E('span', {
                                                'style': 'font-weight:bold'
                                        }, display(device.identity_warning)))
                                        : '',
                                identityInterfaceList
                                        ? field(_('Interfaces in deze identiteit'), E('div', {},
                                                identityInterfaceList
                                                        .split('; ')
                                                        .map(function(v) {
                                                                return E('div', {
                                                                        'style': 'font-family:monospace'
                                                                }, v);
                                                        })
                                        ))
                                        : '',

                        E('div', { 'class': 'cbi-map-descr' }, [
                                E('p', {}, _('Optionele lokale informatie. Deze velden worden niet teruggeschreven naar UniFi.'))
                        ]),
                        E('div', { 'class': 'cbi-section' }, [
                                field(_('Beschrijving'), description),
                                field(_('Ruimte'), room),
                                field(_('Type'), type),
                                field(_('Aangepaste identiteit'), identity),
                                field(
                                        _('Lifecycle'),
                                        lifecycle,
                                        _('Offline betekent niet automatisch verouderd. Markeer alleen vervangen of definitief verwijderde hardware als verouderd.')
                                )
                        ])
                ]));

		var buttons = [
			E('button', {
				'class': 'btn',
				'click': ui.createHandlerFn(this, function() {
					ui.hideModal();
				})
			}, _('Annuleren'))
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
							E('p', {}, _('Handmatige instelling verwijderd en DNS gesynchroniseerd.')));
					});
				})
			}, _('Handmatige instelling verwijderen')));
		}

		buttons.push(E('button', {
			'class': 'btn cbi-button-positive important',
			'click': ui.createHandlerFn(this, function() {
				var c = canonicalShort(canonical.value);

				if (c && !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(c)) {
					ui.addNotification(null,
						E('p', {}, _('Ongeldige hostnaam.')),
						'error');
					return;
				}

				overrides[mac] = {
					mac: mac,
					canonical: c,
					description: tsvSafe(description.value),
					room: tsvSafe(room.value),
					type: tsvSafe(type.value),
					identity: tsvSafe(identity.value || c),
					lifecycle: lifecycle.value === 'retired' ? 'retired' : 'active'
				};

				return this.writeAndApply(overrides).then(function() {
					refreshTable('');
					ui.hideModal();
					ui.addNotification(null,
						E('p', {}, _('Handmatige instelling opgeslagen en DNS gesynchroniseerd.')));
				});
			})
		}, _('Opslaan & toepassen')));

		ui.showModal(
			_('Panici DNS-apparaat') + ' — ' + display(device.ip),
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
						: _('Onbekende fout bij toepassen');

					throw new Error(msg);
				}
			})
			.catch(function(err) {
				ui.addNotification(null,
					E('p', {}, _('Handmatige instelling kon niet worden toegepast: ') + err.message),
					'error');

				throw err;
			});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
