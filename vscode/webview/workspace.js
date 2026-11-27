// Editor-backed workspace import. The shared browser app owns the graph and Inspector.
let folderSession=null, workspaceMessage=null, restoringGraph=false;
const projectLoadPending=()=>false;

function stableFunctionIds(project){
  const changed=new Map();
  for(const file of project.files){
    const occurrences=new Map();
    for(const fn of file.functions){
      const ordinal=occurrences.get(fn.name)||0;
      occurrences.set(fn.name,ordinal+1);
      const id=JSON.stringify([file.path,fn.name,ordinal]);
      changed.set(fn.id,id);
      fn.id=id;
    }
  }
  for(const file of project.files){
    for(const fn of file.functions){
      fn.calls=fn.calls.map(id=>changed.get(id));
      for(const site of fn.callSites)site.target=changed.get(site.target);
    }
  }
}

function revealWorkspaceFile(path){
  const file=state.files.get(path);
  if(!file){
    const filtered=folderSession?.removed.some(folder=>path.startsWith(folder));
    notify(filtered?"This folder is hidden in C Atlas. Restore it from Structure to see the file.":"This file is outside the current C Atlas index.");
    return false;
  }
  if(state.mode!=="include" && !AtlasAnalysis.isHeaderFile(path) && file.functions.length){
    openCallScope(path);
    // A previous selection can be a cross-file neighbor in the new graph.
    if(state.activeFile!==path){
      const local=currentView().items.find(item=>!item.contextOnly);
      if(local)select(local.id,"callScope",true,false,false);
    }
    return true;
  }
  const mode=state.mode!=="include" && AtlasAnalysis.isHeaderFile(path)?"headers":"include";
  if(state.mode!==mode || state.selected!==path)visitSelection(path,mode,false);
  return true;
}

function applyFolderChanges(removed){
  if(!folderSession || !workspaceMessage)return;
  if(removed.length)localStorage.setItem(folderSession.storageKey,JSON.stringify(removed));
  else localStorage.removeItem(folderSession.storageKey);
  receiveProject(workspaceMessage);
}

function moveMarker(marker,oldFiles,newFiles){
  if(!marker)return null;
  const before=oldFiles.get(marker.path)?.source,after=newFiles.get(marker.path)?.source;
  if(typeof before!=="string"||typeof after!=="string")return null;
  if(before===after)return marker;
  let first=0;
  while(first<before.length && first<after.length && before[first]===after[first])first++;
  let oldEnd=before.length,newEnd=after.length;
  while(oldEnd>first && newEnd>first && before[oldEnd-1]===after[newEnd-1]){oldEnd--;newEnd--;}
  const offset=marker.offset>=oldEnd?marker.offset+newEnd-oldEnd:
    marker.offset+(marker.length||marker.name?.length||0)<=first?marker.offset:null;
  if(offset===null||!Number.isInteger(offset))return null;
  return {...marker,offset,line:after.slice(0,offset).split("\n").length};
}

// Only keep history entries whose selection and scope still exist after an edit.
function reconcileLocations(previous,oldFiles){
  const views=new Map();
  function scopedView(location){
    if(location.mode!=="structure" && location.mode!=="callScope")return state.views[location.mode];
    const key=JSON.stringify([location.mode,location.scope,location.grouping,location.kind,location.callScope,location.callsAcrossFiles]);
    if(!views.has(key)){
      if(location.mode==="structure"){
        views.set(key,location.scope===state.scope && location.grouping===state.grouping && location.kind===state.relationshipKind ?
          state.views.structure : buildStructure(state.project.files,state.relationships,location.scope,location.grouping,location.kind));
      }else{
        views.set(key,buildCallScope(state.project.files,state.relationships,state.views.call,location.callScope,location.callsAcrossFiles));
      }
    }
    return views.get(key);
  }
  const reconcile=location=>{
    const view=scopedView(location);
    if(!view || !view.byKey.has(location.id))return null;
    const route=location.route?.every((id,index,ids)=>state.functions.has(id) &&
      (!index || state.functions.get(ids[index-1]).calls.includes(id)))?location.route:null;
    const activeFile=state.files.has(location.activeFile)?location.activeFile:(view.byKey.get(location.id)?.path||state.activeFile);
    return {...location,activeFile,route,marker:moveMarker(location.marker,oldFiles,state.files),
      pinnedHighlight:view.byKey.has(location.pinnedHighlight)?location.pinnedHighlight:null};
  };
  journey.past.push(...previous.past.map(reconcile).filter(Boolean));
  journey.future.push(...previous.future.map(reconcile).filter(Boolean));
  return reconcile(previous.location);
}

function receiveProject(message){
  const sameWorkspace=workspaceMessage && workspaceMessage.workspaceId===message.workspaceId;
  const previous=sameWorkspace && state.project ? {
    location:snapshot(),past:[...journey.past],future:[...journey.future],files:state.files,
    opened:state.opened,expanded:state.expandedFiles,explorer:explorerView,
    queries:{...explorerQueries},treeScroll:byId("tree").scrollTop,
    globalsScroll:byId("globalList").scrollTop,inspectorScroll:byId("details").scrollTop
  }:null;
  workspaceMessage=message;
  const original=message.project;
  const storageKey="c-atlas.folders.workspace."+message.workspaceId;
  let removed=[];
  try{
    const saved=JSON.parse(localStorage.getItem(storageKey)||"[]");
    if(Array.isArray(saved))removed=saved.filter(folder=>typeof folder==="string" && original.files.some(file=>file.path.startsWith(folder)));
  }catch{}
  const session={name:original.name,entries:original.files,removed,storageKey,cache:{id:message.workspaceId}};
  const project=removed.length?AtlasAnalysis.withoutFolders(original,removed):original;
  stableFunctionIds(project);
  restoringGraph=!!previous;
  try{
    loadProject(project,null,session,previous?.location);
    if(previous){
      const location=reconcileLocations(previous,previous.files);
      if(location){
        if(location.mode==="callScope")prepareCallScope(location.callScope,location.callsAcrossFiles);
        state.mode=location.mode;state.selected=location.id;state.activeFile=location.activeFile;
        state.route=location.route;state.focused=location.focused;
        state.pinnedHighlight=location.pinnedHighlight;inspectorView=location.inspector;
      }else if(previous.location.mode==="call" || previous.location.mode==="callScope"){
        const scope=previous.location.mode==="call"?previous.location.activeFile:previous.location.callScope;
        if(scope==="" || state.files.has(scope) || scope.endsWith("/")&&project.files.some(file=>file.path.startsWith(scope))){
          prepareCallScope(scope,previous.location.callsAcrossFiles);
          state.mode="callScope";
          const first=currentView().items.find(item=>!item.contextOnly);
          state.selected=first?.id??null;
          state.activeFile=first?.files?.[0]?.path||first?.path||state.activeFile;state.focused=false;
        }
      }
      state.opened=previous.opened;
      state.expandedFiles=previous.expanded;
      revealTree(state.activeFile);
      Object.assign(explorerQueries,previous.queries);
      setExplorerView(previous.explorer,false);
      refresh();
      if(location){
        if(location.sourceOpen)previewSource(location.marker,false);
        byId("sourceBody").scrollTop=location.scrollTop;byId("sourceBody").scrollLeft=location.scrollLeft;
        state.x=location.x;state.y=location.y;state.scale=location.scale;
        transform();noteCanvasSize();
      }
      byId("tree").scrollTop=previous.treeScroll;byId("globalList").scrollTop=previous.globalsScroll;
      byId("details").scrollTop=previous.inspectorScroll;updateHistory();
    }
    if(!original.files.length){
      byId("emptyGraph").textContent="No C sources or headers in this workspace folder. Add a .c or .h file to start the graph.";
      byId("status").textContent="Waiting for C sources";
    }
    byId("projectMeta").textContent="Workspace folder";
    byId("projectMeta").title=message.name||original.name;
    byId("projectBadge").lastChild.textContent="Workspace";
    byId("retryWorkspace").hidden=true;
  }finally{restoringGraph=false;}
}
