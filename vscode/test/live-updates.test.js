'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');

function signal() {
  const listeners = new Set();
  function subscribe(callback) {
    listeners.add(callback);
    return { dispose: () => listeners.delete(callback) };
  }
  subscribe.emit = value => Promise.all([...listeners].map(callback => callback(value)));
  return subscribe;
}

async function until(predicate) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (predicate()) return;
    await pause(10);
  }
  assert.fail('Timed out waiting for the graph');
}

test('only the latest editor version is displayed, including after a hidden panel is reopened', async () => {
  class Uri {
    constructor(pathname) { this.path = pathname; }
    toString() { return 'file://' + this.path; }
    static joinPath(uri, name) { return new Uri(uri.path + '/' + name); }
  }
  const folder = { name: 'fixture', uri: new Uri('/fixture') };
  const source = new Uri('/fixture/main.c');
  const context = {
    subscriptions: [], extensionUri: new Uri(path.resolve(__dirname, '..')),
    extensionPath: path.resolve(__dirname, '..'), workspaceState: { keys: () => [] }
  };
  const messages = [], builds = [], errors = [];
  const panel = {
    visible: true, reveal() {}, onDidDispose: signal(), onDidChangeViewState: signal(),
    dispose() { this.onDidDispose.emit(); },
    webview: {
      asWebviewUri: uri => uri, cspSource: 'fixture:', onDidReceiveMessage: signal(),
      postMessage: async message => { messages.push(message); return true; }
    }
  };
  const workspace = {
    workspaceFolders: [folder], getWorkspaceFolder: () => folder, asRelativePath: () => 'main.c',
    onDidChangeTextDocument: signal(), onDidSaveTextDocument: signal(), onDidCloseTextDocument: signal(),
    onDidRenameFiles: signal(), onDidChangeConfiguration: signal(), onDidChangeWorkspaceFolders: signal(),
    createFileSystemWatcher: () => ({ dispose() {}, onDidChange: signal(), onDidCreate: signal(), onDidDelete: signal() })
  };
  let explore;
  const vscode = {
    Uri, workspace, ViewColumn: { Active: 1 }, RelativePattern: class {},
    commands: { registerCommand(name, callback) { if (name === "cAtlas.exploreWorkspace") explore = callback; return { dispose() {} }; } },
    window: { tabGroups: { all: [], onDidChangeTabs: signal(), onDidChangeTabGroups: signal() }, createWebviewPanel: () => panel, showErrorMessage: error => errors.push(error) },
    CancellationTokenSource: class {
      token = { isCancellationRequested: false };
      cancel() { this.token.isCancellationRequested = true; }
      dispose() {}
    }
  };
  const indexer = {
    build: token => new Promise(resolve => builds.push({ token, resolve: version => resolve({
      project: { version }, sources: new Map([['main.c', source]])
    }) }))
  };
  const load = Module._load;
  let extension;
  try {
    Module._load = function(name, ...args) {
      if (name === 'vscode') return vscode;
      if (name === './workspace-index') return { createWorkspaceIndexer: () => indexer, isProjectSource: () => true };
      return load.call(this, name, ...args);
    };
    extension = require('../extension');
  } finally { Module._load = load; }

  extension.activate(context);
  const edit = () => workspace.onDidChangeTextDocument.emit({ contentChanges: ['edit'], document: { uri: source } });
  const versions = () => messages.filter(message => message.type === 'project').map(message => message.project.version);
  try {
    await explore(folder.uri);
    await panel.webview.onDidReceiveMessage.emit({ type: 'ready' });
    await until(() => builds.length === 1);
    await edit();
    await edit();
    assert.equal(builds[0].token.isCancellationRequested, true);
    await until(() => builds.length === 2);
    builds[1].resolve(2);
    await until(() => versions().length === 1);
    builds[0].resolve(1);
    await pause(0);
    assert.deepEqual(versions(), [2]);

    panel.visible = false;
    await edit();
    await pause(400);
    assert.equal(builds.length, 2);
    panel.visible = true;
    await panel.onDidChangeViewState.emit();
    await until(() => builds.length === 3);
    builds[2].resolve(3);
    await until(() => versions().length === 2);
    assert.deepEqual(versions(), [2, 3]);
    assert.deepEqual(errors, []);
  } finally { for (const subscription of context.subscriptions) subscription.dispose(); }
});
