"""Run the browser-side page regression (tests/browser/page_test.js).

Starts local SSH servers (one per page load, matching the Python suite)
and a real Tornado application rendering the connection page, then drives
jsdom against them so the actual Tornado template, static assets and
main.js are exercised end to end.

Usage:
    python tests/browser/page_server.py
"""
import os
import subprocess
import sys
import threading

import tornado.ioloop

from tornado.options import options
from webssh.main import make_app, make_handlers
from webssh.settings import get_app_settings, get_server_settings
from tests.sshserver import run_ssh_server

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def start_web_app(web_port):
    loop = tornado.ioloop.IOLoop()

    for key, value in [
        ('policy', 'autoadd'),
        ('hostfile', ''),
        ('syshostfile', ''),
        ('tdstream', ''),
        ('maxconn', 20),
        ('origin', 'same'),
        ('debug', False),
        ('xsrf', False),
        ('delay', 30.0),
        ('wpintvl', 0.0),
    ]:
        setattr(options, key, value)

    app = make_app(make_handlers(loop, options), get_app_settings(options))
    app.listen(web_port, '127.0.0.1', **get_server_settings(options))
    loop.start()


def main():
    ssh_port = int(os.environ.get('WEBSSH_SSH_PORT', '2299'))
    ssh_port2 = int(os.environ.get('WEBSSH_SSH_PORT2', str(ssh_port + 1)))
    web_port = int(os.environ.get('WEBSSH_WEB_PORT', '8899'))

    for port in (ssh_port, ssh_port2):
        # the shell loop keeps each accepted session alive, so use a separate
        # single-connection server thread per browser page load
        t = threading.Thread(
            target=run_ssh_server,
            args=(port, True, ['UTF-8', 'UTF-8'])
        )
        t.daemon = True
        t.start()

    web_thread = threading.Thread(target=start_web_app, args=(web_port,))
    web_thread.daemon = True
    web_thread.start()

    # give the listener a moment before the node client connects
    import time
    time.sleep(1)

    env = dict(os.environ)
    env['WEBSSH_URL'] = 'http://127.0.0.1:{}/'.format(web_port)
    env['WEBSSH_SSH_PORT'] = str(ssh_port)
    env['WEBSSH_SSH_PORT2'] = str(ssh_port2)

    node = subprocess.Popen(
        ['node', os.path.join(BASE_DIR, 'page_test.js')],
        cwd=BASE_DIR, env=env
    )
    sys.exit(node.wait())


if __name__ == '__main__':
    main()
