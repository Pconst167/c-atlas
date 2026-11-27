'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setImmediate: afterOpen } = require('node:timers/promises');
const { registerFileOpener } = require('../file-opener');

function fixture(graph) {
  const uri = new URL('file:///project/src/main.c');
  const document = { uri, isDirty: false };
  class TabInputText { constructor() { this.uri = uri; } }
  class TabInputCustom {
    constructor() { this.uri = uri; this.viewType = 'cAtlas.fileGraph'; }
  }
  const opener = { isPreview: true, input: new TabInputCustom() };
  const group = { viewColumn: 2, tabs: [opener], activeTab: opener };
  const visibleTextEditors = [];
  const errors = [], commands = [];
  let resolveEditor, disposed = false, onDispose, visibility;
  const token = { isCancellationRequested: false };
  const panel = {
    webview: {}, active: true, viewColumn: 2,
    onDidChangeViewState(listener) { visibility = listener; return { dispose() { visibility = undefined; } }; },
    onDidDispose(listener) { onDispose = listener; },
    dispose() {
      assert.equal(disposed, false);
      disposed = true;
      group.tabs = group.tabs.filter(tab => tab !== opener);
      onDispose();
    }
  };
  const registration = { dispose() {} };
  let commandError;
  const vscode = {
    TabInputCustom, TabInputText, window: {
      tabGroups: { all: [group], activeTabGroup: group }, visibleTextEditors,
      showErrorMessage: text => errors.push(text),
      registerCustomEditorProvider(id, provider) {
        assert.equal(id, 'cAtlas.fileGraph');
        resolveEditor = provider.resolveCustomTextEditor;
        return registration;
      }
    },
    commands: {
      async executeCommand(...args) {
        commands.push(args);
        if (commandError) throw commandError;
        const text = { input: new TabInputText() };
        group.tabs.push(text);
        group.activeTab = text;
        visibleTextEditors.push({ document, viewColumn: 2 });
      }
    }
  };
  assert.equal(registerFileOpener(vscode, () => graph), registration);
  return {
    uri, document, panel, group, opener, token, commands, errors, visibleTextEditors,
    addTextTab() { group.tabs.push({ input: new TabInputText() }); },
    get disposed() { return disposed; }, set commandError(value) { commandError = value; },
    resolve() { return resolveEditor(document, panel, token); },
    activate() { panel.active = true; group.activeTab = opener; visibility(); }
  };
}

test('an association uses the existing graph and releases its own temporary tab only after the reveal', async () => {
  let finish, isCurrent;
  const example = fixture({ routeFile(uri, current) {
    assert.equal(uri, example.uri);
    isCurrent = current;
    return new Promise(resolve => { finish = resolve; });
  } });
  assert.equal(example.resolve(), undefined, 'the workbench must first finish opening this editor');
  await afterOpen();
  assert.equal(isCurrent(), true);
  assert.equal(example.disposed, false);
  finish('shown');
  await afterOpen();
  assert.equal(example.disposed, true);
  assert.deepEqual(example.commands, []);
});

test('without a workspace graph the association opens the real text editor in the original column', async () => {
  const example = fixture();
  example.opener.isPreview = false;
  example.resolve();
  await afterOpen();
  assert.deepEqual(example.commands, [['vscode.openWith', example.uri, 'default', { viewColumn: 2, preview: false }]]);
  assert.equal(example.disposed, true);
  assert.equal(example.group.tabs.length, 1);
});

test('the source fallback suppresses following for excluded and unsaved files and keeps their text tab', async () => {
  for (const dirty of [false, true]) {
    let routes = 0, nativeEditor;
    const example = fixture({
      routeFile() { routes++; return 'unavailable'; },
      async showSource(uri, open) { assert.equal(uri, example.uri); nativeEditor = await open(); }
    });
    example.document.isDirty = dirty;
    example.resolve();
    await afterOpen();
    assert.equal(routes, dirty ? 0 : 1);
    assert.equal(nativeEditor, example.visibleTextEditors[0]);
    assert.equal(example.commands[0][3].preview, true);
    assert.equal(example.disposed, true);
    assert.equal(example.group.tabs.length, 1);
  }
});

test('following a file already open for editing preserves its unsaved text tab', async () => {
  const example = fixture({ routeFile: async () => 'shown' });
  example.document.isDirty = true;
  example.addTextTab();
  example.resolve();
  await afterOpen();
  assert.equal(example.disposed, true);
  assert.equal(example.group.tabs.length, 1);
  assert.equal(example.document.isDirty, true);
  assert.deepEqual(example.commands, []);
});

test('a superseded or closed file cannot navigate or refocus the text editor', async () => {
  let finish, current;
  const example = fixture({ routeFile(uri, callback) {
    current = callback;
    return new Promise(resolve => { finish = resolve; });
  } });
  example.resolve();
  await afterOpen();
  example.panel.active = false;
  example.group.activeTab = {};
  assert.equal(current(), false);
  finish('superseded');
  await afterOpen();
  assert.equal(example.disposed, true);
  assert.equal(example.commands.length, 0);

  const closed = fixture();
  closed.resolve();
  closed.panel.dispose();
  await afterOpen();
  assert.equal(closed.commands.length, 0);
});

test('a restored background tab waits until selected, and text-open failure keeps the document accessible', async () => {
  const example = fixture();
  example.panel.active = false;
  example.group.activeTab = {};
  example.document.isDirty = true;
  example.commandError = new Error('Workspace unavailable');
  example.resolve();
  await afterOpen();
  assert.equal(example.commands.length, 0);
  example.activate();
  await afterOpen();
  assert.equal(example.commands.length, 1);
  assert.equal(example.disposed, false);
  assert.equal(example.errors.length, 1);
  assert.match(example.panel.webview.html, /Text Editor/);
});
