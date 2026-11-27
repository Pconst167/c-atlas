'use strict';

const vscode = require('vscode');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createWorkspaceIndexer, isProjectSource } = require('./workspace-index');
const { createPreviewFollower } = require('./preview-follow');
const { registerEditorAssociationCommands, hasGraphFileAssociation } = require('./editor-associations');
const { registerFileOpener } = require('./file-opener');

const editDelay = 350;

function openGraph(context, folder, onClose) {
  const folderUri = folder.uri.toString();
  const workspaceId = crypto.createHash('sha256').update(folderUri).digest('hex');
  const storagePrefix = 'atlas.' + workspaceId + '.';
  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  const template = fs.readFileSync(path.join(context.extensionPath, 'media', 'index.html'), 'utf8');
  const panel = vscode.window.createWebviewPanel('cAtlas.graph', 'C Atlas · ' + folder.name,
    vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] });
  const webview = panel.webview;
  const indexer = createWorkspaceIndexer(folder);
  const subscriptions = [];
  const settings = Object.create(null);
  for (const key of context.workspaceState.keys()) {
    if (key.startsWith(storagePrefix)) settings[key.slice(storagePrefix.length)] = context.workspaceState.get(key);
  }

  let disposed = false, ready = false, pending = true;
  let revision = 0, timer, request;
  let latest = null, delivered = null;
  let navigation = null, nextRequestId = 0;
  const ownsUri = uri => vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === folderUri;
  const { relativePath } = indexer;

  function send(message) {
    return !disposed && ready && webview.postMessage(message);
  }

  function endNavigation(outcome, target = navigation) {
    if (!target || target !== navigation) return;
    navigation = null;
    target.onComplete?.(outcome);
  }

  async function deliver() {
    if (!latest || !ready || disposed || !panel.visible) return;
    const result = latest;
    try {
      if (result !== delivered) {
        delivered = result;
        if (!await send({ type: 'project', project: result.project, name: folder.name, workspaceId, storage: settings })) {
          if (delivered === result) delivered = null;
          if (latest === result && panel.visible) endNavigation('unavailable');
          return;
        }
      }
      const target = navigation;
      if (target?.revealed && !target.sent && latest === result) {
        target.sent = true;
        if (!await send({ type: 'revealFile', path: target.path, requestId: target.id })) {
          target.sent = false;
          if (panel.visible) endNavigation('unavailable', target);
        }
      }
    } catch (error) {
      if (delivered === result) delivered = null;
      if (latest === result) endNavigation('unavailable');
      if (!disposed) vscode.window.showErrorMessage('C Atlas could not display the graph. ' + error.message);
    }
  }

  function prepareNavigation() {
    const target = navigation;
    if (!target || target.revealed || !latest) return;
    if (target.isCurrent && !target.isCurrent()) {
      endNavigation('superseded', target);
      return;
    }
    const removed = settings['c-atlas.folders.workspace.' + workspaceId];
    let isHidden = false;
    if (removed) {
      try {
        const folders = JSON.parse(removed);
        isHidden = Array.isArray(folders) && folders.some(prefix => typeof prefix === 'string' && target.path.startsWith(prefix));
      } catch { /* A malformed saved folder preference is ignored by the graph as well. */ }
    }
    if (!latest.sources.has(target.path) || isHidden) {
      endNavigation('unavailable', target);
      if (!target.tab && !target.onComplete) vscode.window.showInformationMessage('This file is outside the current C Atlas index.');
      return;
    }
    target.revealed = true;
    const keepExplorerFocus = !!target.tab && target.tab.group.viewColumn === panel.viewColumn;
    panel.reveal(panel.viewColumn, keepExplorerFocus);
  }

  function showFile(uri, tab, isCurrent, onComplete) {
    if (!ownsUri(uri) || disposed) {
      onComplete?.('unavailable');
      return;
    }
    endNavigation('superseded');
    navigation = { id: ++nextRequestId, uri, path: relativePath(uri), tab, isCurrent, onComplete, revealed: false, sent: false };
    if (!latest || (!latest.sources.has(navigation.path) && (pending || request))) {
      if (!request || pending) schedule(0);
      return;
    }
    prepareNavigation();
    void deliver();
  }

  async function finishNavigation(message) {
    const target = navigation;
    if (!target?.sent || target.id !== message.requestId || target.path !== message.path) return;
    endNavigation(message.found === true ? 'shown' : 'unavailable', target);
    if (message.found !== true || !target.tab || !panel.visible) return;
    // The editor may have become dirty, been pinned, or been reactivated while the graph was rendering.
    const groups = vscode.window.tabGroups;
    if (groups.activeTabGroup.activeTab !== target.tab && follower.isCleanPreview(target.tab, target.uri)) {
      await groups.close(target.tab, true);
    }
  }

  async function rebuild(version) {
    if (disposed || (!ready && !navigation) || version !== revision) return;
    const active = new vscode.CancellationTokenSource();
    request = active;
    pending = false;
    try {
      if (!latest) await send({ type: 'status', message: 'Indexing ' + folder.name + '…' });
      const result = await indexer.build(active.token);
      if (disposed || active.token.isCancellationRequested || version !== revision) return;
      latest = result;
      prepareNavigation();
      await deliver();
    } catch (error) {
      if (!disposed && !active.token.isCancellationRequested && version === revision) {
        endNavigation('unavailable');
        await send({ type: 'error', message: 'Could not index ' + folder.name + '. ' + error.message });
      }
    } finally {
      if (request === active) request = undefined;
      active.dispose();
    }
  }

  function schedule(delay = editDelay) {
    clearTimeout(timer);
    request?.cancel();
    const version = ++revision;
    pending = true;
    if (!disposed && (navigation || (ready && panel.visible))) timer = setTimeout(() => rebuild(version), delay);
  }

  function relevant(uri) {
    if (!ownsUri(uri)) return false;
    const name = relativePath(uri);
    return isProjectSource(name) || !latest || latest.sources.has(name);
  }

  function filesystemChanged(uri, inventoryChanged) {
    if (!ownsUri(uri) || (!relativePath(uri) && uri.toString() !== folderUri)) return;
    indexer.invalidate(uri, inventoryChanged);
    if (inventoryChanged || relevant(uri)) schedule();
  }

  async function revealSource(message) {
    const uri = latest?.sources.get(message.path);
    if (!uri) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    if (disposed) return;
    const line = Number.isSafeInteger(message.line) ? message.line - 1 : 0;
    const column = Number.isSafeInteger(message.column) ? message.column - 1 : 0;
    const position = doc.validatePosition(new vscode.Position(Math.max(0, line), Math.max(0, column)));
    const editor = await follower.showSource(uri, () => vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: true,
      selection: new vscode.Range(position, position)
    }));
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  const follower = createPreviewFollower(vscode, {
    isGraphActive: () => panel.active,
    accepts: uri => !disposed && ownsUri(uri) && isProjectSource(relativePath(uri))
      && vscode.workspace.getConfiguration('cAtlas', folder.uri).get('followFilePreviews', true)
      && !hasGraphFileAssociation(vscode, uri),
    onPreview: showFile
  });
  subscriptions.push(follower, webview.onDidReceiveMessage(async message => {
    if (!message || typeof message !== 'object' || disposed) return;
    try {
      switch (message.type) {
        case 'ready':
          ready = true;
          delivered = null;
          if (latest) await deliver();
          if (pending) schedule(0);
          break;
        case 'fileRevealed':
          await finishNavigation(message);
          break;
        case 'refresh':
          indexer.reset();
          schedule(0);
          break;
        case 'openSource':
          await revealSource(message);
          break;
        case 'saveSvg': {
          if (typeof message.svg !== 'string') break;
          const proposed = typeof message.name === 'string' ? path.basename(message.name) : 'c-atlas.svg';
          const filename = proposed.replace(/[^\w. -]/g, '_').replace(/\.svg$/i, '') + '.svg';
          const destination = await vscode.window.showSaveDialog({
            title: 'Save C Atlas graph', defaultUri: vscode.Uri.joinPath(folder.uri, filename),
            filters: { 'SVG images': ['svg'] }
          });
          if (destination) await vscode.workspace.fs.writeFile(destination, Buffer.from(message.svg, 'utf8'));
          break;
        }
        case 'storage': {
          const { key, value } = message;
          if (typeof key !== 'string' || !key.startsWith('c-atlas.') || (value !== null && typeof value !== 'string')) break;
          if (value === null) delete settings[key];
          else settings[key] = value;
          await context.workspaceState.update(storagePrefix + key, value === null ? undefined : value);
          break;
        }
      }
    } catch (error) {
      if (!disposed) vscode.window.showErrorMessage('C Atlas: ' + error.message);
    }
  }));
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
  subscriptions.push(watcher, watcher.onDidCreate(uri => filesystemChanged(uri, true)),
    watcher.onDidDelete(uri => filesystemChanged(uri, true)), watcher.onDidChange(uri => filesystemChanged(uri, false)),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.contentChanges.length && relevant(event.document.uri)) schedule();
    }),
    vscode.workspace.onDidSaveTextDocument(doc => filesystemChanged(doc.uri, false)),
    vscode.workspace.onDidCloseTextDocument(doc => {
      if (relevant(doc.uri)) schedule();
    }),
    vscode.workspace.onDidRenameFiles(event => {
      for (const { oldUri, newUri } of event.files) {
        filesystemChanged(oldUri, true);
        filesystemChanged(newUri, true);
      }
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('files.exclude', folder.uri) || event.affectsConfiguration('search.exclude', folder.uri)) {
        indexer.reset(); schedule();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(event => {
      if (event.removed.some(removed => removed.uri.toString() === folderUri)) panel.dispose();
    }),
    panel.onDidChangeViewState(() => {
      if (panel.active) follower.graphActivated();
      if (!panel.visible || !ready) return;
      if (pending) schedule(0);
      void deliver();
    }),
    panel.onDidDispose(() => {
      disposed = true;
      endNavigation('unavailable');
      clearTimeout(timer);
      request?.cancel();
      for (const subscription of subscriptions) subscription.dispose();
      onClose();
    }));
  webview.html = template.replaceAll('{{MEDIA_URI}}', webview.asWebviewUri(media).toString())
    .replaceAll('{{CSP_SOURCE}}', webview.cspSource);
  return {
    panel, showFile, showSource: follower.showSource,
    routeFile: (uri, isCurrent) => new Promise(resolve => showFile(uri, undefined, isCurrent, resolve))
  };
}

function activate(context) {
  const panels = new Map();
  function graphFor(folder) {
    const key = folder.uri.toString();
    if (!panels.has(key)) panels.set(key, openGraph(context, folder, () => panels.delete(key)));
    return panels.get(key);
  }
  registerEditorAssociationCommands(vscode, context);
  context.subscriptions.push(registerFileOpener(vscode, uri => {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return folder && panels.get(folder.uri.toString());
  }));
  context.subscriptions.push({ dispose() { for (const graph of panels.values()) graph.panel.dispose(); } });
  context.subscriptions.push(vscode.commands.registerCommand('cAtlas.exploreWorkspace', async resource => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      vscode.window.showInformationMessage('Open a project folder to explore it with C Atlas.');
      return;
    }
    const folder = resource instanceof vscode.Uri ? vscode.workspace.getWorkspaceFolder(resource) :
      folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Choose a folder to explore with C Atlas' });
    if (folder) graphFor(folder).panel.reveal();
  }));
  context.subscriptions.push(vscode.commands.registerCommand('cAtlas.showFileInGraph', resource => {
    const uri = resource instanceof vscode.Uri ? resource : vscode.window.activeTextEditor?.document.uri;
    const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
    if (folder) graphFor(folder).showFile(uri);
    else vscode.window.showInformationMessage('Select a file in a workspace folder to show it in C Atlas.');
  }));
}

module.exports = { activate };
