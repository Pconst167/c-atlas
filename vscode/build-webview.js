"use strict";

const fs = require("node:fs");
const path = require("node:path");
const root = __dirname;
const source = fs.readFileSync(path.join(root, "..", "index.html"), "utf8");
const output = path.join(root, "media");
const read = name => fs.readFileSync(path.join(root, "webview", name), "utf8");

function replaceOnce(text, pattern, replacement) {
  const result = text.replace(pattern, () => replacement);
  if (result === text) throw new Error("Cannot locate C Atlas integration point: " + pattern);
  return result;
}

// The Pages repository ships a self-contained HTML file. Select its graph modules by
// their public entry points so changes in script order do not affect the extension.
const scripts = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]);
function moduleWith(entryPoint) {
  const matches = scripts.filter(script => script.includes(entryPoint));
  if (matches.length !== 1) throw new Error("Expected one module defining " + entryPoint);
  return matches[0];
}
const analysis = moduleWith("const AtlasAnalysis =");
const shared = [
  analysis, moduleWith("function buildCallScope("), moduleWith("function buildSymbolIndex("),
  moduleWith("function visibleFolderCounts(").replace("on this browser. Your original files stay in the repository or ZIP.","in this workspace. The files on disk stay in place."), moduleWith("function graphLayoutContext(").replace("view.includeOtherFiles && view.crossFileCount","view.includeOtherFiles"),
  moduleWith("function initializeManualLayout(")
];
let app = moduleWith("function loadProject(");
// Workspace files come from VS Code's index and Explorer.
app = replaceOnce(app, /for\(const id of \["upload","dropButton","startRepository"\]\)[\s\S]*?\n(?=\/\/ Both dividers)/, "");
app = replaceOnce(app, /initializeAccounts\(\);\s*openLinkedRepository\(\);/, "");
app = replaceOnce(app, /  refresh\(\);\n}\nfunction makeTree/, '  if (!restoringGraph) refresh();\n}\nfunction makeTree');
app = replaceOnce(app, /if\(graphFullscreenView\)exitGraphFullscreen\(\);\n  inspectorView=/, 'if(graphFullscreenView && !restoringGraph)exitGraphFullscreen();\n  inspectorView=');
app = replaceOnce(app, 'byId("startRepository").focus()', 'byId("refreshWorkspace").focus()');
// The canvas has no dimensions while the Globals tab is active.
// A project update can lay out the graph while the Globals table is in front.
// Keep the last visible dimensions and camera until the graph is measurable.
app = replaceOnce(app, 'function noteCanvasSize(){canvasWidth=', 'function noteCanvasSize(){if(!canvas.clientWidth || !canvas.clientHeight)return;canvasWidth=');
app = replaceOnce(app, 'function fitGraph(initial=false){\n  if(!state.layout)return;',
  'function fitGraph(initial=false){\n  if(!state.layout || !canvas.clientWidth || !canvas.clientHeight)return;');

// The shared graph lives alongside the website's Explorer in one script. Omit
// the sidebar's initialization, rendering and event handlers in the webview.
for (const section of [
  /let explorerView="files";[\s\S]*?(?=let inspectorOpen=)/,
  /  state\.opened=new Set\(\);[\s\S]*?(?=  byId\("status"\)\.textContent="Ready";)/,
  /function makeTree\(files\)\{[\s\S]*?(?=function updateInspectorVisibility\()/,
  /function setExplorerView\(view,render=true\)\{[\s\S]*?(?=const currentView=)/,
  /for\(const name of \["files","globals"\]\)\{[\s\S]*?(?=byId\("folderControls"\)\.onclick)/,
  /byId\("hideExplorer"\)\.onclick=[\s\S]*?(?=document\.querySelector\("\.wordmark"\)\.onclick)/,
  /  if\(mobileExplorerOpen\)\{[^\n]*\}\n  else /
]) app = replaceOnce(app, section, "");
app = replaceOnce(app, /  if\(event\.key==="\/"[\s\S]*?(?=if\(event\.key==="Escape"\))/,
  "  if(handleWorkspaceSearchShortcut(event))return;\n  ");
app = replaceOnce(app, 'narrowExplorer.matches?5:12', 'window.matchMedia("(max-width:720px)").matches?5:12');
app = replaceOnce(app, '"tree","details","globalList","breadcrumbs","stats","projectName","projectMeta"', '"details","breadcrumbs","stats"');
app = replaceOnce(app, 'opened:new Set(),expandedFiles:new Set(),', '');
app = replaceOnce(app, 'y:0,tree:null', 'y:0');

const adapters = [read("workspace.js"), app, moduleWith("function graphPoint(event)"), read("editor.js"), read("globals.js")];
const graphModules = [...shared, ...adapters].map(script => script.replaceAll("revealTree(state.activeFile);", "")
  .replaceAll("hideSidebar();", "").replaceAll("renderTree();", ""));
const js = read("bootstrap.js") + "\nfunction startGraph(editor,localStorage){\n\"use strict\";\n" +
  graphModules.join("\n;\n") + "\nreturn {receiveProject,revealWorkspaceFile};\n}\n";

const css = source.match(/<style>([\s\S]*?)<\/style>/)?.[1];
if (!css) throw new Error("Missing C Atlas stylesheet");
let html = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
html = replaceOnce(html, /<style>[\s\S]*?<\/style>/, '<link rel="stylesheet" href="{{MEDIA_URI}}/atlas.css">');
html = replaceOnce(html, '<meta charset="utf-8">', '<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src {{CSP_SOURCE}}; style-src {{CSP_SOURCE}} \'unsafe-inline\'; img-src {{CSP_SOURCE}} data:; base-uri \'none\'; form-action \'none\'">');
html = replaceOnce(html, /<button\b[^>]*id="recentProjects"[\s\S]*?<\/button>/, '<button id="refreshWorkspace" class="plain" type="button" title="Reindex the current workspace">Refresh</button>');
html = replaceOnce(html, /  <aside id="sidebar"[\s\S]*?<\/aside>\n/, "");
html = replaceOnce(html, / *<button id="toggleSidebar"[^\n]+\n/, "");
html = replaceOnce(html, 'aria-label="Graph view"', 'aria-label="Project views"');
html = replaceOnce(html, 'Header includes</button></div>', 'Header includes</button>' + read("globals-tab.html").trim() + '</div>');
html = replaceOnce(html, '    <div id="traceBar"', read("globals.html").trimEnd() + '\n    <div id="traceBar"');
for (const id of ["accountHub","upload","cancelImport"]) {
  html = replaceOnce(html, new RegExp('<button\\b[^>]*id="' + id + '"[\\s\\S]*?<\\/button>'), "");
}
html = replaceOnce(html, /<input[^>]+id="fileInput"[^>]*>/, "");
html = replaceOnce(html, /<section class="project-start-card">[\s\S]*?<\/section>/, '<section class="project-start-card"><h1 id="startTitle">Opening workspace graph</h1><p id="workspaceMessage" role="status">Reading workspace files…</p><button class="outline" id="retryWorkspace" hidden>Try again</button></section>');
html = replaceOnce(html, /<p>Choose Open project and paste[\s\S]*?<\/p>/, '<h3>Workspace files</h3><p>The graph follows the open workspace folder, including unsaved edits. Select a function to reveal it in the editor. Choose View source in the Inspector to open a linked preview inside the graph.</p>');
html = html.replace('title="Open the source panel when selecting a file or function"','title="Open the file or function in the VS Code editor when selected"');
html = html.replace("Explore C projects from GitHub or ZIP archives in your browser with interactive call graphs and file dependency maps.","Explore the open C workspace through call graphs and file dependency maps.");
html = html.replaceAll("Your browser saves block positions", "C Atlas saves block positions")
  .replaceAll("on this browser", "in this workspace").replaceAll("in this browser", "in this workspace")
  .replace("Drag the right edge of Project explorer to change its width. ", "")
  .replace("In the Project explorer, choose Globals", "Choose the Globals tab")
  .replace("use search or the file tree", "use Go to symbol or VS Code’s Explorer");
html = replaceOnce(html, '<button type="button" class="source-close" id="closeSource"',
  '<button type="button" class="outline" id="openEditor">Open in editor</button><button type="button" class="source-close" id="closeSource"');
html = replaceOnce(html, '</body>', '<script src="{{MEDIA_URI}}/atlas.js"></script>\n</body>');

fs.mkdirSync(output,{recursive:true});
for (const [name, value] of Object.entries({"analysis.cjs":analysis+"\nmodule.exports=AtlasAnalysis;\n",
  "atlas.js":js, "atlas.css":css+"\n"+read("editor.css")+"\n"+read("globals.css"),"index.html":html})) {
  fs.writeFileSync(path.join(output,name),value);
}
