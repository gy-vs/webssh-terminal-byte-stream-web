#!/usr/bin/env python3
"""Serves the real Tornado index page for the browser regression test.

Only /static/js/main.js is handled specially: ?v=orig serves the pristine
main.js from the git index (HEAD) and ?v=fixed (default) serves the current
working tree. Everything else - the rendered index.html template, xterm,
css, fonts and the connection form - is served by the real application.
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__),
                                                '..', '..')))

import tornado.ioloop  # noqa: E402

from webssh.main import make_app, make_handlers  # noqa: E402
from webssh.settings import get_app_settings  # noqa: E402
from tornado.options import options  # noqa: E402

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PORT = int(os.environ.get('WSSH_TEST_PORT', '8899'))

options.policy = 'warning'
options.hostfile = ''
options.syshostfile = ''
options.tdstream = ''
options.encoding = ''
options.debug = False
options.xsrf = False
options.origin = 'same'
options.maxconn = 20

with open(os.path.join(REPO_ROOT, 'webssh', 'static', 'js', 'main.js'),
          encoding='utf-8') as f:
    FIXED_JS = f.read()
ORIGINAL_JS = subprocess.check_output(
    ['git', 'show', 'HEAD:webssh/static/js/main.js'], cwd=REPO_ROOT
).decode('utf-8')


class MainJsHandler(tornado.web.RequestHandler):
    def get(self):
        version = self.get_argument('v', 'fixed')
        self.set_header('Content-Type', 'application/javascript')
        self.write(ORIGINAL_JS if version == 'orig' else FIXED_JS)


loop = tornado.ioloop.IOLoop.current()
app = make_app(make_handlers(loop, options), get_app_settings(options))
app.add_handlers('.*$', [(r'/main-under-test.js', MainJsHandler)])
app.listen(PORT, '127.0.0.1')
print('serving on http://127.0.0.1:%d/' % PORT)
loop.start()
