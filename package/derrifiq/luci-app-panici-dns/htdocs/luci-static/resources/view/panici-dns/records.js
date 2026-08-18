'use strict';
'require view';
'require fs';

var SOURCES = [
        {
                path: '/etc/unbound/panici/static.conf',
                label: 'Vaste configuratie'
        },
        {
                path: '/etc/unbound/panici/iot.conf',
                label: 'IoT'
        },
        {
                path: '/etc/unbound/panici/lxc.conf',
                label: 'Proxmox / LXC'
        },
        {
                path: '/etc/unbound/panici/dhcp.conf',
                label: 'DHCP / UniFi'
        },
        {
                path: '/etc/unbound/panici/ptr-static.conf',
                label: 'Panici canonical / PTR'
        }
];

function cleanName(v) {
        return String(v || '')
                .replace(/\.$/, '')
                .trim();
}

function ipParts(ip) {
        return String(ip || '').split('.').map(function(v) {
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

function parseConfig(data, source, path) {
        var records = [];

        String(data || '').split(/\n/).forEach(function(line) {
                var m;

                /*
                 * local-data: "host.panici.casa. A 10.0.5.1"
                 */
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

                /*
                 * local-data-ptr: "10.0.5.1 host.panici.casa."
                 */
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
                /*
                 * De DNS-record zelf is uniek op:
                 *
                 *   A   = hostname + IP
                 *   PTR = IP + PTR-target
                 *
                 * Wanneer dezelfde RR uit meerdere configuratiebestanden
                 * afkomstig is, tonen we één live record en voegen we de
                 * bronnen samen.
                 */
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

function text(v) {
        return v ? String(v) : '—';
}

return view.extend({
        load: function() {
                return Promise.all(SOURCES.map(function(s) {
                        return fs.read(s.path)
                                .then(function(data) {
                                        return {
                                                source: s,
                                                data: data || '',
                                                available: true
                                        };
                                })
                                .catch(function() {
                                        return {
                                                source: s,
                                                data: '',
                                                available: false
                                        };
                                });
                }));
        },

        render: function(data) {
                var records = [];
                var missing = [];

                data.forEach(function(item) {
                        if (!item.available) {
                                missing.push(item.source.path);
                                return;
                        }

                        records = records.concat(
                                parseConfig(
                                        item.data,
                                        item.source.label,
                                        item.source.path
                                )
                        );
                });

                records = uniqueRecords(records);

                var forwards = records.filter(function(r) {
                        return r.type === 'A';
                });

                var ptrs = records.filter(function(r) {
                        return r.type === 'PTR';
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

                var filter = E('input', {
                        'class': 'cbi-input-text',
                        'type': 'text',
                        'placeholder': _('Filter op hostnaam, IP, PTR of bron'),
                        'style': 'width:100%;max-width:560px'
                });

                var forwardBody = E('tbody');
                var ptrBody = E('tbody');

                function renderTables() {
                        var q = String(filter.value || '')
                                .trim()
                                .toLowerCase();

                        forwardBody.innerHTML = '';
                        ptrBody.innerHTML = '';

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
                                                E('td', {
                                                        'class': 'td'
                                                }, text(r.hostname)),
                                                E('td', {
                                                        'class': 'td'
                                                }, text(r.ip)),
                                                E('td', {
                                                        'class': 'td'
                                                }, text(r.source)),
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
                                                        'class': 'td'
                                                }, text(r.ip)),
                                                E('td', {
                                                        'class': 'td'
                                                }, text(r.ptr)),
                                                E('td', {
                                                        'class': 'td'
                                                }, text(r.source)),
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

                var summary = E('div', {
                        'class': 'cbi-section',
                        'style': 'margin-top:1em'
                }, [
                        E('p', {}, [
                                E('strong', {}, _('Forward A-records: ')),
                                String(forwards.length),
                                ' · ',
                                E('strong', {}, _('PTR-records: ')),
                                String(ptrs.length)
                        ]),
                        E('p', {}, _(
                                'Dit overzicht wordt rechtstreeks opgebouwd uit de gegenereerde Unbound-configuratie. ' +
                                'Eén hostnaam kan meerdere A-records hebben, bijvoorbeeld bij een apparaat met meerdere netwerkinterfaces.'
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
                        E('h2', {}, _('Actieve DNS-records')),

                        E('p', {}, _(
                                'Hier zie je welke lokale A- en PTR-records door de Panici DNS-configuratie aan Unbound worden aangeboden.'
                        )),

                        summary,

                        E('div', {
                                'style': 'margin:1em 0'
                        }, filter),

                        E('h3', {}, _('Forward A-records')),

                        E('div', {
                                'class': 'table',
                                'style': 'overflow-x:auto'
                        }, [
                                E('table', {
                                        'class': 'table'
                                }, [
                                        E('thead', {}, [
                                                E('tr', {}, [
                                                        E('th', {
                                                                'class': 'th'
                                                        }, _('Hostnaam')),
                                                        E('th', {
                                                                'class': 'th'
                                                        }, _('IP-adres')),
                                                        E('th', {
                                                                'class': 'th'
                                                        }, _('Bron')),
                                                        E('th', {
                                                                'class': 'th'
                                                        }, _('Configuratiebestand'))
                                                ])
                                        ]),
                                        forwardBody
                                ])
                        ]),

                        E('h3', {
                                'style': 'margin-top:2em'
                        }, _('PTR-records')),

                        E('div', {
                                'class': 'table',
                                'style': 'overflow-x:auto'
                        }, [
                                E('table', {
                                        'class': 'table'
                                }, [
                                        E('thead', {}, [
                                                E('tr', {}, [
                                                        E('th', {
                                                                'class': 'th'
                                                        }, _('IP-adres')),
                                                        E('th', {
                                                                'class': 'th'
                                                        }, _('PTR-hostnaam')),
                                                        E('th', {
                                                                'class': 'th'
                                                        }, _('Bron')),
                                                        E('th', {
                                                                'class': 'th'
                                                        }, _('Configuratiebestand'))
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
