"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

function uri(path, scheme = "file") {
  return { scheme, authority: "", path, toString() { return this.scheme + "://" + this.path; } };
}

const folder = { name: "engine", uri: uri("/projects/engine") };
const at = name => uri(folder.uri.path + "/" + name);
const neverCancel = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
class CancellationError extends Error {}
const workspace = {};
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (name === "vscode") return { workspace, CancellationError, RelativePattern: class { constructor(base, pattern) { Object.assign(this, { base, pattern }); } } };
  return originalLoad.call(this, name, ...args);
};
const { createWorkspaceIndexer } = require("../workspace-index");
Module._load = originalLoad;

function fixture() {
  const contents = new Map(Object.entries({
    "main.c": '#include "engine.h"\nint main(void){ return tick(); }',
    "engine.h": "int tick(void);\n",
    "engine.c": 'int tick(void){ return 1; }\nconst char *shader="shaders/light.frag";\nconst char *image="img/icon.png";',
    "shaders/light.frag": '#include "common.glsl"\nvoid main(){}\n',
    "shaders/common.glsl": "const int LEVEL = 42;",
    "img/icon.png": Buffer.from([0, 1, 0, 2]),
    "unused.glsl": "never referenced",
    "ignored/hidden.c": "int hidden(void) {return 9;}",
    ".git/metadata.c": "int ignored(void){}",
    "node_modules/tool/src/cli.c": "void nope(void){}"
  }));
  let listings = 0;
  const reads = new Map(), stats = new Set();
  const name = uri => uri.path.slice(folder.uri.path.length + 1);
  Object.assign(workspace, {
    textDocuments: [],
    fs: {
      stat: async uri => {
        stats.add(name(uri));
        return { size: Buffer.byteLength(contents.get(name(uri))) };
      },
      readFile: async uri => {
        const path = name(uri);
        reads.set(path, (reads.get(path) || 0) + 1);
        return Buffer.from(contents.get(path));
      }
    },
    getWorkspaceFolder: () => folder,
    findFiles: async (include, exclude) => {
      assert.equal(include.base, folder);
      assert.equal(exclude, undefined); // VS Code applies files.exclude.
      listings++;
      return [...contents.keys()].filter(path => !path.startsWith("ignored/")).map(at);
    }
  });
  return { contents, index: createWorkspaceIndexer(folder), reads, stats, listings: () => listings };
}

function mainFunction(project) {
  return project.files.find(file => file.path === "main.c").functions[0];
}

test("indexes calls, headers and nested shader assets and tracks an unsaved edit without rereading disk", async () => {
  const { index, contents, reads, stats, listings } = fixture();
  const baseline = await index.build(neverCancel);
  assert.deepEqual([...baseline.sources.keys()].sort(), ["engine.c","engine.h","img/icon.png","main.c","shaders/common.glsl","shaders/light.frag"]);
  assert.equal(mainFunction(baseline.project).calls.length, 1);
  assert.equal(baseline.sources.get("engine.c").toString(), at("engine.c").toString());
  assert.equal(reads.has("img/icon.png"), false);
  assert.equal(stats.has("unused.glsl"), false);
  workspace.textDocuments = [
    { uri: at("main.c"), isDirty: true, getText: () => "int main(void) { return 0; }" },
    { uri: at("shaders/light.frag"), isDirty: true, getText: () => '#include "../unused.glsl"\n' },
    { uri: at("ignored/hidden.c"), isDirty: true, getText: () => "int hidden(void){}" }
  ];
  const edited = await index.build(neverCancel);
  assert.deepEqual(mainFunction(edited.project).calls, []);
  assert(edited.sources.has("unused.glsl"));
  assert(!edited.sources.has("shaders/common.glsl"));
  assert(!edited.sources.has("ignored/hidden.c"));
  assert.equal(reads.get("engine.c"), 1);
  assert.equal(listings(), 1);
  workspace.textDocuments = [];
  assert.equal(mainFunction((await index.build(neverCancel)).project).calls.length, 1);
  contents.set("engine.c", "int renamed(void){return 2;}");
  index.invalidate(at("engine.c"));
  assert.deepEqual(mainFunction((await index.build(neverCancel)).project).calls, []);
  contents.delete("engine.c");
  contents.set("tick.c","int tick(void){return 4;}");
  index.invalidate(at("engine.c"), true);
  index.invalidate(at("tick.c"), true);
  const renamed = await index.build(neverCancel);
  assert.equal(mainFunction(renamed.project).calls.length, 1);
  assert(!renamed.sources.has("engine.c"));
  assert(renamed.sources.has("tick.c"));
  assert.equal(listings(), 2);
});

test("cancels an active analyzer and accepts a new build", async () => {
  const { index } = fixture();
  const listeners = new Set();
  const token = { isCancellationRequested: false, onCancellationRequested(fn) { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; } };
  const stat = workspace.fs.stat;
  workspace.fs.stat = async resource => {
    if (resource.path.endsWith(".frag")) {
      token.isCancellationRequested = true;
      for (const fn of listeners) fn();
    }
    return stat(resource);
  };
  await assert.rejects(index.build(token), CancellationError);
  assert.equal(listeners.size, 0);
  workspace.fs.stat = stat;
  assert.equal(mainFunction((await index.build(neverCancel)).project).calls.length, 1);
});
