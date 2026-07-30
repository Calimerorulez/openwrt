'use strict';

import * as uci from 'uci';
import { popen } from 'fs';

const methods = {
    proxy: {
        args: { path: 'clients' },
        call: function(req) {
            let cursor = uci.cursor();
            let host = cursor.get('nanomq_ui', 'main', 'host') || '127.0.0.1';
            let port = cursor.get('nanomq_ui', 'main', 'port') || '8081';
            let user = cursor.get('nanomq_ui', 'main', 'username') || 'admin';
            let pass = cursor.get('nanomq_ui', 'main', 'password') || 'public';

            let path = req.args.path || 'clients';
            let cmd = sprintf(
                'curl -s -m 5 -u %s:%s "http://%s:%s/api/v4/%s"',
                user, pass, host, port, path
            );

            let fp = popen(cmd);
            let result = fp ? fp.read('all') : '';
            if (fp) fp.close();

            return { result: result };
        }
    }
};

return { 'nanomq': methods };
