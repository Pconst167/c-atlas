"use strict";
(() => {
  const editor = acquireVsCodeApi();
  const records = new Map();
  let graph = null;
  let workspaceId;
  // Only layout coordinates and UI preferences cross this boundary.
  const storage = {
    get length() { return records.size; },
    key(index) { return Array.from(records.keys())[index] ?? null; },
    getItem(key) { return records.get(key) ?? null; },
    setItem(key,value) {
      value = String(value);
      if (records.get(key) === value) return;
      records.set(key,value);
      editor.postMessage({type:"storage",key,value});
    },
    removeItem(key) {
      if (records.delete(key)) editor.postMessage({type:"storage",key,value:null});
    }
  };
  window.addEventListener("message",event=>{
    const message=event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "project") {
      if (!message.project || !Array.isArray(message.project.files)) return;
      if (workspaceId !== message.workspaceId) {
        workspaceId=message.workspaceId;
        records.clear();
        for (const [key,value] of Object.entries(message.storage || {})) {
          if (key.startsWith("c-atlas.") && typeof value==="string") records.set(key,value);
        }
      }
      graph ||= startGraph(editor,storage);
      graph(message);
      return;
    }
    if ((message.type==="status" || message.type==="error") && typeof message.message === "string") {
      document.getElementById("status").textContent=message.message;
      document.getElementById("workspaceMessage").textContent=message.message;
      document.getElementById("retryWorkspace").hidden=message.type!=="error";
      if (message.type==="error") document.getElementById("startTitle").textContent="Could not open the workspace graph";
    }
  });
  for (const id of ["refreshWorkspace","retryWorkspace"]) {
    document.getElementById(id).onclick=()=>editor.postMessage({type:"refresh"});
  }
  editor.postMessage({type:"ready"});
})();
