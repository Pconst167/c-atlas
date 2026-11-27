// Globals is a table over the workspace index. Keep its UI separate from the
// graph model so returning to a graph keeps its scope, selection and layout.
const globalsView=byId("globalsView"),globalsSearch=byId("globalsSearch");
const globalsList=byId("globalsList"),globalsScroll=byId("globalsScroll");
const globalsPageSize=150;
let globalsLimit=globalsPageSize,selectedGlobal=null,matchingGlobals=[];

function globalKey(variable){return JSON.stringify([variable.path,variable.name]);}

function renderGlobalsTable(){
  const previousScroll=globalsScroll.scrollTop;
  const focusedKey=document.activeElement?.closest("#globalsList tr")?.dataset.key;
  const words=globalsSearch.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const variables=state.project.globals;
  matchingGlobals=words.length?variables.filter(variable=>{
    const name=variable.name.toLowerCase(),path=variable.path.toLowerCase();
    return words.every(word=>name.includes(word)||path.includes(word));
  }):variables;
  const fragment=document.createDocumentFragment();
  let focusRow=null;
  for(const [index,variable] of matchingGlobals.slice(0,globalsLimit).entries()){
    const row=el("tr"),nameCell=el("td"),key=globalKey(variable);
    row.dataset.key=key;row.dataset.index=index;
    const location=variable.path+":"+variable.line;
    const link=el("button","global-location",variable.name);
    link.type="button";link.title="Open "+location+" in VS Code";
    link.setAttribute("aria-label","Open "+variable.name+" at "+location);
    nameCell.append(link);
    if(variable.kind==="declaration")nameCell.append(el("small","global-kind","Declaration only"));
    if(key===selectedGlobal){row.classList.add("global-selected");link.setAttribute("aria-current","true");}
    if(key===focusedKey)focusRow=link;
    row.append(nameCell,el("td","global-declaration",variable.declaration),el("td","global-path",location));
    fragment.append(row);
  }
  globalsList.replaceChildren(fragment);
  byId("globalsCount").textContent=words.length?matchingGlobals.length+" of "+countLabel(variables.length,"global"):countLabel(variables.length,"global");
  byId("globalsMore").hidden=matchingGlobals.length<=globalsLimit;
  byId("globalsEmpty").hidden=!!matchingGlobals.length;
  byId("globalsEmpty").textContent=words.length?"No globals match this search.":"No file-scope variables found in this workspace.";
  globalsScroll.scrollTop=previousScroll;
  if(focusRow)focusRow.focus({preventScroll:true});
}

globalsList.addEventListener("click",event=>{
  const row=event.target.closest("tr[data-index]");
  if(!row)return;
  const variable=matchingGlobals[Number(row.dataset.index)];
  if(!variable)return;
  const file=state.files.get(variable.path);
  if(typeof file?.source!=="string")return;
  const old=globalsList.querySelector(".global-selected");
  if(old){old.classList.remove("global-selected");old.querySelector("button").removeAttribute("aria-current");}
  selectedGlobal=globalKey(variable);
  row.classList.add("global-selected");row.querySelector("button").setAttribute("aria-current","true");
  editor.postMessage({type:"openSource",path:variable.path,line:variable.line,
    column:variable.offset-file.source.lastIndexOf("\n",variable.offset-1)});
});
globalsSearch.addEventListener("input",()=>{
  globalsLimit=globalsPageSize;globalsScroll.scrollTop=0;renderGlobalsTable();
});
byId("globalsMore").onclick=()=>{
  const firstNew=globalsLimit;
  globalsLimit+=globalsPageSize;renderGlobalsTable();
  globalsList.children[firstNew]?.querySelector("button").focus();
};

function displayGlobals(show){
  globalsView.hidden=!show;
  document.body.classList.toggle("globals-open",show);
  byId("globalsTab").setAttribute("aria-pressed",String(show));
  const graphTabs={structureTab:state.mode==="structure",callTab:isCallGraph(),includeTab:state.mode==="include",headerTab:state.mode==="headers"};
  for(const [id,selected] of Object.entries(graphTabs))byId(id).setAttribute("aria-pressed",String(!show&&selected));
  if(!show){updateBreadcrumbs();return;}
  const home=button("crumb-link",state.project.name,()=>navigateFromGlobals(()=>openStructure("","folders")));
  home.title="Project structure";
  const current=el("span","","Globals");current.setAttribute("aria-current","page");
  byId("breadcrumbs").replaceChildren(home,el("span","slash","/"),current);
  renderGlobalsTable();
}

function recordGlobalsLocation(location){
  journey.past.push(location);
  if(journey.past.length>100)journey.past.shift();
  journey.future.length=0;
  updateHistory();
}

// A Globals location retains the underlying graph camera, but has no source
// preview of its own to reopen when the user moves through history.
const graphSnapshot=snapshot;
snapshot=function(){
  const location=graphSnapshot();
  return globalsView.hidden?location:{...location,globals:true,sourceOpen:false};
};
const graphHistory=updateHistory;
updateHistory=function(){
  graphHistory();
  if(journey.past.at(-1)?.globals)byId("navBack").title="Go back to Globals";
  if(journey.future.at(-1)?.globals)byId("navForward").title="Go forward to Globals";
};

byId("globalsTab").onclick=()=>{
  if(!state.project||!globalsView.hidden)return;
  if(graphFullscreenView)exitGraphFullscreen();
  recordGlobalsLocation(snapshot());
  displayGlobals(true);
  globalsSearch.focus({preventScroll:true});
};

function navigateFromGlobals(action){
  if(globalsView.hidden)return action();
  const origin=snapshot(),previous=journey.past.at(-1);
  displayGlobals(false);
  const result=action();
  // Shared graph navigation usually recorded the previous graph location. The
  // user was in Globals, including when the graph selection itself didn't move.
  if(journey.past.at(-1)===previous)recordGlobalsLocation(origin);
  else {journey.past[journey.past.length-1]=origin;updateHistory();}
  return result;
}
const switchGraphView=switchView;
switchView=function(mode){
  if(globalsView.hidden)return switchGraphView(mode);
  return navigateFromGlobals(()=>{
    if(mode!==state.mode && !(mode==="call"&&isCallGraph()))switchGraphView(mode);
  });
};
const graphSymbol=openSymbol;
openSymbol=symbol=>navigateFromGlobals(()=>graphSymbol(symbol));
const revealGraphFile=revealWorkspaceFile;
revealWorkspaceFile=path=>state.files.has(path)?navigateFromGlobals(()=>revealGraphFile(path)):revealGraphFile(path);

const graphTravel=travel;
travel=function(back){
  const source=back?journey.past:journey.future,destination=back?journey.future:journey.past;
  const target=source.at(-1);
  if(!target || globalsView.hidden&&!target.globals)return graphTravel(back);
  const origin=snapshot();
  if(!globalsView.hidden)displayGlobals(false);
  graphTravel(back);
  destination[destination.length-1]=origin;
  if(target.globals)displayGlobals(true);
  updateHistory();
};

const receiveGraphProject=receiveProject;
receiveProject=function(message){
  const sameWorkspace=workspaceMessage?.workspaceId===message.workspaceId;
  if(!sameWorkspace){
    if(!globalsView.hidden)displayGlobals(false);
    selectedGlobal=null;globalsSearch.value="";globalsLimit=globalsPageSize;globalsScroll.scrollTop=0;
  }
  receiveGraphProject(message);
  if(!globalsView.hidden)displayGlobals(true);
};
