'use strict';
'require view';
'require form';
'require uci';

return view.extend({
    load: function() {
        return uci.load('nanomq_ui');
    },

    render: function() {
        let m, s, o;

        m = new form.Map('nanomq_ui', _('NanoMQ Settings'),
            _('Configureer de verbinding met de NanoMQ REST API.'));

        s = m.section(form.NamedSection, 'main', 'nanomq');

        o = s.option(form.Value, 'host', _('API Host'));
        o.default = '127.0.0.1';
        o.datatype = 'host';

        o = s.option(form.Value, 'port', _('API Port'));
        o.default = '8081';
        o.datatype = 'port';

        o = s.option(form.Value, 'username', _('Username'));
        o.default = 'admin';

        o = s.option(form.Value, 'password', _('Password'));
        o.password = true;

        return m.render();
    }
});
