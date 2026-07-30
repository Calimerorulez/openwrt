'use strict';
'require view';
'require poll';
'require uci';
'require dom';
'require rpc';

var callNanomqProxy = rpc.declare({
    object: 'nanomq',
    method: 'proxy',
    params: ['path'],
    expect: { result: '' }
});

function apiCall(cfg, path) {
    return callNanomqProxy(path.replace(/^\//, '')).then(function(raw) {
        try {
            return JSON.parse(raw);
        } catch (e) {
            return { code: -1, error: 'Invalid JSON: ' + raw };
        }
    }).catch(function(e) {
        return { code: -1, error: e.message };
    });
}

function renderTable(headers, rows) {
    if (!rows || rows.length === 0)
        return E('em', {}, _('Geen data beschikbaar'));

    var table = E('table', { 'class': 'table' }, [
        E('tr', { 'class': 'tr table-titles' },
            headers.map(function(h) { return E('th', { 'class': 'th' }, h); }))
    ]);

    rows.forEach(function(row) {
        table.appendChild(E('tr', { 'class': 'tr' },
            row.map(function(cell) { return E('td', { 'class': 'td' }, String(cell)); })));
    });

    return table;
}

function renderMetrics(data) {
    var basic = E('div', { 'class': 'cbi-section' }, [
        E('p', {}, _('CPU') + ': ' + (data.cpuinfo || 'n/a')),
        E('p', {}, _('Memory') + ': ' + (data.memory ? (data.memory / 1024).toFixed(0) + ' KB' : 'n/a')),
        E('p', {}, _('Active connections') + ': ' + (data.connections != null ? data.connections : 'n/a'))
    ]);

    var metricRows = (data.metrics || []).map(function(m) {
        var keys = Object.keys(m);
        return [keys.map(function(k) { return k + '=' + m[k]; }).join(', ')];
    });

    return E('div', {}, [
        basic,
        E('h4', {}, _('Message metrics')),
        renderTable([_('Metric')], metricRows)
    ]);
}

return view.extend({
    load: function() {
        return uci.load('nanomq_ui');
    },

    render: function() {
        var cfg = {
            host: uci.get('nanomq_ui', 'main', 'host') || window.location.hostname,
            port: uci.get('nanomq_ui', 'main', 'port') || '8081',
            username: uci.get('nanomq_ui', 'main', 'username') || 'admin',
            password: uci.get('nanomq_ui', 'main', 'password') || 'public'
        };

        var clientsNode = E('div', {}, E('em', {}, _('Laden…')));
        var subsNode = E('div', {}, E('em', {}, _('Laden…')));
        var bridgesNode = E('div', {}, E('em', {}, _('Laden…')));
        var rulesNode = E('div', {}, E('em', {}, _('Laden…')));
        var metricsNode = E('div', {}, E('em', {}, _('Laden…')));

        function refresh() {
            apiCall(cfg, '/clients').then(function(res) {
                var rows = (res.data || []).map(function(c) {
                    return [c.client_id || c.clientid || '-', c.username || '-', c.keepalive || '-', c.connected ? _('Yes') : _('No')];
                });
                dom.content(clientsNode, renderTable([_('Client ID'), _('Username'), _('Keepalive'), _('Connected')], rows));
            });

            apiCall(cfg, '/subscriptions').then(function(res) {
                var rows = (res.data || []).map(function(s) {
                    return [s.clientid || s.client_id || '-', s.topic || '-', s.qos != null ? s.qos : '-'];
                });
                dom.content(subsNode, renderTable([_('Client ID'), _('Topic'), _('QoS')], rows));
            });

            apiCall(cfg, '/bridges').then(function(res) {
                var nodes = (res.data && res.data.bridge && res.data.bridge.nodes) || [];
                var rows = nodes.map(function(b) {
                    return [b.name || '-', b.status || '-', b.address || '-'];
                });
                dom.content(bridgesNode, renderTable([_('Name'), _('Status'), _('Address')], rows));
            });

            apiCall(cfg, '/rules').then(function(res) {
                if (res.code !== 0) {
                    dom.content(rulesNode, E('em', {}, _('Rule engine niet actief in deze NanoMQ-build')));
                    return;
                }
                var rows = (res.data || []).map(function(r) {
                    return [r.id || '-', r.sql || '-'];
                });
                dom.content(rulesNode, renderTable([_('Rule ID'), _('SQL')], rows));
            });

            apiCall(cfg, '/metrics').then(function(res) {
                if (res.code === -1) {
                    dom.content(metricsNode, E('em', {}, _('Kan metrics niet ophalen: ') + res.error));
                    return;
                }
                dom.content(metricsNode, renderMetrics(res));
            });
        }

        poll.add(refresh, 5);

        return E('div', {}, [
            E('h2', {}, _('NanoMQ Overview')),

            E('h3', {}, _('Broker metrics')),
            metricsNode,

            E('h3', {}, _('Connected clients')),
            clientsNode,

            E('h3', {}, _('Subscriptions')),
            subsNode,

            E('h3', {}, _('Bridges')),
            bridgesNode,

            E('h3', {}, _('Rule engine')),
            rulesNode
        ]);
    }
});
