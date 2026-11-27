'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPreviewFollower } = require('../preview-follow');

function signal() {
  const listeners = new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    fire(event) { for (const listener of listeners) listener(event); }
  };
}

function workspace(context) {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const changedTabs = signal(), changedGroups = signal(), changedEditor = signal(), calls = [];
  const left = { viewColumn: 1, tabs: [] }, right = { viewColumn: 2, tabs: [] };
  const groups = {
    all: [left, right], activeTabGroup: left,
    onDidChangeTabs: changedTabs.subscribe, onDidChangeTabGroups: changedGroups.subscribe
  };
  class TabInputText {
    constructor(uri) { this.uri = uri; }
  }
  const graph = { group: left, input: {}, isPreview: false };
  left.tabs.push(graph);
  left.activeTab = graph;
  let enabled = true, previews = true;
  const follower = createPreviewFollower({
    window: { tabGroups: groups, onDidChangeActiveTextEditor: changedEditor.subscribe },
    workspace: { getConfiguration: () => ({ get: () => previews }) }, TabInputText
  }, {
    isGraphActive: () => groups.activeTabGroup?.activeTab === graph,
    accepts: uri => enabled && /\.(c|h)$/.test(uri.toString()),
    onPreview: (uri, tab, isCurrent) => calls.push({ uri, tab, isCurrent })
  });
  context.after(() => follower.dispose());
  const emit = changes => changedTabs.fire({ opened: [], closed: [], changed: [], ...changes });
  function activate(tab, event = 'group') {
    groups.activeTabGroup = tab.group;
    tab.group.activeTab = tab;
    if (event === 'editor') changedEditor.fire({ document: { uri: tab.input.uri } });
    else if (event === 'changed') emit({ changed: [tab] });
    else changedGroups.fire({ changed: [tab.group], opened: [], closed: [] });
  }
  function open(path, { group = left, active = true, event = 'open', ...overrides } = {}) {
    const tab = { group, isDirty: false, isPreview: true, isPinned: false, input: new TabInputText(new URL(path)), ...overrides };
    group.tabs.push(tab);
    if (active) {
      groups.activeTabGroup = group;
      group.activeTab = tab;
    }
    if (event === 'model') changedGroups.fire({ changed: [group], opened: [], closed: [] });
    else emit({ opened: [tab] });
    return tab;
  }
  function close(tab) {
    tab.group.tabs = tab.group.tabs.filter(other => tab !== other);
    if (tab.group.activeTab === tab) tab.group.activeTab = undefined;
    emit({ closed: [tab] });
  }
  return { calls, left, right, graph, open, activate, close, emit, follower, setPreviews: value => { previews = value; }, enable: value => { enabled = value; }, tick: ms => context.mock.timers.tick(ms) };
}

test('follows a newly active preview once, and distinguishes tab liveness from focus', t => {
  const { open, close, activate, tick, calls, graph, follower } = workspace(t);
  const tab = open('file:///work/main.c');
  const uri = tab.input.uri;
  tick(100);
  assert.equal(calls.length, 0);
  tick(400);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tab, tab);
  assert.equal(calls[0].uri, uri);
  assert.equal(calls[0].isCurrent(), true);
  activate(graph);
  assert.equal(calls[0].isCurrent(), false);
  assert.equal(follower.isCleanPreview(tab, uri), true);
  assert.equal(follower.isCleanPreview(tab, new URL('file://different/work/main.c')), false);
  activate(tab);
  tick(500);
  assert.equal(calls.length, 2);
  assert.equal(follower.isCleanPreview(tab, uri), false, 'a reactivated preview must remain open');
  close(tab);
  assert.equal(follower.isCleanPreview(tab, uri), false);
});

test('ignores permanent, pinned, edited, excluded, non-text, closed, and disabled previews', t => {
  const { open, close, tick, calls, enable, emit } = workspace(t);
  for (const options of [{ isPreview: false }, { isDirty: true }, { isPinned: true }, { input: {} }]) {
    open('file:///work/main.c', options);
    tick(500);
  }
  open('file:///work/logo.png');
  tick(500);
  const promoted = open('file:///work/a.c');
  promoted.isPreview = false;
  emit({ changed: [promoted] });
  tick(500);
  const edited = open('file:///work/b.c');
  edited.isDirty = true;
  tick(500);
  close(open('file:///work/c.c'));
  tick(500);
  open('file:///work/d.c');
  enable(false);
  tick(500);
  assert.equal(calls.length, 0);
});

test('switching previews keeps the most recent selection and returning to an old tab leaves it alone', t => {
  const { open, activate, tick, calls } = workspace(t);
  const earlier = open('file:///work/a.c');
  tick(40);
  const later = open('file:///work/b.h');
  tick(500);
  assert.deepEqual(calls.map(call => call.tab), [later]);
  activate(earlier);
  activate(later);
  tick(500);
  assert.equal(calls[0].isCurrent(), false);
  assert.equal(calls.length, 1);
});

test('handles tab creation before group activation and expires unopened background selections', t => {
  const { open, activate, right, tick, calls } = workspace(t);
  const delayed = open('file:///work/declarations.h', { group: right, active: false });
  tick(50);
  activate(delayed);
  tick(500);
  assert.deepEqual(calls.map(call => call.tab), [delayed]);
  const background = open('file:///work/background.c', { active: false });
  tick(500);
  activate(background);
  tick(500);
  assert.equal(calls.length, 1);
});

test('an explicit source jump never redirects the source it opened', async t => {
  const { follower, open, close, tick, calls } = workspace(t);
  const uri = new URL('file:///work/jump.c');
  let opened;
  const editor = { viewColumn: 1 };
  const outgoing = await follower.showSource(uri, async () => {
    opened = open(uri);
    tick(500);
    return editor;
  });
  assert.equal(outgoing, editor);
  tick(500);
  assert.equal(calls.length, 0);
  assert.equal(follower.isCleanPreview(opened, uri), false);
  close(opened);
  const later = open(uri);
  tick(500);
  assert.deepEqual(calls.map(call => call.tab), [later]);
});

test('source-jump suppression recognizes late tab events in the intended group only', async t => {
  const { open, tick, calls, follower, right } = workspace(t);
  const uri = new URL('file:///work/target.c');
  await follower.showSource(uri, async () => ({ viewColumn: 1 }));
  const otherGroup = open(uri, { group: right });
  const source = open(uri, { active: false });
  assert.equal(follower.isCleanPreview(source, uri), false);
  tick(500);
  assert.deepEqual(calls.map(call => call.tab), [otherGroup]);
});

test('failed source jumps release suppression and disposal cancels pending work', async t => {
  const { open, tick, calls, follower } = workspace(t);
  const uri = new URL('file:///work/target.c');
  await assert.rejects(follower.showSource(uri, async () => { throw new Error('open failed'); }));
  const ordinary = open(uri);
  tick(500);
  assert.deepEqual(calls.map(call => call.tab), [ordinary]);
  open('file:///work/later.c');
  follower.dispose();
  open('file:///work/again.c');
  tick(500);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].isCurrent(), false);
});

test('a click from the graph follows an existing regular tab through an active-editor or changed-only event', t => {
  const { open, activate, tick, calls, graph, follower } = workspace(t);
  for (const event of ['editor', 'changed']) {
    const existing = open('file:///work/' + event + '.c', { active: false, isPreview: false });
    tick(500);
    activate(graph);
    activate(existing, event);
    tick(500);
    assert.equal(calls.at(-1).tab, existing);
    assert.equal(follower.isCleanPreview(existing, existing.input.uri), false);
  }
  assert.equal(calls.length, 2);
});

test('with previews disabled files opened from the graph are followed and kept, and editing other files keeps focus', t => {
  const { open, tick, setPreviews, calls, follower } = workspace(t);
  setPreviews(false);
  const regular = open('file:///work/main.c', { isPreview: false });
  tick(500);
  assert.deepEqual(calls.map(call => call.tab), [regular]);
  assert.equal(follower.isCleanPreview(regular, regular.input.uri), false);
  open('file:///work/another.c', { isPreview: false });
  tick(500);
  assert.equal(calls.length, 1);
});

test('late preview flags or a group-only model refresh can report the single click', t => {
  const { open, tick, emit, calls, follower } = workspace(t);
  const delayed = open('file:///work/first.c', { isPreview: false });
  tick(500);
  assert.equal(calls.length, 0);
  delayed.isPreview = true;
  emit({ changed: [delayed] });
  tick(500);
  const refreshed = open('file:///work/second.h', { event: 'model' });
  tick(500);
  assert.deepEqual(calls.map(call => call.tab), [delayed, refreshed]);
  assert.equal(follower.isCleanPreview(refreshed, refreshed.input.uri), true);
});

test('a refreshed tab model still recognizes a source editor opened explicitly from the graph', async t => {
  const { open, activate, emit, tick, calls, graph, follower, right } = workspace(t);
  const uri = new URL('file:///work/edit.c');
  let original;
  await follower.showSource(uri, async () => {
    original = open(uri, { active: false, group: right });
    return { viewColumn: right.viewColumn };
  });
  const replacement = { ...original };
  right.tabs = [replacement];
  emit({ changed: [replacement] });
  activate(graph);
  activate(replacement, 'editor');
  tick(500);
  assert.equal(calls.length, 0);
  assert.equal(follower.isCleanPreview(replacement, uri), false);
});
