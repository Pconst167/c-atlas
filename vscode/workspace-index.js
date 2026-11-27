"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");
const vscode = require("vscode");
const { isProjectSource, limits, limitMessage } = require("./media/analysis.cjs");

function checkCancellation(token) {
  if (token.isCancellationRequested) throw new vscode.CancellationError();
}

async function mapFiles(files, operation, token) {
  const results = new Array(files.length);
  let next = 0;
  async function run() {
    while (next < files.length) {
      checkCancellation(token);
      const index = next++;
      results[index] = await operation(files[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, run));
  checkCancellation(token);
  return results;
}

function createWorkspaceIndexer(folder) {
  let inventory, generation = 0;
  const disk = new Map();
  const prefix = folder.uri.path.replace(/\/?$/, "/");
  function relativePath(uri) {
    if (uri.scheme !== folder.uri.scheme || uri.authority !== folder.uri.authority || !uri.path.startsWith(prefix)) return;
    const name = uri.path.slice(prefix.length);
    if (!name || /(?:^|\/)(?:\.\.?|\.git|\.hg|\.svn|node_modules)(?:\/|$)/.test(name)) return;
    return name;
  }

  function reset() {
    generation++;
    inventory = undefined;
    disk.clear();
  }

  function invalidate(uri, inventoryChanged = false) {
    if (inventoryChanged && uri.toString() === folder.uri.toString()) { reset(); return; }
    const name = relativePath(uri);
    if (!name) return;
    disk.delete(name);
    if (inventoryChanged) {
      generation++;
      inventory = undefined;
      for (const cached of disk.keys()) {
        if (cached.startsWith(name + "/")) disk.delete(cached);
      }
    }
  }

  async function list(token) {
    if (inventory) return inventory;
    const currentGeneration = generation;
    // An undefined exclude argument makes VS Code honor the folder's files.exclude settings.
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*"), undefined, undefined, token);
    checkCancellation(token);
    const paths = new Map();
    for (const uri of files) {
      const name = relativePath(uri);
      if (name && vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === folder.uri.toString()) paths.set(name, uri);
    }
    if (generation === currentGeneration) inventory = paths;
    return paths;
  }

  // Each record is a snapshot. Invalidating it detaches any pending read from the cache.
  function snapshot(name, uri) {
    if (!disk.has(name)) disk.set(name, {});
    const record = disk.get(name);
    function memoize(key, read) {
      if (!record[key]) record[key] = Promise.resolve().then(read).catch(error => {
        delete record[key];
        throw error;
      });
      return record[key];
    }
    return {
      size: () => memoize("size", async () => (await vscode.workspace.fs.stat(uri)).size),
      bytes: () => memoize("bytes", () => vscode.workspace.fs.readFile(uri))
    };
  }

  async function build(token) {
    checkCancellation(token);
    const paths = await list(token);
    const dirty = new Map();
    for (const document of vscode.workspace.textDocuments) {
      const name = relativePath(document.uri);
      if (document.isDirty && name && paths.has(name)) dirty.set(name, document);
    }
    function size(name) {
      const document = dirty.get(name);
      return document ? Buffer.byteLength(document.getText()) : snapshot(name, paths.get(name)).size();
    }
    function bytes(name) {
      const document = dirty.get(name);
      return document ? Buffer.from(document.getText()) : snapshot(name, paths.get(name)).bytes();
    }
    const names = [...paths.keys()].filter(isProjectSource).sort();
    if (names.length > limits.maxFiles) throw Error(limitMessage);
    const sizes = await mapFiles(names, size, token);
    if (sizes.some(size => size > limits.maxFileBytes) || sizes.reduce((sum, n) => sum + n, 0) > limits.maxTotalBytes) {
      throw Error(limitMessage);
    }
    let total = 0;
    const sources = await mapFiles(names, async name => {
      const document = dirty.get(name);
      let source;
      if (document) source = document.getText();
      else {
        const data = await bytes(name);
        if (data.includes(0)) return null;
        source = new TextDecoder().decode(data);
      }
      if (source.includes("\0")) return null;
      const length = Buffer.byteLength(source);
      total += length;
      if (length > limits.maxFileBytes || total > limits.maxTotalBytes) throw Error(limitMessage);
      return { path: name, source, size: length };
    }, token);
    const project = await analyzeInWorker(folder.name, sources.filter(Boolean), [...paths.keys()], async (type, name) => {
      if (!paths.has(name)) throw Error("The requested asset is outside this workspace.");
      checkCancellation(token);
      return type === "size" ? size(name) : bytes(name);
    }, token);
    checkCancellation(token);
    const indexed = new Map(project.files.map(file => [file.path, paths.get(file.path)]));
    for (const name of disk.keys()) {
      if (!indexed.has(name)) disk.delete(name);
    }
    return { project, sources: indexed };
  }

  return { build, invalidate, reset };
}

function analyzeInWorker(name, sources, paths, read, token) {
  checkCancellation(token);
  const worker = new Worker(path.join(__dirname, "index-worker.js"), { workerData: { name, sources, paths } });
  return new Promise((resolve, reject) => {
    let finished = false, cancellation;
    function finish(error, project) {
      if (finished) return;
      finished = true;
      cancellation?.dispose();
      void worker.terminate();
      if (error) reject(error);
      else resolve(project);
    }
    cancellation = token.onCancellationRequested(() => finish(new vscode.CancellationError()));
    worker.once("error", error => finish(error));
    worker.once("exit", code => {
      if (!finished) finish(Error("The C Atlas indexer stopped before completing (exit " + code + ")."));
    });
    worker.on("message", async message => {
      if (finished) return;
      if (message.type === "project") { finish(null, message.project); return; }
      if (message.type === "error") { finish(Error(message.message)); return; }
      try {
        const value = await read(message.type, message.path);
        if (!finished) worker.postMessage({ id: message.id, value });
      } catch (error) { finish(error); }
    });
  });
}

module.exports = {
  createWorkspaceIndexer,
  buildIndex: (folder, token) => createWorkspaceIndexer(folder).build(token),
  isProjectSource
};
