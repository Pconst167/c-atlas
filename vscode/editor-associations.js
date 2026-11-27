'use strict';

const { extname } = require('node:path').posix;

const editorId = 'cAtlas.fileGraph';
const patterns = ['*.c', '*.h', '*.hh', '*.hpp', '*.hxx', '*.inl', '*.inc'];
const ownershipKey = 'cAtlas.managedEditorAssociations';

function hasGraphFileAssociation(vscode, uri) {
  const pattern = '*' + extname(uri.path).toLowerCase();
  return patterns.includes(pattern) &&
    vscode.workspace.getConfiguration('workbench', uri).get('editorAssociations', {})[pattern] === editorId;
}

function registerEditorAssociationCommands(vscode, context) {
  let pending = Promise.resolve();

  async function configure(enable) {
    if (!vscode.workspace.workspaceFolders?.length) {
      void vscode.window.showInformationMessage('Open a workspace folder to configure its C Atlas file opener.');
      return;
    }
    const configuration = vscode.workspace.getConfiguration('workbench');
    const effective = configuration.get('editorAssociations', {});
    const settings = { ...configuration.inspect('editorAssociations')?.workspaceValue };
    const original = context.workspaceState.get(ownershipKey, {});
    if (enable) {
      const changed = patterns.filter(pattern => effective[pattern] !== editorId);
      if (changed.length) {
        const backup = { ...original };
        for (const pattern of changed) {
          // null means that the previous editor choice came from outside workspace settings.
          if (!Object.hasOwn(backup, pattern)) backup[pattern] = settings[pattern] ?? null;
          settings[pattern] = editorId;
        }
        // If writing settings fails, a retry still has the original workspace choices.
        await context.workspaceState.update(ownershipKey, backup);
        await configuration.update('editorAssociations', settings, vscode.ConfigurationTarget.Workspace);
      }
      void vscode.window.showInformationMessage('C Atlas graph opens are enabled in this workspace.');
      return;
    }

    const restore = patterns.filter(pattern => Object.hasOwn(original, pattern) && settings[pattern] === editorId);
    if (restore.length) {
      for (const pattern of restore) {
        if (original[pattern] === null) delete settings[pattern];
        else settings[pattern] = original[pattern];
      }
      await configuration.update('editorAssociations', Object.keys(settings).length ? settings : undefined, vscode.ConfigurationTarget.Workspace);
    }
    if (Object.keys(original).length) await context.workspaceState.update(ownershipKey, undefined);
    void vscode.window.showInformationMessage('C Atlas has released the file associations it managed in this workspace.');
  }

  function register(id, enable) {
    context.subscriptions.push(vscode.commands.registerCommand(id, () => {
      pending = pending.then(() => configure(enable)).catch(error => {
        void vscode.window.showErrorMessage('Could not update C Atlas file associations. ' + error.message);
      });
      return pending;
    }));
  }
  register('cAtlas.enableExplorerGraph', true);
  register('cAtlas.disableExplorerGraph', false);
}

module.exports = { hasGraphFileAssociation, registerEditorAssociationCommands };
