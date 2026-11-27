'use strict';

const viewType = 'cAtlas.fileGraph';

function registerFileOpener(vscode, lookupGraph) {
  const groups = vscode.window.tabGroups;

  function resolveCustomTextEditor(document, panel, token) {
    const uri = document.uri;
    const sameFile = input => input?.uri?.toString() === uri.toString();
    const sameOpener = tab => tab?.input instanceof vscode.TabInputCustom
      && tab.input.viewType === viewType && sameFile(tab.input);
    let disposed = false;
    let busy = false;

    function current() {
      if (disposed || token.isCancellationRequested) return false;
      const group = groups.activeTabGroup;
      return panel.active || (group?.viewColumn === panel.viewColumn && sameOpener(group.activeTab));
    }

    // Disposing the last editor for an unsaved document can discard its only visible representation.
    function canRetire() {
      return !document.isDirty || groups.all.some(group => group.tabs.some(tab =>
        tab.input instanceof vscode.TabInputText && sameFile(tab.input)));
    }

    function retire() {
      if (!disposed && canRetire()) panel.dispose();
    }

    async function openText(graph) {
      const viewColumn = panel.viewColumn;
      const opener = groups.all.find(group => group.viewColumn === viewColumn)?.tabs.find(sameOpener);
      const options = { viewColumn, preview: opener?.isPreview };
      async function open() {
        await vscode.commands.executeCommand('vscode.openWith', uri, 'default', options);
        return vscode.window.visibleTextEditors.find(editor =>
          sameFile(editor.document) && editor.viewColumn === viewColumn);
      }
      if (graph) await graph.showSource(uri, open);
      else await open();
    }

    async function handoff() {
      if (busy || !current()) return;
      busy = true;
      try {
        const graph = lookupGraph(uri);
        const result = graph && canRetire() ? await graph.routeFile(uri, current) : 'unavailable';
        if (result === 'unavailable' && current()) await openText(lookupGraph(uri));
        retire();
      } catch (error) {
        if (current()) {
          panel.webview.html = '<p>Use <strong>Reopen Editor With…</strong> and choose <strong>Text Editor</strong> to open the source.</p>';
          vscode.window.showErrorMessage('C Atlas could not open this file. ' + error.message);
        } else retire();
      } finally {
        busy = false;
      }
    }

    // Return from the provider first. VS Code is still resolving the custom editor
    // and may need the same group to finish opening the graph or the text editor.
    const queue = () => setImmediate(handoff);
    panel.webview.html = '<p>Opening file…</p>';
    const visibility = panel.onDidChangeViewState(queue);
    panel.onDidDispose(() => { disposed = true; visibility.dispose(); });
    queue();
  }

  return vscode.window.registerCustomEditorProvider(viewType, { resolveCustomTextEditor });
}

module.exports = { registerFileOpener };
