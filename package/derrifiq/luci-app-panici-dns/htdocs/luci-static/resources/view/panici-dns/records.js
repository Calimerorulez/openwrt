'use strict';
'require view';
'require fs';
'require ui';

var DOMAIN = 'panici.casa';

var MANAGED_RECORDS = '/etc/panici-dns/managed-records.tsv';
var MANAGED_TMP = '/tmp/panici-managed-records.tsv.new';
var MANAGED_APPLY = '/usr/libexec/panici-managed-dns-apply';

var SOURCES = [
	{
		label: 'Statisch',
		path: '/etc/unbound/panici/static.conf'
	},
	{
		label: 'IoT',
		path: '/etc/unbound/panici/iot.conf'
	},
	{
		label: 'Proxmox LXC',
		path: '/etc/unbound/panici/lxc.conf'
	},
	{
		label: 'UniFi DHCP',
		path: '/etc/unbound/panici/dhcp.conf'
	},
	{
		label: 'PTR-generator',
		path: '/etc/unbound/panici/ptr-static.conf'
	},
	{
		label: 'Beheerd',
		path: '/etc/unbound/panici/managed.conf',
		optional: true
	}
];

function cleanName(value) {
	return String(value || '')
		.trim()
		.replace(/\.$/, '');
}

function shortName(value) {
	var name = cleanName(value).toLowerCase();
	var suffix = '.' + DOMAIN;

	if (name.slice(-suffix.length) === suffix)
		name = name.slice(0, -suffix.length);

	return name;
}

function fqdn(value) {
	return shortName(value) + '.' + DOMAIN;
}

function ipParts(value) {
	return String(value || '').split('.').map(function(v) {
		return parseInt(v, 10) || 0;
	});
}

function compareIP(a, b) {
	var aa = ipParts(a);
	var bb = ipParts(b);
	var n = Math.max(aa.length, bb.length);

	for (var i = 0; i < n; i++) {
		var av = aa[i] || 0;
		var bv = bb[i] || 0;

		if (av < bv)
			return -1;

		if (av > bv)
			return 1;
	}

	return 0;
}

function validIPv4(value) {
	var s = String(value || '').trim();

	if (!/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(s))
		return false;

	var p = s.split('.');

	if (p.length !== 4)
		return false;

	for (var i = 0; i < 4; i++) {
		if (p[i] === '' || !/^[0-9]+$/.test(p[i]))
			return false;

		var n = Number(p[i]);

		if (n < 0 || n > 255)
			return false;
	}

	return true;
}

function validHostname(value) {
	var s = shortName(value);

	return (
		s.length > 0 &&
		s.length <= 63 &&
		/^[a-z0-9][a-z0-9-]*$/.test(s)
	);
}

function parseManagedRecords(data) {
	var rows = [];
	var lines = String(data || '').split(/\r?\n/);

	if (!lines.length)
		return rows;

	var header = lines[0].split('\t');
	var columns = {};

	header.forEach(function(name, index) {
		columns[name] = index;
	});

	var required = [
		'id',
		'enabled',
		'type',
		'name',
		'value',
		'ptr',
		'description'
	];

	for (var r = 0; r < required.length; r++) {
		if (columns[required[r]] == null)
			return rows;
	}

	lines.slice(1).forEach(function(line) {
		if (!line.trim())
			return;

		var f = line.split('\t');

		rows.push({
			id: f[columns.id] || '',
			enabled: (f[columns.enabled] || '').toLowerCase() === 'true',
			type: (f[columns.type] || '').toUpperCase(),
			name: shortName(f[columns.name] || ''),
			value: f[columns.value] || '',
			ptr: (f[columns.ptr] || '').toLowerCase() === 'true',
			description: f.slice(columns.description).join('\t') || ''
		});
	});

	return rows;
}

function sanitizeDescription(value) {
	return String(value || '')
		.replace(/[\t\r\n]+/g, ' ')
		.trim();
}

function serializeManagedRecords(rows) {
	var lines = [
		'id\tenabled\ttype\tname\tvalue\tptr\tdescription'
	];

	rows.forEach(function(r) {
		lines.push([
			r.id,
			r.enabled ? 'true' : 'false',
			String(r.type || 'A').toUpperCase(),
			shortName(r.name),
			String(r.value || '').trim(),
			r.ptr ? 'true' : 'false',
			sanitizeDescription(r.description)
		].join('\t'));
	});

	return lines.join('\n') + '\n';
}

function generateId(rows) {
	var used = {};

	rows.forEach(function(r) {
		used[r.id] = true;
	});

	var base = 'dns-' + Date.now().toString(36);
	var id = base;
	var n = 1;

	while (used[id])
		id = base + '-' + (n++);

	return id;
}

function parseConfig(data, source, path) {
	var records = [];

	String(data || '').split(/\n/).forEach(function(line) {
		var m;

		m = line.match(
			/^\s*local-data:\s*["']([^"' ]+)\s+A\s+([0-9.]+)["']\s*$/
		);

		if (m) {
			records.push({
				type: 'A',
				hostname: cleanName(m[1]),
				ip: m[2],
				ptr: '',
				source: source,
				file: path
			});

			return;
		}

		m = line.match(
			/^\s*local-data-ptr:\s*["']([0-9.]+)\s+([^"']+)["']\s*$/
		);

		if (m) {
			records.push({
				type: 'PTR',
				hostname: '',
				ip: m[1],
				ptr: cleanName(m[2]),
				source: source,
				file: path
			});
		}
	});

	return records;
}

function uniqueRecords(records) {
	var out = [];
	var seen = {};

	records.forEach(function(r) {
		var key = [
			r.type,
			r.hostname,
			r.ip,
			r.ptr
		].join('\t');

		if (seen[key]) {
			var existing = seen[key];

			if (existing.source.indexOf(r.source) < 0)
				existing.source += ' + ' + r.source;

			if (existing.file.indexOf(r.file) < 0)
				existing.file += ', ' + r.file;

			return;
		}

		var copy = {
			type: r.type,
			hostname: r.hostname,
			ip: r.ip,
			ptr: r.ptr,
			source: r.source,
			file: r.file
		};

		seen[key] = copy;
		out.push(copy);
	});

	return out;
}

function text(value) {
	return value === undefined || value === null || value === ''
		? '—'
		: String(value);
}

function field(label, control, description) {
	return E('div', { 'class': 'cbi-value' }, [
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

return view.extend({
	load: function() {
		return Promise.all([
			Promise.all(SOURCES.map(function(source) {
				return fs.read(source.path)
					.then(function(data) {
						return {
							source: source,
							data: data || '',
							available: true
						};
					})
					.catch(function() {
						return {
							source: source,
							data: '',
							available: false
						};
					});
			})),

			fs.read(MANAGED_RECORDS).catch(function() {
				return 'id\tenabled\ttype\tname\tvalue\tptr\tdescription\n';
			})
		]);
	},

	render: function(data) {
		var sourceData = data[0];
		var managedRecords = parseManagedRecords(data[1]);
		var effectiveRecords = [];
		var missing = [];

		sourceData.forEach(function(item) {
			if (!item.available) {
				if (!item.source.optional)
					missing.push(item.source.path);

				return;
			}

			effectiveRecords = effectiveRecords.concat(
				parseConfig(
					item.data,
					item.source.label,
					item.source.path
				)
			);
		});

		effectiveRecords = uniqueRecords(effectiveRecords);

		var forwards = effectiveRecords.filter(function(r) {
			return r.type === 'A';
		});

		var ptrs = effectiveRecords.filter(function(r) {
			return r.type === 'PTR';
		});

		managedRecords.sort(function(a, b) {
			var x = fqdn(a.name).localeCompare(
				fqdn(b.name),
				undefined,
				{ sensitivity: 'base' }
			);

			if (x)
				return x;

			return compareIP(a.value, b.value);
		});

		forwards.sort(function(a, b) {
			var x = a.hostname.localeCompare(
				b.hostname,
				undefined,
				{ sensitivity: 'base' }
			);

			if (x)
				return x;

			return compareIP(a.ip, b.ip);
		});

		ptrs.sort(function(a, b) {
			return compareIP(a.ip, b.ip);
		});

		function findExternalPtr(ip, ignoreManagedId) {
			var owner = null;

			ptrs.some(function(r) {
				if (r.ip !== ip)
					return false;

				/*
				 * managed.conf is desired/effective output van dezelfde
				 * managed database. Bij het bewerken van een bestaand
				 * managed record mag zijn eigen huidige PTR dus niet als
				 * extern conflict worden beschouwd.
				 */
				if (r.source.indexOf('Beheerd') >= 0 && ignoreManagedId)
					return false;

				owner = r;
				return true;
			});

			return owner;
		}

		function findManagedPtrOwner(ip, ignoreId) {
			for (var i = 0; i < managedRecords.length; i++) {
				var r = managedRecords[i];

				if (!r.enabled || !r.ptr)
					continue;

				if (r.id === ignoreId)
					continue;

				if (r.value === ip)
					return r;
			}

			return null;
		}

		function validateManagedRecord(record, existingId) {
			if (!validHostname(record.name))
				return _('Ongeldige hostnaam.');

			if (!validIPv4(record.value))
				return _('Ongeldig IPv4-adres.');

			for (var i = 0; i < managedRecords.length; i++) {
				var r = managedRecords[i];

				if (r.id === existingId)
					continue;

				if (
					shortName(r.name) === shortName(record.name) &&
					r.value === record.value
				)
					return _('Dit beheerde A-record bestaat al.');
			}

			if (record.enabled && record.ptr) {
				var managedOwner = findManagedPtrOwner(
					record.value,
					existingId
				);

				if (managedOwner) {
					return (
						_('Dit IP-adres heeft al een beheerde PTR-eigenaar: ') +
						fqdn(managedOwner.name)
					);
				}

				var externalOwner = findExternalPtr(
					record.value,
					existingId
				);

				if (externalOwner) {
					return (
						_('Dit IP-adres heeft al reverse DNS: ') +
						externalOwner.ptr
					);
				}
			}

			return null;
		}

		function applyManagedRows(rows, successMessage) {
			return fs.write(
				MANAGED_TMP,
				serializeManagedRecords(rows)
			).then(function() {
				return fs.exec(MANAGED_APPLY, []);
			}).then(function(res) {
				if (res.code !== 0) {
					throw new Error(
						(res.stderr ||
						 res.stdout ||
						 'DNS apply mislukt').trim()
					);
				}

				ui.addNotification(
					null,
					E('p', {}, successMessage),
					'info'
				);

				window.setTimeout(function() {
					window.location.reload();
				}, 1500);
			}).catch(function(err) {
				ui.addNotification(
					null,
					E('p', {}, [
						E('strong', {}, _('Opslaan mislukt: ')),
						String(
							err && err.message
								? err.message
								: err
						)
					]),
					'error'
				);
			});
		}

		function openManagedEditor(existing) {
			var hostInput = E('input', {
				'class': 'cbi-input-text',
				'type': 'text',
				'value': existing ? existing.name : '',
				'placeholder': 'printer'
			});

			var ipInput = E('input', {
				'class': 'cbi-input-text',
				'type': 'text',
				'value': existing ? existing.value : '',
				'placeholder': '10.0.5.123'
			});

			var enabledInput = E('input', {
				'type': 'checkbox'
			});

			enabledInput.checked = existing
				? existing.enabled
				: true;

			var ptrInput = E('input', {
				'type': 'checkbox'
			});

			ptrInput.checked = existing
				? existing.ptr
				: false;

			var descriptionInput = E('input', {
				'class': 'cbi-input-text',
				'type': 'text',
				'value': existing
					? existing.description || ''
					: '',
				'placeholder': _('Optionele beschrijving')
			});

			var ptrInfo = E('div', {
				'class': 'cbi-value-description',
				'style': 'margin-top:.5em'
			});

			function updatePtrInfo() {
				var ip = String(ipInput.value || '').trim();

				ptrInfo.innerHTML = '';

				if (!validIPv4(ip)) {
					ptrInput.disabled = false;
					return;
				}

				var managedOwner = findManagedPtrOwner(
					ip,
					existing ? existing.id : null
				);

				if (managedOwner) {
					ptrInput.checked = false;
					ptrInput.disabled = true;
					ptrInfo.appendChild(
						E('span', {
							'class': 'alert-message warning'
						}, _(
							'Dit IP heeft al een beheerde PTR: '
						) + fqdn(managedOwner.name))
					);
					return;
				}

				var externalOwner = findExternalPtr(
					ip,
					existing ? existing.id : null
				);

				if (externalOwner) {
					ptrInput.checked = false;
					ptrInput.disabled = true;
					ptrInfo.appendChild(
						E('span', {
							'class': 'alert-message warning'
						}, _(
							'Bestaande reverse DNS: '
						) + externalOwner.ptr)
					);
					return;
				}

				ptrInput.disabled = false;
				ptrInfo.appendChild(
					E('span', {}, _(
						'Voor dit IP is geen andere PTR-eigenaar gevonden.'
					))
				);
			}

			ipInput.addEventListener('input', updatePtrInfo);

			ui.showModal(
				existing
					? _('Beheerd DNS-record bewerken')
					: _('Beheerd DNS-record toevoegen'),
				[
					E('div', { 'class': 'cbi-section' }, [
						field(
							_('Recordtype'),
							E('strong', {}, 'A'),
							_('Andere recordtypen worden later toegevoegd.')
						),
						field(
							_('Naam'),
							hostInput,
							_('.panici.casa wordt automatisch toegevoegd.')
						),
						field(_('IPv4-adres'), ipInput),
						field(
							_('Ingeschakeld'),
							enabledInput,
							_(
								'Uitgeschakelde records blijven bewaard, ' +
								'maar worden niet aan Unbound gepubliceerd.'
							)
						),
						field(
							_('PTR-record aanmaken'),
							E('div', {}, [
								ptrInput,
								ptrInfo
							]),
							_(
								'Per IP-adres kan Panici DNS slechts één ' +
								'PTR-eigenaar beheren.'
							)
						),
						field(
							_('Beschrijving'),
							descriptionInput
						)
					]),

					E('div', { 'class': 'right' }, [
						E('button', {
							'class': 'btn',
							'click': ui.hideModal
						}, _('Annuleren')),
						' ',
						E('button', {
							'class':
								'btn cbi-button-positive important',
							'click': function() {
								var record = {
									id: existing
										? existing.id
										: generateId(managedRecords),
									enabled: enabledInput.checked,
									type: 'A',
									name: shortName(hostInput.value),
									value:
										String(ipInput.value || '').trim(),
									ptr:
										ptrInput.checked &&
										!ptrInput.disabled,
									description:
										sanitizeDescription(
											descriptionInput.value
										)
								};

								var error = validateManagedRecord(
									record,
									existing ? existing.id : null
								);

								if (error) {
									ui.addNotification(
										null,
										E('p', {}, error),
										'error'
									);
									return;
								}

								var rows = managedRecords.filter(
									function(r) {
										return !existing ||
											r.id !== existing.id;
									}
								);

								rows.push(record);

								ui.hideModal();

								applyManagedRows(
									rows,
									existing
										? _('DNS-record is bijgewerkt.')
										: _('DNS-record is toegevoegd.')
								);
							}
						}, _('Opslaan & toepassen'))
					])
				]
			);

			updatePtrInfo();
		}

		function deleteManagedRecord(record) {
			ui.showModal(_('Beheerd DNS-record verwijderen'), [
				E('p', {}, [
					_('Weet je zeker dat je dit DNS-record wilt verwijderen?'),
					E('br'),
					E('strong', {},
						fqdn(record.name) +
						' → ' +
						record.value)
				]),

				record.ptr
					? E('p', {}, _(
						'De door dit record beheerde PTR wordt eveneens verwijderd.'
					))
					: '',

				E('div', { 'class': 'right' }, [
					E('button', {
						'class': 'btn',
						'click': ui.hideModal
					}, _('Annuleren')),
					' ',
					E('button', {
						'class':
							'btn cbi-button-negative important',
						'click': function() {
							var rows = managedRecords.filter(
								function(r) {
									return r.id !== record.id;
								}
							);

							ui.hideModal();

							applyManagedRows(
								rows,
								_('DNS-record is verwijderd.')
							);
						}
					}, _('Verwijderen & toepassen'))
				])
			]);
		}

		function toggleManagedRecord(record) {
			var rows = managedRecords.map(function(r) {
				if (r.id !== record.id)
					return r;

				return {
					id: r.id,
					enabled: !r.enabled,
					type: r.type,
					name: r.name,
					value: r.value,
					ptr: r.ptr,
					description: r.description
				};
			});

			applyManagedRows(
				rows,
				record.enabled
					? _('DNS-record is uitgeschakeld.')
					: _('DNS-record is ingeschakeld.')
			);
		}

		var filter = E('input', {
			'class': 'cbi-input-text',
			'type': 'text',
			'placeholder':
				_('Filter op naam, IP, PTR, beschrijving of bron'),
			'style': 'width:100%;max-width:620px'
		});

		var managedBody = E('tbody');
		var forwardBody = E('tbody');
		var ptrBody = E('tbody');

		function renderTables() {
			var q = String(filter.value || '')
				.trim()
				.toLowerCase();

			managedBody.innerHTML = '';
			forwardBody.innerHTML = '';
			ptrBody.innerHTML = '';

			managedRecords.forEach(function(r) {
				var haystack = [
					r.id,
					r.type,
					r.name,
					fqdn(r.name),
					r.value,
					r.description,
					r.enabled ? 'aan enabled' : 'uit disabled',
					r.ptr ? 'ptr' : ''
				].join(' ').toLowerCase();

				if (q && haystack.indexOf(q) < 0)
					return;

				managedBody.appendChild(
					E('tr', {}, [
						E('td', { 'class': 'td' },
							r.enabled ? '● Aan' : '○ Uit'),
						E('td', { 'class': 'td' }, r.type),
						E('td', { 'class': 'td' }, fqdn(r.name)),
						E('td', {
							'class': 'td',
							'style': 'font-family:monospace'
						}, r.value),
						E('td', { 'class': 'td' },
							r.ptr ? _('Ja') : _('Nee')),
						E('td', { 'class': 'td' },
							text(r.description)),
						E('td', { 'class': 'td' }, [
							E('button', {
								'class': 'btn cbi-button-edit',
								'click': function(ev) {
									ev.preventDefault();
									openManagedEditor(r);
								}
							}, _('Bewerken')),
							' ',
							E('button', {
								'class': 'btn',
								'click': function(ev) {
									ev.preventDefault();
									toggleManagedRecord(r);
								}
							}, r.enabled
								? _('Uitschakelen')
								: _('Inschakelen')),
							' ',
							E('button', {
								'class':
									'btn cbi-button-negative',
								'click': function(ev) {
									ev.preventDefault();
									deleteManagedRecord(r);
								}
							}, _('Verwijderen'))
						])
					])
				);
			});

			forwards.forEach(function(r) {
				var haystack = [
					r.hostname,
					r.ip,
					r.source,
					r.file
				].join(' ').toLowerCase();

				if (q && haystack.indexOf(q) < 0)
					return;

				forwardBody.appendChild(
					E('tr', {}, [
						E('td', { 'class': 'td' },
							text(r.hostname)),
						E('td', {
							'class': 'td',
							'style': 'font-family:monospace'
						}, text(r.ip)),
						E('td', { 'class': 'td' },
							text(r.source)),
						E('td', {
							'class': 'td',
							'style':
								'font-family:monospace;font-size:90%'
						}, text(r.file))
					])
				);
			});

			ptrs.forEach(function(r) {
				var haystack = [
					r.ip,
					r.ptr,
					r.source,
					r.file
				].join(' ').toLowerCase();

				if (q && haystack.indexOf(q) < 0)
					return;

				ptrBody.appendChild(
					E('tr', {}, [
						E('td', {
							'class': 'td',
							'style': 'font-family:monospace'
						}, text(r.ip)),
						E('td', { 'class': 'td' },
							text(r.ptr)),
						E('td', { 'class': 'td' },
							text(r.source)),
						E('td', {
							'class': 'td',
							'style':
								'font-family:monospace;font-size:90%'
						}, text(r.file))
					])
				);
			});
		}

		filter.addEventListener('input', renderTables);

		var enabledCount = managedRecords.filter(function(r) {
			return r.enabled;
		}).length;

		var summary = E('div', {
			'class': 'cbi-section',
			'style': 'margin-top:1em'
		}, [
			E('p', {}, [
				E('strong', {}, _('Beheerde records: ')),
				String(managedRecords.length),
				' · ',
				E('strong', {}, _('Actief: ')),
				String(enabledCount),
				' · ',
				E('strong', {}, _('Forward A-records: ')),
				String(forwards.length),
				' · ',
				E('strong', {}, _('PTR-records: ')),
				String(ptrs.length)
			]),
			E('p', {}, _(
				'Beheerde DNS-records zijn de gewenste configuratie. ' +
				'De effectieve tabellen tonen afzonderlijk wat de ' +
				'Panici DNS-configuratie daadwerkelijk aan Unbound aanbiedt.'
			))
		]);

		if (missing.length) {
			summary.appendChild(
				E('p', {
					'class': 'alert-message warning'
				}, _(
					'Niet alle verwachte Unbound-bestanden konden worden gelezen: '
				) + missing.join(', '))
			);
		}

		var page = E('div', {}, [
			E('h2', {}, _('DNS-beheer')),

			E('p', {}, _(
				'Beheer lokale DNS-records voor panici.casa en controleer ' +
				'tegelijk de effectieve A- en PTR-records van alle bronnen.'
			)),

			summary,

			E('div', {
				'style':
					'margin:1em 0;display:flex;gap:.75em;' +
					'align-items:center;flex-wrap:wrap'
			}, [
				filter,
				E('button', {
					'class': 'btn cbi-button-add',
					'click': function() {
						openManagedEditor(null);
					}
				}, _('Record toevoegen'))
			]),

			E('h3', {}, _('Beheerde DNS-records')),

			E('p', {}, _(
				'Deze records komen rechtstreeks uit de beheerde DNS-database. ' +
				'Ook uitgeschakelde records blijven hier zichtbaar.'
			)),

			E('div', {
				'class': 'table',
				'style': 'overflow-x:auto'
			}, [
				E('table', { 'class': 'table' }, [
					E('thead', {}, [
						E('tr', {}, [
							E('th', { 'class': 'th' }, _('Status')),
							E('th', { 'class': 'th' }, _('Type')),
							E('th', { 'class': 'th' }, _('Naam')),
							E('th', { 'class': 'th' }, _('Waarde')),
							E('th', { 'class': 'th' }, _('PTR')),
							E('th', { 'class': 'th' }, _('Beschrijving')),
							E('th', { 'class': 'th' }, _('Acties'))
						])
					]),
					managedBody
				])
			]),

			E('h3', {
				'style': 'margin-top:2em'
			}, _('Effectieve A-records')),

			E('div', {
				'class': 'table',
				'style': 'overflow-x:auto'
			}, [
				E('table', { 'class': 'table' }, [
					E('thead', {}, [
						E('tr', {}, [
							E('th', { 'class': 'th' }, _('Hostnaam')),
							E('th', { 'class': 'th' }, _('IP-adres')),
							E('th', { 'class': 'th' }, _('Bron')),
							E('th', { 'class': 'th' },
								_('Configuratiebestand'))
						])
					]),
					forwardBody
				])
			]),

			E('h3', {
				'style': 'margin-top:2em'
			}, _('Effectieve PTR-records')),

			E('div', {
				'class': 'table',
				'style': 'overflow-x:auto'
			}, [
				E('table', { 'class': 'table' }, [
					E('thead', {}, [
						E('tr', {}, [
							E('th', { 'class': 'th' }, _('IP-adres')),
							E('th', { 'class': 'th' }, _('PTR-hostnaam')),
							E('th', { 'class': 'th' }, _('Bron')),
							E('th', { 'class': 'th' },
								_('Configuratiebestand'))
						])
					]),
					ptrBody
				])
			])
		]);

		renderTables();

		return page;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
