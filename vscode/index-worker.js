"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const analysis = require("./media/analysis.cjs");
const requests = new Map();
let nextId = 0;

// The workspace filesystem stays in the extension host, including remote file providers.
function request(type, descriptor) {
  return new Promise(resolve => {
    const id = nextId++;
    requests.set(id, resolve);
    parentPort.postMessage({ type, id, path: descriptor.path });
  });
}
parentPort.on("message", ({ id, value }) => {
  const resolve = requests.get(id);
  requests.delete(id);
  resolve(value);
});

async function run() {
  const { sources, paths, name } = workerData;
  const entries = await analysis.collectAssetEntries(sources, paths.map(path => ({ path })),
    descriptor => request("bytes", descriptor), descriptor => request("size", descriptor));
  const project = analysis.analyze(entries, name);
  parentPort.postMessage({ type: "project", project });
}
run().catch(error => parentPort.postMessage({ type: "error", message: error.message }));
