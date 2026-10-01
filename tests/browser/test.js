const puppeteer = require('puppeteer');

const BASE = 'http://127.0.0.1:8899/';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function drivePage(version) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();

  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {
    if (m.type() === 'error') errors.push(m.text());
  });

  // wrapper prepended to the main.js response: it runs after xterm.min.js
  // (so window.Terminal exists) but before main.js code, and records every
  // string handed to xterm by term.write plus the terminal instance
  const HARNESS = `
    (function () {
      window.__terms = [];
      var RealTerminal = window.Terminal;
      function Wrapped(options) {
        var term = new RealTerminal(options);
        Object.setPrototypeOf(term, Wrapped.prototype);
        term.__writes = [];
        term.__dataHandlers = [];
        window.__terms.push(term);
        return term;
      }
      Wrapped.prototype = Object.create(RealTerminal.prototype);
      Wrapped.prototype.constructor = Wrapped;
      function realMethod(term, name) {
        // xterm exposes write/onData through prototype getters; invoke the
        // getter with the instance as receiver to get the real function
        var desc = Object.getOwnPropertyDescriptor(
          RealTerminal.prototype, name
        );
        return desc.get ? desc.get.call(term) : desc.value;
      }
      Object.defineProperty(Wrapped.prototype, 'write', {
        configurable: true,
        value: function (data) {
          this.__writes.push(data);
          return realMethod(this, 'write').call(this, data);
        }
      });
      Object.defineProperty(Wrapped.prototype, 'onData', {
        configurable: true,
        value: function (fn) {
          this.__dataHandlers.push(fn);
          return realMethod(this, 'onData').call(this, fn);
        }
      });
      window.Terminal = Wrapped;
    }());
  `;

  // swap the real main.js for the version under test, prepending the harness
  await page.setRequestInterception(true);
  page.on('request', async req => {
    if (req.url().endsWith('/static/js/main.js')) {
      const resp = await fetch(BASE + 'main-under-test.js?v=' + version);
      const body = HARNESS + (await resp.text());
      return req.respond({
        status: 200,
        contentType: 'application/javascript',
        body,
      });
    }
    req.continue();
  });

  // the real Tornado-rendered index page
  await page.goto(BASE, { waitUntil: 'networkidle0' });

  await page.evaluate(() => {
    window.__drivers = [];
    function FakeWS(url) {
      this.readyState = 0;
      this.url = url;
      this.sent = [];
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      window.__drivers.push(this);
    }
    FakeWS.prototype.send = function (d) { this.sent.push(d); };
    FakeWS.prototype.close = function (code, reason) {
      this.readyState = 3;
      if (this.onclose) this.onclose({ code: code || 1000, reason: reason || '' });
    };
    window.WebSocket = FakeWS;

    document.getElementById('hostname').value = '127.0.0.1';
    document.getElementById('port').value = '22';
    document.getElementById('username').value = 'robey';
    window.$.ajax = function (opts) {
      opts.complete({
        status: 200,
        statusText: 'OK',
        responseJSON: { id: 'test-id', encoding: 'utf-8', status: null },
      });
    };
    window.wssh.connect();
  });

  await page.waitForFunction(() => window.__drivers.length === 1);
  await page.evaluate(() => {
    const s = window.__drivers[0];
    s.readyState = 1;
    if (s.onopen) s.onopen();
  });
  await page.waitForFunction(() => window.__terms.length === 1);
  await sleep(300);

  // two binary messages: e4 | bd a0, splitting '你' (e4 bd a0)
  await page.evaluate(() => {
    const s = window.__drivers[0];
    s.onmessage({ data: new Blob([new Uint8Array([0xe4])]) });
    s.onmessage({ data: new Blob([new Uint8Array([0xbd, 0xa0])]) });
    // ordinary single-byte output following the multibyte character
    s.onmessage({ data: new Blob([new TextEncoder().encode('A\r\n')]) });
  });
  await sleep(300);

  // existing resize behaviour still goes out on the websocket
  await page.evaluate(() => {
    const term = window.__terms[0];
    term.on_resize(40, 10);
  });
  await sleep(50);

  const readSession = async (idx) => page.evaluate((idx) => {
    const term = window.__terms[idx];
    const writeText = term.__writes.join('');
    let bufText = '';
    try {
      // xterm 4.x exposes getLine directly on term.buffer
      const buf = term.buffer.active || term.buffer;
      const line = buf.getLine(0);
      bufText = line ? line.translateToString(true) : '';
    } catch (e) {
      bufText = '<buffer error: ' + e + '>';
    }
    return { writeText, bufText };
  }, idx);

  const session1 = await readSession(0);

  const session1Sent = await page.evaluate(() =>
    window.__drivers[0].sent.slice());

  // typed input still uses the existing {data: ...} json message; emit via
  // the onData handler main.js registered with xterm
  await page.evaluate(() => {
    window.__terms[0].__dataHandlers.forEach(fn => fn('你A'));
  });
  const sentAfterType = await page.evaluate(() =>
    window.__drivers[0].sent.slice());

  // close the session; a dangling half-character must not survive reconnect
  await page.evaluate(() => {
    window.__drivers[0].close(1000, 'client disconnected');
  });
  await sleep(400);

  await page.evaluate(() => { window.wssh.connect(); });
  await page.waitForFunction(() => window.__drivers.length === 2);
  await page.evaluate(() => {
    const s = window.__drivers[window.__drivers.length - 1];
    s.readyState = 1;
    if (s.onopen) s.onopen();
  });
  await page.waitForFunction(() => window.__terms.length === 2);
  await sleep(300);

  // new session receives only bd a0: invalid on its own, must not combine
  // with the unfinished e4 of the previous (disposed) session
  await page.evaluate(() => {
    const s = window.__drivers[window.__drivers.length - 1];
    s.onmessage({ data: new Blob([new Uint8Array([0xbd, 0xa0])]) });
  });
  await sleep(300);

  const session2 = await readSession(1);

  await browser.close();
  return { session1, session2, session1Sent, sentAfterType, errors };
}

(async () => {
  const fixed = await drivePage('fixed');
  const orig = await drivePage('orig');

  console.log('fixed  term.write sequence after e4|bd a0|A: ' +
      JSON.stringify(Array.from(fixed.session1.writeText).map(c =>
        c === '�' ? 'U+FFFD' : c)));
  console.log('fixed  terminal buffer line 0: ' +
      JSON.stringify(fixed.session1.bufText.trim()));
  console.log('orig   term.write sequence after e4|bd a0: ' +
      JSON.stringify(Array.from(orig.session1.writeText).map(c =>
        c === '�' ? 'U+FFFD' : c)));
  console.log('fixed  new session (bd a0 only) writes: ' +
      JSON.stringify(Array.from(fixed.session2.writeText).map(c =>
        c === '�' ? 'U+FFFD' : c)));

  const failures = [];

  if (fixed.session1.writeText !== '你A\r\n') {
    failures.push('fixed: split bytes + following ascii mismatch, got ' +
        JSON.stringify(fixed.session1.writeText));
  }
  // after 你 A\r\n the characters remain on buffer line 0
  if (fixed.session1.bufText.trim() !== '你A') {
    failures.push('fixed: xterm buffer does not show 你A, got ' +
        JSON.stringify(fixed.session1.bufText));
  }
  if (fixed.session2.writeText.includes('你')) {
    failures.push('previous session bytes leak into new session: ' +
        JSON.stringify(fixed.session2.writeText));
  }

  // existing resize websocket message format is unchanged (the initial fit
  // also sends one, so pick the explicit 40x10 resize)
  const resizeMsgs = fixed.session1Sent
    .map(m => JSON.parse(m).resize)
    .filter(Boolean);
  if (JSON.stringify(resizeMsgs.find(r => r[0] === 40 && r[1] === 10)) !==
      '[40,10]') {
    failures.push('resize message changed: ' +
        JSON.stringify(fixed.session1Sent));
  }
  const newMsgs = fixed.sentAfterType.slice(fixed.session1Sent.length)
    .map(JSON.parse);
  if (JSON.stringify(newMsgs) !== JSON.stringify([{ data: '你A' }])) {
    failures.push('typed input message changed: ' +
        JSON.stringify(newMsgs));
  }

  if (fixed.errors.length) {
    failures.push('browser errors: ' + JSON.stringify(fixed.errors));
  }

  // control: the original page produces exactly three replacement chars
  const origFFFD = (orig.session1.writeText.match(/�/g) || []).length;
  if (origFFFD !== 3) {
    failures.push('control check failed: expected 3 U+FFFD on original ' +
        'page, got ' + origFFFD + ' (' +
        JSON.stringify(orig.session1.writeText) + ')');
  }

  if (failures.length) {
    console.error('FAIL:\n' + failures.join('\n'));
    process.exit(1);
  }
  console.log('PASS');
})().catch(e => { console.error(e); process.exit(1); });
