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

  const graph = groups.all.flatMap(group => group.tabs).find(tab => tab.input instanceof vscode.TabInputWebview
    && tab.label.startsWith('C Atlas · '));
  assert.ok(graph, 'The workspace graph must remain open behind the source tab.');
  await vscode.workspace.getConfiguration('cAtlas', folder).update('followFilePreviews', false, vscode.ConfigurationTarget.Workspace);
  await vscode.commands.executeCommand('cAtlas.enableExplorerGraph');
  try {
    const associations = vscode.workspace.getConfiguration('workbench', folder).get('editorAssociations');
    assert.equal(associations['*.c'], 'cAtlas.fileGraph');
    assert.equal(associations['*.h'], 'cAtlas.fileGraph');
    // Start on a text tab and use an ordinary file open so VS Code resolves the associated editor.
    assert.ok(matchesFile(activeTab(), editFile));
    await vscode.commands.executeCommand('vscode.open', freshFile);
    await waitFor('the original graph to take the associated header', () => activeTab() === graph);
    const openerExists = () => groups.all.some(group => group.tabs.some(tab =>
      tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'cAtlas.fileGraph'));
    await waitFor('the temporary graph opener to close', () => !openerExists());
    assert.equal(findFileTab(freshFile), undefined);

    await groups.close(graph);
    await vscode.commands.executeCommand('vscode.open', freshFile);
    await waitFor('an editable text tab after closing the graph', () =>
      matchesFile(activeTab(), freshFile) && !openerExists()
      && vscode.window.activeTextEditor?.document.uri.toString() === freshFile.toString());
    const sourceEditor = vscode.window.activeTextEditor;
    assert.ok(await sourceEditor.edit(edit => edit.insert(new vscode.Position(0, 0), '// native fallback\n')));
    assert.equal(sourceEditor.document.isDirty, true);
    assert.ok(await sourceEditor.document.save());
  } finally {
    await vscode.commands.executeCommand('cAtlas.disableExplorerGraph');
  }
  console.log('C Atlas native editor navigation passed.');
}

module.exports = { run };
