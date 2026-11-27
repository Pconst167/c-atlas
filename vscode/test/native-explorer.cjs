'use strict';

// VS Code calls run() via --extensionTestsPath. Start with a new empty folder
// made by mktemp -d -t c-atlas-explorer-XXXXXXXX and a separate --user-data-dir.
// The built-in vscode.open command exercises native editor and tab activation.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const groups = vscode.window.tabGroups;
const activeTab = () => groups.activeTabGroup?.activeTab;
const graphActive = () => activeTab()?.input instanceof vscode.TabInputWebview
  && activeTab().label.startsWith('C Atlas · ');
const matchesFile = (tab, uri) => tab?.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString();
const findFileTab = uri => groups.all.flatMap(group => group.tabs).find(tab => matchesFile(tab, uri));

async function waitFor(description, condition) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await delay(50);
  }
  const visible = groups.all.map(group => group.tabs.map(tab =>
    [tab.label, tab.isActive ? 'active' : '', tab.isDirty ? 'dirty' : '', tab.isPreview ? 'preview' : ''].filter(Boolean).join(' ')
  ).join(', ')).join(' | ');
  assert.fail(`Timed out waiting for ${description}. Open tabs: ${visible}`);
}

async function run() {
  const folders = vscode.workspace.workspaceFolders;
  assert.equal(folders?.length, 1, 'Open one empty temporary test workspace.');
  const folder = folders[0].uri;
  assert.equal(folder.scheme, 'file');
  const directory = await fs.realpath(folder.fsPath);
  assert.equal(path.dirname(directory), await fs.realpath(os.tmpdir()), 'Run in a temporary workspace.');
  assert.match(path.basename(directory), /^c-atlas-explorer-[a-zA-Z0-9]+$/);
  assert.deepEqual(await fs.readdir(directory), [], 'Refusing to write into a nonempty workspace.');

  async function source(filename, contents) {
    const uri = vscode.Uri.joinPath(folder, filename);
    await fs.writeFile(uri.fsPath, contents, { flag: 'wx' });
    return uri;
  }
  const existingFile = await source('main.c', '#include "engine.h"\nint main(void) { return run_engine(); }\n');
  const freshFile = await source('engine.h', 'int run_engine(void);\n');
  const regularFile = await source('engine.c', 'int run_engine(void) { return 0; }\n');
  const editFile = await source('edit.c', 'int editing(void) { return 1; }\n');
  const config = vscode.workspace.getConfiguration('workbench.editor', folder);
  await config.update('enablePreview', true, vscode.ConfigurationTarget.Workspace);

  async function open(uri, options) {
    let activated = false;
    const observe = () => { if (matchesFile(activeTab(), uri)) activated = true; };
    const listeners = [groups.onDidChangeTabs(observe), groups.onDidChangeTabGroups(observe)];
    try {
      await vscode.commands.executeCommand('vscode.open', uri, options);
      observe();
      await waitFor('native activation of ' + path.basename(uri.fsPath), () => activated);
    } finally {
      for (const listener of listeners) listener.dispose();
    }
  }
  await open(existingFile, { preview: false });
  await waitFor('existing source editor', () => matchesFile(activeTab(), existingFile));
  await vscode.commands.executeCommand('cAtlas.exploreWorkspace', folder);
  await waitFor('C Atlas tab', graphActive);

  // Opening this existing editor sends no new-tab event.
  await open(existingFile, { preserveFocus: true });
  await waitFor('graph to follow the existing editor', graphActive);
  assert.ok(findFileTab(existingFile), 'Following an existing editor must keep its tab.');

  await open(freshFile, { preserveFocus: true, preview: true });
  await waitFor('new preview to be acknowledged and closed', () => graphActive() && !findFileTab(freshFile));

  await config.update('enablePreview', false, vscode.ConfigurationTarget.Workspace);
  await open(regularFile, { preserveFocus: true, preview: false });
  await waitFor('graph to follow with previews disabled', () => graphActive() && findFileTab(regularFile));
  assert.equal(findFileTab(regularFile).isPreview, false);

  await config.update('enablePreview', true, vscode.ConfigurationTarget.Workspace);
  const editor = await vscode.window.showTextDocument(editFile, { preview: true });
  try {
    assert.ok(await editor.edit(edit => edit.insert(new vscode.Position(0, 0), '// unsaved\n')));
    // Wait past the follower's debounce so a premature redirect or closure would be observable.
    await delay(1000);
    assert.equal(editor.document.isDirty, true);
    assert.ok(matchesFile(activeTab(), editFile), 'Typing into a source preview must keep it active.');
  } finally {
    if (editor.document.isDirty) await editor.document.save();
  }
  console.log('C Atlas native editor navigation passed.');
}

module.exports = { run };
