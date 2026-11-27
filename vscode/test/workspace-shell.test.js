'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('the extension has one top-level Globals view and lets the native Explorer be the file tree', () => {
  const html = readFileSync(path.join(__dirname, '..', 'media', 'index.html'), 'utf8');
  const viewSelector = html.match(/<div\b[^>]*class="tabs"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(viewSelector, 'The workspace must have a graph view selector');
  for (const id of ['structureTab', 'callTab', 'includeTab', 'headerTab', 'globalsTab']) {
    assert.match(viewSelector[1], new RegExp('<button\\b[^>]*\\bid="' + id + '"'));
  }
  assert.equal((html.match(/\bid="globalsView"/g) ?? []).length, 1);
  for (const id of ['sidebar', 'explorerSplitter', 'hideExplorer', 'toggleSidebar', 'tree', 'explore-globals']) {
    assert.ok(!html.includes('id="' + id + '"'), id + ' must not be built into the extension');
  }
  assert.doesNotMatch(html, /aria-controls="sidebar"/);
});
