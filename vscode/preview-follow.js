'use strict';

const settleDelay = 400;

function createPreviewFollower(vscode, { accepts, onPreview }) {
  const groups = vscode.window.tabGroups;
  const openingSource = new Set(), sourceTabs = new WeakSet();
  const newlyOpened = new Map();
  const subscriptions = [];
  let pending, disposed = false;

  function matches(tab, uri) {
    return tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString();
  }

  function isCleanPreview(tab, uri) {
    return !disposed && !sourceTabs.has(tab) && tab.isPreview && !tab.isPinned && !tab.isDirty && matches(tab, uri)
      && groups.all.includes(tab.group) && tab.group.tabs.includes(tab) && accepts(uri);
  }

  function active(tab) {
    return groups.activeTabGroup === tab.group && tab.group.activeTab === tab;
  }

  function cancelPending() {
    if (pending) clearTimeout(pending.timer);
    pending = undefined;
  }

  function forgetNew(tab) {
    const candidate = newlyOpened.get(tab);
    if (candidate) clearTimeout(candidate.timer);
    newlyOpened.delete(tab);
  }

  function update() {
    if (pending && (!isCleanPreview(pending.tab, pending.uri) || !active(pending.tab))) cancelPending();
    const tab = groups.activeTabGroup?.activeTab;
    const candidate = newlyOpened.get(tab);
    if (!candidate) return;
    forgetNew(tab);
    const { uri } = candidate;
    if (!isCleanPreview(tab, uri)) return;
    cancelPending();
    pending = candidate;
    // Give VS Code time to promote a double-click or an edit to a regular tab.
    const isCurrent = () => pending === candidate && isCleanPreview(tab, uri) && active(tab);
    candidate.timer = setTimeout(() => {
      if (isCurrent()) onPreview(uri, tab, isCurrent);
      else if (pending === candidate) cancelPending();
    }, settleDelay);
  }

  function releaseSource(opening) {
    clearTimeout(opening.timer);
    openingSource.delete(opening);
  }

  function sourceJump(tab, uri) {
    for (const opening of openingSource) {
      if (opening.key !== uri.toString() || (opening.column !== undefined && opening.column !== tab.group.viewColumn)) continue;
      opening.seen = true;
      sourceTabs.add(tab);
      if (opening.finished) releaseSource(opening);
      return true;
    }
    return false;
  }

  subscriptions.push(groups.onDidChangeTabs(event => {
    for (const tab of event.closed) forgetNew(tab);
    for (const tab of event.opened) {
      if (!(tab.input instanceof vscode.TabInputText)) continue;
      const uri = tab.input.uri;
      if (sourceJump(tab, uri) || !isCleanPreview(tab, uri)) continue;
      // VS Code can report a new tab before reporting that its group is active.
      forgetNew(tab);
      newlyOpened.set(tab, { tab, uri, timer: setTimeout(() => forgetNew(tab), settleDelay) });
    }
    update();
  }), groups.onDidChangeTabGroups(update));

  async function showSource(uri, open) {
    if (pending?.uri.toString() === uri.toString()) cancelPending();
    const opening = { key: uri.toString(), seen: false, finished: false };
    openingSource.add(opening);
    try {
      const editor = await open();
      opening.finished = true;
      opening.column = editor?.viewColumn;
      const tabAlreadyReported = groups.all.find(group => group.viewColumn === opening.column)
        ?.tabs.find(tab => matches(tab, uri));
      if (tabAlreadyReported) sourceTabs.add(tabAlreadyReported);
      if (opening.seen || tabAlreadyReported || disposed) releaseSource(opening);
      // The tab event can arrive just after showTextDocument resolves.
      else opening.timer = setTimeout(() => releaseSource(opening), settleDelay);
      return editor;
    } catch (error) {
      releaseSource(opening);
      throw error;
    }
  }

  function dispose() {
    disposed = true;
    cancelPending();
    for (const tab of newlyOpened.keys()) forgetNew(tab);
    for (const opening of openingSource) releaseSource(opening);
    for (const subscription of subscriptions) subscription.dispose();
  }
  return { dispose, isCleanPreview, showSource };
}

module.exports = { createPreviewFollower };
