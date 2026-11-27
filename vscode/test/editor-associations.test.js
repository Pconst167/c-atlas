'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasGraphFileAssociation, registerEditorAssociationCommands } = require('../editor-associations');

function fixture({ user = {}, workspace } = {}) {
  const state = new Map(), commands = new Map(), errors = [];
  const config = {
    workspace,
    get: () => ({ ...user, ...config.workspace }),
    inspect: () => ({ workspaceValue: config.workspace }),
    update: async (key, value, target) => {
      assert.equal(key, 'editorAssociations');
      assert.equal(target, 2);
      config.workspace = value;
    }
  };
  registerEditorAssociationCommands({
    workspace: { workspaceFolders: [{}], getConfiguration: () => config },
    commands: { registerCommand: (id, run) => commands.set(id, run) },
    ConfigurationTarget: { Workspace: 2 },
    window: { showInformationMessage() {}, showErrorMessage: text => errors.push(text) }
  }, {
    subscriptions: [],
    workspaceState: {
      get: (key, fallback) => state.get(key) ?? fallback,
      update: async (key, value) => value === undefined ? state.delete(key) : state.set(key, value)
    }
  });
  return { config, state, errors, enable: commands.get('cAtlas.enableExplorerGraph'), disable: commands.get('cAtlas.disableExplorerGraph') };
}

test('workspace opt-in preserves user mappings, specific file overrides and later workspace edits', async () => {
  const workspace = { '*.c': 'default', '*.hh': 'custom.headers', '*.png': 'image', 'special.c': 'handwritten', '*.inc': 'cAtlas.fileGraph' };
  const user = { '*.h': 'other.headers', '*.lua': 'other.lua' };
  const { config, enable, disable } = fixture({ user, workspace });
  await enable();
  await enable();
  assert.equal(config.workspace['*.c'], 'cAtlas.fileGraph');
  assert.equal(config.workspace['*.h'], 'cAtlas.fileGraph');
  assert.equal(config.workspace['*.hh'], 'cAtlas.fileGraph');
  assert.equal(config.workspace['*.lua'], undefined);
  assert.equal(config.workspace['special.c'], 'handwritten');
  config.workspace['*.hh'] = 'user.replacement';
  config.workspace['*.txt'] = 'user.text';
  user['*.h'] = 'new.global.choice';
  await disable();
  assert.deepEqual(config.workspace, { ...workspace, '*.hh': 'user.replacement', '*.txt': 'user.text' });
  assert.equal(config.get()['*.h'], 'new.global.choice');
});

test('re-enabling restores graph opens without overwriting the original backup', async () => {
  const { config, enable, disable } = fixture({ workspace: { '*.c': 'default' } });
  await enable();
  config.workspace['*.c'] = 'other';
  await enable();
  assert.equal(config.workspace['*.c'], 'cAtlas.fileGraph');
  await disable();
  assert.deepEqual(config.workspace, { '*.c': 'default' });
});

test('disabling fully reverts new workspace associations across repeated or overlapping calls', async () => {
  const { config, state, enable, disable } = fixture();
  await Promise.all([enable(), disable(), enable()]);
  assert.equal(config.workspace['*.c'], 'cAtlas.fileGraph');
  assert.equal(config.workspace['*.hpp'], 'cAtlas.fileGraph');
  await disable();
  assert.equal(config.workspace, undefined);
  assert.equal(state.size, 0);
});

test('an unsuccessful settings update is reported and can be retried', async () => {
  const { config, errors, enable, disable } = fixture();
  const update = config.update;
  config.update = async () => { throw Error('Read-only workspace'); };
  await enable();
  assert.match(errors[0], /Read-only workspace/);
  assert.equal(config.workspace, undefined);
  config.update = update;
  await enable();
  assert.equal(config.workspace['*.c'], 'cAtlas.fileGraph');
  await disable();
  assert.equal(config.workspace, undefined);
});

test('the preview follower can recognize file types already handled by the direct opener', () => {
  const vscode = { workspace: { getConfiguration: () => ({ get: () => ({ '*.h': 'cAtlas.fileGraph', '*.c': 'another.editor' }) }) } };
  assert.equal(hasGraphFileAssociation(vscode, { path: '/project/nested/header.H' }), true);
  assert.equal(hasGraphFileAssociation(vscode, { path: '/project/source.c' }), false);
  assert.equal(hasGraphFileAssociation(vscode, { path: '/project/sprite.png' }), false);
});
