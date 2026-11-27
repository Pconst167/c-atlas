const previewSource=openSourcePanel;

function sourceLocation(marker){
  const item=currentView()?.byKey.get(state.selected);
  if(!item||item.folder||item.external&&!marker)return null;
  const fn=showsFunctions()?state.functions.get(item.id):null;
  const file=state.files.get(marker?.path||fn?.path||item.path);
  if(typeof file?.source!=="string")return null;
  const offset=marker?.offset??fn?.nameOffset??0;
  const line=marker?.line??fn?.line??1;
  const column=offset===0?1:offset-file.source.lastIndexOf("\n",offset-1);
  return {path:file.path,line,column};
}
function revealInEditor(marker){
  const location=sourceLocation(marker);
  if(!location)return false;
  editor.postMessage({type:"openSource",...location});
  return true;
}

// The graph's normal source actions (symbol search, variables, call sites and blocks)
// now open the real document. The Inspector also keeps its searchable linked preview.
openSourcePanel=function(marker=null,record=true){
  if(!revealInEditor(marker)||!byId("sourcePanel").hidden)previewSource(marker,record);
};
byId("showSource").onclick=()=>{
  previewSource();byId("sourceBody").focus({preventScroll:true});
};
const renderPreview=renderSource;
renderSource=function(marker=null){
  renderPreview(marker);
  byId("openEditor").hidden=!sourceLocation(marker);
};
byId("openEditor").onclick=()=>revealInEditor(displayedDeclaration);
byId("exportGraph").onclick=()=>{
  const diagram=diagramSvg();
  if(diagram)editor.postMessage({type:"saveSvg",name:state.project.name+"-"+state.mode+".svg",
    svg:new XMLSerializer().serializeToString(diagram)});
};
