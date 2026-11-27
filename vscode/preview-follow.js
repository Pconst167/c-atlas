'use strict';

const settleDelay = 400;

function createPreviewFollower(vscode, { accepts, onPreview, isGraphActive = () => false }) {
  const groups = vscode.window.tabGroups;
  const openingSource = new Set(), sourceTabs = new WeakSet();
  const recentlyOpened = new Map(), closeable = new WeakSet();
  const subscriptions = [];
  let previousTab = groups.activeTabGroup?.activeTab, graphTab, leavingGraph = false;
  let knownResources = textTabs(), pending, disposed = false;

  function matches(tab, uri) {
    return tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString();
  }

  function resourceKey(tab) {
    return tab.group.viewColumn + '\n' + tab.input.uri.toString();
  }

  function textTabs() {
    const resources = new Map();
    for (const group of groups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText) resources.set(resourceKey(tab), tab);
      }
    }
    return resources;
  }

  function graphActivated() {
    leavingGraph = true;
    const tab = groups.activeTabGroup?.activeTab;
    if (tab && !(tab.input instanceof vscode.TabInputText)) graphTab = tab;
  }

  function clean(tab, uri) {
    return !disposed && !sourceTabs.has(tab) && !tab.isPinned && !tab.isDirty && matches(tab, uri)
      && groups.all.includes(tab.group) && tab.group.tabs.includes(tab) && accepts(uri);
  }

  function isCleanPreview(tab, uri) {
    return closeable.has(tab) && tab.isPreview && clean(tab, uri);
  }

  function cancelPending() {
    if (pending) clearTimeout(pending.timer);
    pending = undefined;
  }

  function forgetNew(key) {
    clearTimeout(recentlyOpened.get(key));
    recentlyOpened.delete(key);
  }

  function canFollow(candidate) {
    const { tab, uri } = candidate;
    if (pending !== candidate || groups.activeTabGroup?.activeTab !== tab || !clean(tab, uri)) return false;
    if (tab.isPreview) return true;
    if (candidate.sawPreview || !candidate.fromGraph) return false;
    return !candidate.fresh || !vscode.workspace.getConfiguration('workbench.editor', uri).get('enablePreview', true);
  }

  function update() {
    // A complete group-model update can introduce a tab without a tab-open event.
    // Use resources here because VS Code can replace all the tab wrapper objects at once.
    const resources = textTabs();
    for (const [key, tab] of resources) {
      const previous = knownResources.get(key);
      if (previous && previous !== tab && sourceTabs.has(previous)) sourceTabs.add(tab);
      if (!previous) {
        sourceJump(tab, tab.input.uri);
        forgetNew(key);
        recentlyOpened.set(key, setTimeout(() => forgetNew(key), settleDelay));
      }
    }
    for (const key of recentlyOpened.keys()) {
      if (!resources.has(key)) forgetNew(key);
    }
    knownResources = resources;

    const tab = groups.activeTabGroup?.activeTab;
    if (tab !== previousTab) {
      const sameResource = tab?.input instanceof vscode.TabInputText && pending && matches(tab, pending.uri)
        && tab.group.viewColumn === pending.tab.group.viewColumn;
      if (sameResource) pending.tab = tab;
      else {
        const fromGraph = leavingGraph || (!!graphTab && previousTab === graphTab);
        cancelPending();
        if (tab) leavingGraph = false;
        if (tab?.input instanceof vscode.TabInputText) {
          const key = resourceKey(tab), uri = tab.input.uri;
          const fresh = recentlyOpened.has(key);
          forgetNew(key);
          closeable.delete(tab);
          if ((fresh || fromGraph) && !sourceJump(tab, uri) && clean(tab, uri)) {
            pending = { uri, tab, fresh, fromGraph, sawPreview: false, delivered: false };
          }
        } else if (tab && (tab === graphTab || isGraphActive())) graphActivated();
      }
      previousTab = tab;
    }

    const candidate = pending;
    if (!candidate) return;
    if (!clean(candidate.tab, candidate.uri) || (candidate.sawPreview && !candidate.tab.isPreview)) {
      cancelPending();
      return;
    }
    candidate.sawPreview ||= candidate.tab.isPreview;
    if (candidate.delivered || candidate.timer || !canFollow(candidate)) return;
    // Let a double-click promote a preview and give typing a chance to mark it dirty.
    const isCurrent = () => canFollow(candidate);
    candidate.timer = setTimeout(() => {
      candidate.timer = undefined;
      if (!isCurrent()) return;
      candidate.delivered = true;
      if (candidate.fresh && candidate.tab.isPreview) closeable.add(candidate.tab);
      onPreview(candidate.uri, candidate.tab, isCurrent);
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

  if (isGraphActive()) graphActivated();
  subscriptions.push(groups.onDidChangeTabs(update), groups.onDidChangeTabGroups(update),
    vscode.window.onDidChangeActiveTextEditor(update));

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
    for (const key of recentlyOpened.keys()) forgetNew(key);
    for (const opening of openingSource) releaseSource(opening);
    for (const subscription of subscriptions) subscription.dispose();
  }
  return { dispose, graphActivated, isCleanPreview, showSource };
}

module.exports = { createPreviewFollower };
