'use strict';
'require view';
'require rpc';
'require poll';
'require ui';

var callOverview = rpc.declare({
	object: 'dns-analytics',
	method: 'overview',
	expect: {}
});

var callTopDomains = rpc.declare({
	object: 'dns-analytics',
	method: 'top-domains',
	expect: {}
});

var callTopCategories = rpc.declare({
	object: 'dns-analytics',
	method: 'top-categories',
	expect: {}
});

var dashboardNodes = {};
var overviewRefreshInProgress = false;
var topDomainsRefreshInProgress = false;
var topCategoriesRefreshInProgress = false;
var manualRefreshInProgress = false;
var lastErrorMessage = null;

function formatInteger(value) {
	var number = Number(value);

	if (!Number.isFinite(number))
		return '—';

	return number.toLocaleString();
}

function formatBytes(value) {
	var bytes = Number(value);
	var units = [ _('B'), _('KiB'), _('MiB'), _('GiB') ];
	var index = 0;

	if (!Number.isFinite(bytes) || bytes < 0)
		return '—';

	while (bytes >= 1024 && index < units.length - 1) {
		bytes /= 1024;
		index++;
	}

	if (index == 1 && bytes > 900) {
		bytes /= 1024;
		index++;
	}

	return '%s %s'.format(
		bytes.toFixed(index === 0 ? 0 : 1),
		units[index]
	);
}

function formatAge(value) {
	var seconds = Number(value);

	if (!Number.isFinite(seconds) || seconds < 0)
		return '—';

	if (seconds < 60)
		return N_(seconds, '%d seconde', '%d seconden').format(seconds);

	var minutes = Math.floor(seconds / 60);
	var remainder = seconds % 60;

	if (minutes < 60)
		return _('%d min %d sec').format(minutes, remainder);

	var hours = Math.floor(minutes / 60);
	minutes %= 60;

	return _('%d uur %d min').format(hours, minutes);
}

function formatRefreshTime(date) {
	if (!(date instanceof Date) || Number.isNaN(date.getTime()))
		return '—';

	return date.toLocaleTimeString();
}

function formatRelativeTime(value) {
	var timestamp = Number(value);

	if (!Number.isFinite(timestamp) || timestamp <= 0)
		return '—';

	var seconds = Math.max(
		0,
		Math.floor(Date.now() / 1000) - timestamp
	);

	if (seconds < 60)
		return N_(
			seconds,
			_('%d seconde geleden'),
			_('%d seconden geleden')
		).format(seconds);

	var minutes = Math.floor(seconds / 60);

	if (minutes < 60)
		return N_(
			minutes,
			_('%d minuut geleden'),
			_('%d minuten geleden')
		).format(minutes);

	var hours = Math.floor(minutes / 60);

	if (hours < 24)
		return N_(
			hours,
			_('%d uur geleden'),
			_('%d uur geleden')
		).format(hours);

	var days = Math.floor(hours / 24);

	return N_(
		days,
		_('%d dag geleden'),
		_('%d dagen geleden')
	).format(days);
}

function isTrue(value) {
	return value === true || value === 1 || value === '1';
}

function setText(node, value) {
	if (node)
		node.textContent = value == null ? '—' : String(value);
}

function makeCard(title, description, key, extraClass) {
	var valueNode = E('div', {
		'class': 'dns-card-value'
	}, '—');

	dashboardNodes[key] = valueNode;

	var card = E('div', {
		'class': 'dns-card ' + (extraClass || '')
	}, [
		E('h3', {}, title),
		valueNode,
		E('p', {}, description)
	]);

	dashboardNodes[key + 'Card'] = card;

	return card;
}

function makeStatusRow(title, key, options) {
	options = options || {};

	var valueNode = options.code
		? E('code', {
			'class': options.className || ''
		}, '—')
		: E('span', {
			'class': options.className || ''
		}, '—');

	dashboardNodes[key] = valueNode;

	return E('div', {
		'class': 'dns-status-row'
	}, [
		E('strong', {}, title),
		valueNode
	]);
}

function updateBadge(node, healthy, healthyText, unhealthyText) {
	if (!node)
		return;

	node.className = healthy
		? 'label success dns-status'
		: 'label danger dns-status';

	node.textContent = healthy ? healthyText : unhealthyText;
}

function setManualRefreshState(active) {
	manualRefreshInProgress = active;

	if (!dashboardNodes.refreshButton)
		return;

	dashboardNodes.refreshButton.disabled = active;
	dashboardNodes.refreshButton.textContent = active
		? _('Verversen…')
		: _('Vernieuwen');
}

function clearError() {
	if (dashboardNodes.errorBox)
		dashboardNodes.errorBox.style.display = 'none';

	lastErrorMessage = null;
}

function showError(message) {
	message = message || _('De backend gaf geen geldige gegevens terug.');

	if (dashboardNodes.errorText)
		setText(dashboardNodes.errorText, message);

	if (dashboardNodes.errorBox)
		dashboardNodes.errorBox.style.display = '';

	/*
	 * Voorkom dat iedere poll dezelfde LuCI-notificatie toevoegt.
	 */
	if (message !== lastErrorMessage) {
		ui.addNotification(null, E('p', {}, [
			E('strong', {}, _('DNS Analytics: ')),
			message
		]), 'danger');

		lastErrorMessage = message;
	}
}

function validateOverview(data) {
	if (!data)
		throw new Error(_('De backend gaf geen gegevens terug.'));

	if (data.error) {
		var message = data.message || data.error;

		if (data.exit_code != null)
			message = _('%s (exitcode %s)').format(
				message,
				data.exit_code
			);

		throw new Error(message);
	}

	return data;
}

function updateDashboard(data) {
	data = validateOverview(data);

	var databaseAvailable = isTrue(data.database_exists);
	var collectorConfigured = isTrue(data.collector_configured);
	var collectorHealthy = isTrue(data.collector_healthy);
	var pendingDomains = Number(data.pending_domains);

	setText(dashboardNodes.totalQueries, formatInteger(data.total_queries));
	setText(dashboardNodes.uniqueDomains, formatInteger(data.unique_domains));
	setText(dashboardNodes.pendingDomains, formatInteger(data.pending_domains));
	setText(dashboardNodes.enabledCategories, formatInteger(data.enabled_categories));

	if (dashboardNodes.pendingDomainsCard) {
		dashboardNodes.pendingDomainsCard.classList.toggle(
			'attention',
			Number.isFinite(pendingDomains) && pendingDomains > 0
		);
	}

	updateBadge(
		dashboardNodes.collectorHealthy,
		collectorHealthy,
		_('Actief'),
		_('Niet actief')
	);

	updateBadge(
		dashboardNodes.collectorConfigured,
		collectorConfigured,
		_('Aanwezig'),
		_('Ontbreekt')
	);

	updateBadge(
		dashboardNodes.databaseAvailable,
		databaseAvailable,
		_('Beschikbaar'),
		_('Ontbreekt')
	);

	setText(
		dashboardNodes.watermarkAge,
		formatAge(data.watermark_age_seconds)
	);

	setText(
		dashboardNodes.databaseSize,
		formatBytes(data.database_size)
	);

	setText(dashboardNodes.watermark, data.watermark || '—');
	setText(dashboardNodes.packageVersion, data.package_version || '—');
	setText(dashboardNodes.applicationVersion, data.application_version || '—');
	setText(dashboardNodes.schemaVersion, data.schema_version || '—');
	setText(dashboardNodes.databasePath, data.database_path || '—');
	setText(dashboardNodes.lastRefresh, formatRefreshTime(new Date()));

	clearError();
}

function refreshOverview() {
	if (overviewRefreshInProgress)
		return Promise.resolve();

	overviewRefreshInProgress = true;

	return callOverview()
		.then(function(data) {
			updateDashboard(data);
		})
		.catch(function(error) {
			showError(
				error && error.message
					? error.message
					: String(error)
			);
		})
		.finally(function() {
			overviewRefreshInProgress = false;
		});
}

function validateTopDomains(data) {
	if (!data)
		throw new Error(_('De backend gaf geen Top Domains-gegevens terug.'));

	if (data.error) {
		var message = data.message || data.error;

		if (data.exit_code != null)
			message = _('%s (exitcode %s)').format(
				message,
				data.exit_code
			);

		throw new Error(message);
	}

	if (!Array.isArray(data.rows))
		throw new Error(_('De Top Domains-backend gaf geen geldige rijen terug.'));

	return data;
}

function clearTopDomainsError() {
	if (dashboardNodes.topDomainsError)
		dashboardNodes.topDomainsError.style.display = 'none';
}

function showTopDomainsError(message) {
	if (dashboardNodes.topDomainsErrorText)
		setText(
			dashboardNodes.topDomainsErrorText,
			message || _('Top Domains kon niet worden geladen.')
		);

	if (dashboardNodes.topDomainsError)
		dashboardNodes.topDomainsError.style.display = '';
}

function updateTopDomains(data) {
	data = validateTopDomains(data);

	var body = dashboardNodes.topDomainsBody;
	var rows = data.rows;

	if (!body)
		return;

	while (body.firstChild)
		body.removeChild(body.firstChild);

	rows.forEach(function(row) {
		var status = row.classification_status || 'pending';
		var classified = status === 'classified';

		body.appendChild(E('tr', {}, [
			E('td', {
				'class': 'dns-domain-cell'
			}, [
				E('code', {}, row.domain || '—')
			]),

			E('td', {
				'class': 'td right dns-query-count'
			}, formatInteger(row.queries)),

			E('td', {}, [
				E('span', {
					'class': classified
						? 'dns-category'
						: 'dns-category dns-category-pending'
				}, row.category || _('Onbekend'))
			]),

			E('td', {
				'class': 'dns-last-seen'
			}, formatRelativeTime(row.last_seen))
		]));
	});

	if (dashboardNodes.topDomainsEmpty)
		dashboardNodes.topDomainsEmpty.style.display =
			rows.length === 0 ? '' : 'none';

	if (dashboardNodes.topDomainsMeta) {
		setText(
			dashboardNodes.topDomainsMeta,
			_('%d domeinen · bijgewerkt om %s').format(
				rows.length,
				formatRefreshTime(new Date())
			)
		);
	}

	clearTopDomainsError();
}


function validateTopCategories(data) {
	if (!data)
		throw new Error(_('De backend gaf geen Top Categories-gegevens terug.'));

	if (data.error) {
		var message = data.message || data.error;

		if (data.exit_code != null)
			message = _('%s (exitcode %s)').format(
				message,
				data.exit_code
			);

		throw new Error(message);
	}

	if (!Array.isArray(data.rows))
		throw new Error(
			_('De Top Categories-backend gaf geen geldige rijen terug.')
		);

	return data;
}

function clearTopCategoriesError() {
	if (dashboardNodes.topCategoriesError)
		dashboardNodes.topCategoriesError.style.display = 'none';
}

function showTopCategoriesError(message) {
	if (dashboardNodes.topCategoriesErrorText)
		setText(
			dashboardNodes.topCategoriesErrorText,
			message || _('Top Categories kon niet worden geladen.')
		);

	if (dashboardNodes.topCategoriesError)
		dashboardNodes.topCategoriesError.style.display = '';
}

function updateTopCategories(data) {
	data = validateTopCategories(data);

	var body = dashboardNodes.topCategoriesBody;
	var rows = data.rows;

	if (!body)
		return;

	while (body.firstChild)
		body.removeChild(body.firstChild);

	rows.forEach(function(row) {
		var percentage = Number(row.percentage);

		body.appendChild(E('tr', {}, [
			E('td', {}, [
				E('span', {
					'class': 'dns-category'
				}, row.category || _('Onbekend'))
			]),

			E('td', {
				'class': 'td right dns-query-count'
			}, formatInteger(row.queries)),

			E('td', {
				'class': 'td right dns-query-count'
			}, formatInteger(row.domains)),

			E('td', {
				'class': 'dns-percentage-cell'
			}, [
				E('div', {
					'class': 'dns-percentage-track'
				}, [
					E('span', {
						'class': 'dns-percentage-fill',
						'style': 'width:%s%%'.format(
							Number.isFinite(percentage)
								? Math.min(100, Math.max(0, percentage))
								: 0
						)
					})
				]),
				E('span', {
					'class': 'dns-percentage-label'
				}, Number.isFinite(percentage)
					? _('%s%%').format(percentage.toFixed(1))
					: '—')
			])
		]));
	});

	if (dashboardNodes.topCategoriesEmpty)
		dashboardNodes.topCategoriesEmpty.style.display =
			rows.length === 0 ? '' : 'none';

	if (dashboardNodes.topCategoriesMeta) {
		setText(
			dashboardNodes.topCategoriesMeta,
			_('%s · %d categorieën · %s queries').format(
				data.day || '—',
				rows.length,
				formatInteger(data.total_queries)
			)
		);
	}

	clearTopCategoriesError();
}

function refreshTopCategories() {
	if (topCategoriesRefreshInProgress)
		return Promise.resolve();

	topCategoriesRefreshInProgress = true;

	return callTopCategories()
		.then(function(data) {
			updateTopCategories(data);
		})
		.catch(function(error) {
			showTopCategoriesError(
				error && error.message
					? error.message
					: String(error)
			);
		})
		.finally(function() {
			topCategoriesRefreshInProgress = false;
		});
}

function refreshTopDomains() {
	if (topDomainsRefreshInProgress)
		return Promise.resolve();

	topDomainsRefreshInProgress = true;

	return callTopDomains()
		.then(function(data) {
			updateTopDomains(data);
		})
		.catch(function(error) {
			showTopDomainsError(
				error && error.message
					? error.message
					: String(error)
			);
		})
		.finally(function() {
			topDomainsRefreshInProgress = false;
		});
}

function refreshAll() {
	if (manualRefreshInProgress)
		return Promise.resolve();

	setManualRefreshState(true);

	return Promise.all([
		refreshOverview(),
		refreshTopDomains(),
		refreshTopCategories()
	]).finally(function() {
		setManualRefreshState(false);
	});
}

function buildDashboard() {
	dashboardNodes = {};

	dashboardNodes.errorText = E('span', {}, '');
	dashboardNodes.errorBox = E('div', {
		'class': 'alert-message error dns-error',
		'style': 'display:none'
	}, [
		E('strong', {}, _('Verversen mislukt: ')),
		dashboardNodes.errorText
	]);

	dashboardNodes.collectorHealthy = E('span', {
		'class': 'label danger dns-status'
	}, _('Onbekend'));

	dashboardNodes.collectorConfigured = E('span', {
		'class': 'label danger dns-status'
	}, _('Onbekend'));

	dashboardNodes.databaseAvailable = E('span', {
		'class': 'label danger dns-status'
	}, _('Onbekend'));

	dashboardNodes.lastRefresh = E('span', {}, '—');

	dashboardNodes.refreshButton = E('button', {
		'class': 'btn cbi-button cbi-button-action dns-refresh-button',
		'type': 'button',
		'click': function(event) {
			event.preventDefault();
			refreshAll();
		}
	}, _('Vernieuwen'));

	dashboardNodes.topDomainsBody = E('tbody');
	dashboardNodes.topDomainsMeta = E('span', {}, _('Nog niet geladen'));

	dashboardNodes.topDomainsEmpty = E('div', {
		'class': 'alert-message notice dns-top-domains-empty',
		'style': 'display:none'
	}, _('Er zijn nog geen domeingegevens beschikbaar.'));

	dashboardNodes.topDomainsErrorText = E('span', {}, '');
	dashboardNodes.topDomainsError = E('div', {
		'class': 'alert-message warning dns-top-domains-error',
		'style': 'display:none'
	}, [
		E('strong', {}, _('Top Domains verversen mislukt: ')),
		dashboardNodes.topDomainsErrorText
	]);

	dashboardNodes.topCategoriesBody = E('tbody');
	dashboardNodes.topCategoriesMeta = E('span', {}, _('Nog niet geladen'));

	dashboardNodes.topCategoriesEmpty = E('div', {
		'class': 'alert-message notice dns-top-categories-empty',
		'style': 'display:none'
	}, _('Er zijn nog geen categoriegegevens beschikbaar.'));

	dashboardNodes.topCategoriesErrorText = E('span', {}, '');
	dashboardNodes.topCategoriesError = E('div', {
		'class': 'alert-message warning dns-top-categories-error',
		'style': 'display:none'
	}, [
		E('strong', {}, _('Top Categories verversen mislukt: ')),
		dashboardNodes.topCategoriesErrorText
	]);

	return E([], [
		E('div', {
			'class': 'dns-heading'
		}, [
			E('div', {}, [
				E('h2', {}, _('DNS Analytics')),
				E('div', {
					'class': 'cbi-map-descr'
				}, _(
					'Actuele DNS-queryanalyse, classificatiestatus en systeeminformatie.'
				))
			]),

			E('div', {
				'class': 'dns-heading-actions'
			}, [
				E('span', {
					'class': 'dns-last-refresh'
				}, [
					_('Laatst ververst: '),
					dashboardNodes.lastRefresh
				]),
				dashboardNodes.refreshButton
			])
		]),

		dashboardNodes.errorBox,

		E('div', {
			'class': 'dns-grid'
		}, [
			makeCard(
				_('Queries'),
				_('Totaal geregistreerde DNS-queries'),
				'totalQueries'
			),

			makeCard(
				_('Domeinen'),
				_('Unieke geregistreerde domeinen'),
				'uniqueDomains'
			),

			makeCard(
				_('Nog beoordelen'),
				_('Domeinen met classificatiestatus pending'),
				'pendingDomains'
			),

			makeCard(
				_('Categorieën'),
				_('Ingeschakelde classificatiecategorieën'),
				'enabledCategories'
			)
		]),

		E('h3', {
			'class': 'dns-section-title'
		}, _('Systeemstatus')),

		E('div', {
			'class': 'dns-status-table'
		}, [
			E('div', {
				'class': 'dns-status-row'
			}, [
				E('strong', {}, _('Collector')),
				dashboardNodes.collectorHealthy
			]),

			E('div', {
				'class': 'dns-status-row'
			}, [
				E('strong', {}, _('Collectorconfiguratie')),
				dashboardNodes.collectorConfigured
			]),

			makeStatusRow(
				_('Leeftijd watermark'),
				'watermarkAge'
			),

			E('div', {
				'class': 'dns-status-row'
			}, [
				E('strong', {}, _('Database')),
				dashboardNodes.databaseAvailable
			]),

			makeStatusRow(
				_('Databasegrootte'),
				'databaseSize'
			),

			makeStatusRow(
				_('Laatste query'),
				'watermark',
				{ code: true }
			),

			makeStatusRow(
				_('Packageversie'),
				'packageVersion',
				{ code: true }
			),

			makeStatusRow(
				_('Applicatieversie'),
				'applicationVersion',
				{ code: true }
			),

			makeStatusRow(
				_('Schema-versie'),
				'schemaVersion',
				{ code: true }
			),

			makeStatusRow(
				_('Databasepad'),
				'databasePath',
				{
					code: true,
					className: 'dns-path'
				}
			)
		]),

		E('div', {
			'class': 'dns-section-header'
		}, [
			E('h3', {
				'class': 'dns-section-title'
			}, _('Top Domains')),

			E('span', {
				'class': 'dns-section-meta'
			}, dashboardNodes.topDomainsMeta)
		]),

		dashboardNodes.topDomainsError,
		dashboardNodes.topDomainsEmpty,

		E('div', {
			'class': 'table cbi-section-table dns-top-domains-table'
		}, [
			E('table', {
				'class': 'table'
			}, [
				E('thead', {}, [
					E('tr', {
						'class': 'tr table-titles'
					}, [
						E('th', {
							'class': 'th'
						}, _('Domein')),

						E('th', {
							'class': 'th right'
						}, _('Queries')),

						E('th', {
							'class': 'th'
						}, _('Categorie')),

						E('th', {
							'class': 'th'
						}, _('Laatst gezien'))
					])
				]),

				dashboardNodes.topDomainsBody
			])
		]),

		E('div', {
			'class': 'dns-section-header'
		}, [
			E('h3', {
				'class': 'dns-section-title'
			}, _('Top Categories')),

			E('span', {
				'class': 'dns-section-meta'
			}, dashboardNodes.topCategoriesMeta)
		]),

		dashboardNodes.topCategoriesError,
		dashboardNodes.topCategoriesEmpty,

		E('div', {
			'class': 'table cbi-section-table dns-top-categories-table'
		}, [
			E('table', {
				'class': 'table'
			}, [
				E('thead', {}, [
					E('tr', {
						'class': 'tr table-titles'
					}, [
						E('th', {
							'class': 'th'
						}, _('Categorie')),

						E('th', {
							'class': 'th right'
						}, _('Queries')),

						E('th', {
							'class': 'th right'
						}, _('Domeinen')),

						E('th', {
							'class': 'th'
						}, _('Aandeel'))
					])
				]),

				dashboardNodes.topCategoriesBody
			])
		]),

		E('style', {}, `
			.dns-heading {
				
				margin-top: 1rem;
display: flex;
				align-items: flex-start;
				justify-content: space-between;
				gap: 1rem;
				flex-wrap: wrap;
			}

			.dns-heading h2 {
				margin-top: 0;
			}

			.dns-heading-actions {
				display: flex;
				align-items: center;
				justify-content: flex-end;
				gap: 1rem;
				flex-wrap: wrap;
			}

			.dns-last-refresh {
				font-size: 0.9rem;
				opacity: 0.75;
			}

			.dns-error {
				margin-top: 1rem;
			}

			.dns-grid {
				display: grid;
				grid-template-columns:
					repeat(auto-fit, minmax(210px, 1fr));
				gap: 1rem;
				margin-top: 1.5rem;
			}

			.dns-card {
				border: 1px solid var(--border-color-medium, #d5d5d5);
				border-radius: 6px;
				padding: 1rem;
				background: var(--background-color-high, #fff);
				box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
			}

			.dns-card.attention {
				border-left: 4px solid #f0ad4e;
			}

			.dns-card h3 {
				margin: 0 0 0.75rem;
			}

			.dns-card-value {
				font-size: 2rem;
				font-weight: 600;
				line-height: 1.2;
				margin-bottom: 0.5rem;
				font-variant-numeric: tabular-nums;
			}

			.dns-card p {
				margin: 0;
				opacity: 0.75;
			}

			.dns-section-title {
				margin-top: 2rem;
			}

			.dns-status-table {
				border: 1px solid var(--border-color-medium, #d5d5d5);
				border-radius: 6px;
				overflow: hidden;
			}

			.dns-status-row {
				display: grid;
				grid-template-columns: minmax(160px, 240px) 1fr;
				gap: 1rem;
				align-items: center;
				padding: 0.75rem 1rem;
				border-bottom:
					1px solid var(--border-color-low, #e8e8e8);
			}

			.dns-status-row:last-child {
				border-bottom: 0;
			}

			.dns-status {
				justify-self: start;
			}

			.dns-path {
				overflow-wrap: anywhere;
			}

			
			.dns-refresh-button {
				min-width: 110px;
				text-align: center;
				white-space: nowrap;
			}

			.dns-section-header {
				display: flex;
				align-items: baseline;
				justify-content: space-between;
				gap: 1rem;
				flex-wrap: wrap;
				margin-top: 2rem;
			}

			.dns-section-header .dns-section-title {
				margin: 0;
			}

			.dns-section-meta {
				font-size: 0.9rem;
				opacity: 0.7;
			}

			.dns-top-domains-error,
			.dns-top-domains-empty,
			.dns-top-categories-error,
			.dns-top-categories-empty {
				margin-top: 1rem;
			}

			.dns-top-domains-table,
			.dns-top-categories-table {
				overflow-x: auto;
				margin-top: 1rem;
			}

			.dns-top-domains-table table,
			.dns-top-categories-table table {
				width: 100%;
				min-width: 720px;
				border-collapse: collapse;
			}

			.dns-top-domains-table th,
			.dns-top-domains-table td {
				padding: 0.7rem 0.75rem;
				vertical-align: middle;
			}

			.dns-top-domains-table tbody tr:nth-child(even) {
				background: rgba(127, 127, 127, 0.045);
			}

			.dns-domain-cell {
				max-width: 360px;
				overflow-wrap: anywhere;
			}

			.dns-query-count {
				font-weight: 600;
				font-variant-numeric: tabular-nums;
				white-space: nowrap;
			}

			.dns-category {
				display: inline-block;
				padding: 0.15rem 0.45rem;
				border-radius: 999px;
				background: rgba(55, 125, 34, 0.12);
				font-size: 0.9rem;
				overflow-wrap: anywhere;
			}

			.dns-category-pending {
				background: rgba(240, 173, 78, 0.16);
			}

			.dns-last-seen {
				white-space: nowrap;
			}

			.dns-percentage-cell {
				display: grid;
				grid-template-columns: minmax(100px, 1fr) 4.5rem;
				align-items: center;
				gap: 0.75rem;
				min-width: 190px;
			}

			.dns-percentage-track {
				height: 0.55rem;
				border-radius: 999px;
				background: rgba(127, 127, 127, 0.16);
				overflow: hidden;
			}

			.dns-percentage-fill {
				display: block;
				height: 100%;
				border-radius: inherit;
				background: currentColor;
				opacity: 0.65;
			}

			.dns-percentage-label {
				text-align: right;
				font-variant-numeric: tabular-nums;
				white-space: nowrap;
			}

			@media (max-width: 600px) {
				.dns-heading-actions {
					width: 100%;
					justify-content: space-between;
				}

				.dns-status-row {
					grid-template-columns: 1fr;
					gap: 0.25rem;
				}
			}
		`)
	]);
}

return view.extend({
	load: function() {
		return callOverview();
	},

	render: function(data) {
		var dashboard = buildDashboard();

		try {
			updateDashboard(data);
		}
		catch (error) {
			showError(
				error && error.message
					? error.message
					: String(error)
			);
		}

		refreshTopDomains();
		refreshTopCategories();

		poll.add(refreshOverview, 10);
		poll.add(refreshTopDomains, 30);
		poll.add(refreshTopCategories, 30);

		return dashboard;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
