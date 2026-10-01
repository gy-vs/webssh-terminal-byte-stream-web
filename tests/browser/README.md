# Browser-side page regression tests

These tests exercise the **actual** page rendered by Tornado: the real
`index.html` template, the real `static/js/main.js` and jQuery/bootstrap
assets are loaded by [jsdom](https://github.com/jsdom/jsdom). The xterm
renderer itself is neutralized (jsdom has no terminal rendering backend) and
replaced by a recording stand-in that captures every string passed to
`term.write()`.

## What is covered

`page_test.js` connects through the real connect form code path
(`wssh.connect(...)` → Tornado POST → WebSocket session) and then delivers
remote output as separate **binary** WebSocket messages that split a
multibyte UTF-8 character across frame boundaries:

* frame 1: `e4`, frame 2: `bd a0` → xterm must see one `你`, not
  `�` + `��`;
* a dangling `e4 bd` prefix emits nothing until `a0 41` completes `你A`;
* plain ASCII frames keep working;
* a second, freshly loaded page/session starts with an empty byte buffer and
  never sees the previous session's dangling bytes.

## Running

Install the only dependency once:

```sh
cd tests/browser
npm install
```

Then run the whole thing (it starts the SSH test servers and the Tornado app
itself):

```sh
PYTHONPATH=/workspace python tests/browser/page_server.py
```

`page_server.py` exits non-zero if any check fails.
