/* Regression test for terminal OUTPUT decoding.
 *
 * Loads the real page rendered by Tornado (real main.js / xterm assets),
 * drives a connection, then delivers remote output as two binary
 * WebSocket messages that split the three UTF-8 bytes of "你" across the
 * frame boundary:  [e4] then [bd a0].  xterm must receive a single "你",
 * not three replacement characters.  A second fresh connection must not
 * inherit the first connection's dangling bytes.
 *
 * The Tornado server and a local SSH server are started by page_server.py;
 * this script only plays the browser role using jsdom.
 */
'use strict';

const path = require('path');
const { JSDOM, ResourceLoader, VirtualConsole } = require(path.join(__dirname, 'node_modules', 'jsdom'));

const BASE_URL = process.env.WEBSSH_URL;
if (!BASE_URL) {
  console.error('WEBSSH_URL is not set; start via page_server.py');
  process.exit(2);
}

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log('PASS: ' + name);
  } else {
    failures += 1;
    console.error('FAIL: ' + name + (detail ? ' -- ' + detail : ''));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Capture every fake WebSocket instance main.js creates so the test can
// deliver binary messages as Blobs, exactly like a real browser receives
// binary frames.
const createdSockets = [];

function installBrowserFakes(window) {
  const written = [];
  let terminalInstance = null;

  // Minimal stand-in for window.Terminal from xterm.min.js.  It records
  // every string the page feeds to term.write().
  class FakeTerminal {
    constructor(options) {
      this.options = options || {};
      this.cols = 80;
      this.rows = 24;
      this.resized = false;
      this.dataHandlers = [];
      terminalInstance = this;
    }
    loadAddon() {}
    open() {}
    focus() {}
    write(text) {
      written.push(String(text));
    }
    onData(fn) {
      this.dataHandlers.push(fn);
    }
    resize(cols, rows) {
      this.cols = cols;
      this.rows = rows;
    }
    setOption() {}
    getOption(name) {
      if (name === 'fontFamily') {
        return 'monospace';
      }
    }
    dispose() {
      written.push('<<DISPOSED>>');
    }
    // stubs used by main.js geometry code
    get _core() {
      const self = this;
      return {
        _renderService: {
          _renderer: {
            dimensions: { actualCellWidth: 8, actualCellHeight: 16 }
          }
        }
      };
    }
  }

  class FakeFitAddon {
    fit() {}
  }

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      this.sent = [];
      createdSockets.push(this);
      // main.js sends the first resize/command only after open
      process.nextTick(() => {
        this.readyState = 1;
        if (this.onopen) {
          this.onopen({});
        }
      });
    }
    send(data) {
      this.sent.push(data);
    }
    close(code, reason) {
      if (this.readyState === 3) {
        return;
      }
      this.readyState = 3;
      if (this.onclose) {
        this.onclose({ code: code || 1000, reason: reason || '' });
      }
    }
    deliver(blob) {
      if (this.onmessage) {
        this.onmessage({ data: blob });
      }
    }
  }

  window.Terminal = FakeTerminal;
  window.FitAddon = { FitAddon: FakeFitAddon };
  window.WebSocket = FakeWebSocket;
  // jsdom does not implement the WHATWG encoding globals, but every real
  // browser supported by the page does; provide Node's identical impl so
  // the page uses its TextDecoder streaming path instead of the legacy
  // FileReader.readAsText fallback.
  window.TextDecoder = TextDecoder;
  window.TextEncoder = TextEncoder;
  return {
    get written() {
      return written;
    },
    get terminal() {
      return terminalInstance;
    }
  };
}

async function loadPage() {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => {
    // Resource errors for optional assets would show up here; record them.
    console.error('page jsdomError:', err && err.message ? err.message : err);
    failures += 1;
  });
  virtualConsole.on('error', (...args) => {
    console.error('page console.error:', ...args);
    failures += 1;
  });

  // Load the real jQuery/bootstrap and the real main.js from the Tornado
  // server, but neutralize xterm itself: beforeParse injects a recording
  // Terminal stand-in, and letting the xterm UMD bundle run would overwrite
  // it (and require a real rendering backend jsdom does not provide).
  class NeutralizeXtermLoader extends ResourceLoader {
    fetch(url, options) {
      if (/xterm(\.min)?\.js$|xterm-addon-fit\.min\.js$/.test(url)) {
        return Promise.resolve(Buffer.from('/* neutralized in test */'));
      }
      return super.fetch(url, options);
    }
  }

  let terminalApi;
  const dom = await JSDOM.fromURL(BASE_URL, {
    runScripts: 'dangerously',
    resources: new NeutralizeXtermLoader(),
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      terminalApi = installBrowserFakes(window);
    }
  });

  // wait for jQuery ready callbacks + asset execution
  await sleep(500);
  return { dom, terminalApi };
}

async function connectAndGetSocket(window, username, sshPort) {
  // Drive the exact code path used by the real connect form, only skipping
  // the form DOM plumbing: wssh.connect() posts to Tornado, receives the
  // session id, and opens the (fake) WebSocket.
  const socketIndex = createdSockets.length;
  await window.eval(
    'wssh.connect({hostname: "127.0.0.1", port: ' +
      JSON.stringify(String(sshPort || process.env.WEBSSH_SSH_PORT || '')) +
      ', username: ' + JSON.stringify(username) +
      ', password: "foo", _xsrf: "yummy"})'
  );

  let socket = null;
  // wait specifically for THIS connection's socket; earlier page loads
  // left closed sockets in createdSockets which must not be reused
  for (let i = 0; i < 100 && !socket; i++) {
    await sleep(50);
    socket = createdSockets[socketIndex] || null;
  }
  if (!socket) {
    throw new Error('page never opened a WebSocket');
  }
  // consume banner bytes the page already fed to the terminal
  await sleep(200);
  return socket;
}

function makeBlob(window, bytes) {
  return new window.Blob([new window.Uint8Array(bytes)]);
}

async function run() {
  const { dom, terminalApi } = await loadPage();
  const window = dom.window;

  check('page script loaded without errors (wssh present)',
        typeof window.wssh === 'object' && typeof window.wssh.connect === 'function');

  // ---- first session: a character split across two binary messages ----
  const socket = await connectAndGetSocket(window, 'page');

  const before = terminalApi.written.slice();
  // remote output arrives as two separate binary frames:
  // frame 1 = e4, frame 2 = bd a0  (together they are "你")
  socket.deliver(makeBlob(window, [0xe4]));
  await sleep(100);
  socket.deliver(makeBlob(window, [0xbd, 0xa0]));
  await sleep(100);

  const delta = terminalApi.written.slice(before.length);
  const joined = delta.join('');
  check('split binary frames decode to a single "你"',
        joined === '你',
        'term.write received ' + JSON.stringify(delta));
  check('no replacement characters for the split character',
        joined.indexOf('�') === -1,
        JSON.stringify(delta));

  // plain single-byte output still works after multibyte output
  const beforeAscii = terminalApi.written.length;
  socket.deliver(makeBlob(window, [0x4f, 0x4b])); // "OK"
  await sleep(100);
  const asciiDelta = terminalApi.written.slice(beforeAscii).join('');
  check('plain ascii binary frame still displays', asciiDelta === 'OK',
        JSON.stringify(asciiDelta));

  // multibyte character followed by trailing ascii, with the split landing
  // differently: frame 1 = e4 bd, frame 2 = a0 0x41 ("你A")
  const before2 = terminalApi.written.length;
  socket.deliver(makeBlob(window, [0xe4, 0xbd]));
  await sleep(100);
  const danglingWrites = terminalApi.written.slice(before2).join('');
  check('dangling multibyte prefix emits no replacement char',
        danglingWrites === '',
        JSON.stringify(danglingWrites));
  socket.deliver(makeBlob(window, [0xa0, 0x41]));
  await sleep(100);
  const joined2 = terminalApi.written.slice(before2).join('');
  check('split frames containing "你A" decode in order',
        joined2 === '你A', JSON.stringify(joined2));

  // ---- session isolation: a brand new page/connection must start with
  // an empty byte buffer and never see the previous session's dangling
  // bytes.  The page itself supports one connection per load, exactly as
  // a browser reload between SSH sessions does.
  socket.close(1000, 'bye');
  await sleep(300);
  dom.window.close();
  await sleep(200);

  const next = await loadPage();
  const socket2 = await connectAndGetSocket(
    next.dom.window, 'page', process.env.WEBSSH_SSH_PORT2);
  await sleep(100);

  const before3 = next.terminalApi.written.length;
  // a different continuation than the previous session's dangling e4; if
  // that byte leaked across sessions this would produce garbage
  socket2.deliver(makeBlob(next.dom.window, [0xe4]));
  await sleep(100);
  socket2.deliver(makeBlob(next.dom.window, [0xbd, 0xa0, 0x0a]));
  await sleep(100);
  const joined3 = next.terminalApi.written.slice(before3).join('');
  check('new session decodes only its own bytes ("你\\n")',
        joined3 === '你\n', JSON.stringify(joined3));

  socket2.close(1000, 'bye');
  await sleep(100);
  next.dom.window.close();

  if (failures) {
    console.error('\n' + failures + ' browser regression check(s) failed');
    process.exit(1);
  }
  console.log('\nAll browser regression checks passed');
}

run().catch((err) => {
  console.error('harness error:', err);
  process.exit(1);
});
