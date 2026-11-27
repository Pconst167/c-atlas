"use strict";

const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const test=require("node:test");
const vm=require("node:vm");

const read=name=>fs.readFileSync(path.join(__dirname,"..","webview",name),"utf8");

test("webview reveals the latest exact Explorer file, preserves the dependency view and never requests native source",()=>{
  const replies=[],actions=[];
  let receive;
  const files=new Map([
    ["engine/render.c",{functions:["draw"]}],
    ["tests/render.c",{functions:["test_draw"]}],
    ["engine/color.h",{functions:[]}],
    ["engine/setup.c",{functions:[]}],
    ["assets/sky.frag",{functions:[]}]
  ]);
  const state={mode:"structure",files,selected:null,activeFile:null};
  const context=vm.createContext({
    window:{addEventListener(type,fn){if(type==="message")receive=fn;}},
    document:{getElementById(){return {};}},
    acquireVsCodeApi:()=>({postMessage(message){replies.push({...message});}}),
    state,AtlasAnalysis:{isHeaderFile:file=>file.endsWith(".h")},
    openCallScope(file){state.mode="callScope";state.activeFile=file;actions.push(["functions",file]);},
    visitSelection(file,mode,showSource){
      assert.equal(showSource,false);
      state.mode=mode;state.selected=file;actions.push([mode,file]);
    },
    notify(text){actions.push(["notice",text]);}
  });
  vm.runInContext(read("workspace.js"),context);
  vm.runInContext('function startGraph(){return {receiveProject(){},revealWorkspaceFile};}',context);
  vm.runInContext(read("bootstrap.js"),context);
  const reveal=(file,requestId)=>receive({data:{type:"revealFile",path:file,requestId}});
  reveal("tests/render.c",1);
  reveal("engine/render.c",2);
  assert.deepEqual(actions,[]);
  receive({data:{type:"project",workspaceId:"test",project:{files:[]}}});
  assert.deepEqual(actions,[["functions","engine/render.c"]]);
  assert.deepEqual(replies.at(-1),{type:"fileRevealed",path:"engine/render.c",requestId:2,found:true});

  reveal("engine/color.h",3);
  reveal("engine/color.h",4);
  assert.equal(actions.filter(([mode])=>mode==="headers").length,1);
  assert.deepEqual(actions.at(-1),["headers","engine/color.h"]);
  reveal("tests/render.c",5);
  assert.deepEqual(actions.at(-1),["functions","tests/render.c"]);
  reveal("engine/setup.c",6);
  assert.deepEqual(actions.at(-1),["include","engine/setup.c"]);
  reveal("assets/sky.frag",7);
  reveal("engine/render.c",8);
  assert.deepEqual(actions.at(-1),["include","engine/render.c"]);
  reveal("missing/render.c",9);
  assert.equal(actions.at(-1)[0],"notice");
  assert.deepEqual(replies.at(-1),{type:"fileRevealed",path:"missing/render.c",requestId:9,found:false});
  assert.ok(!replies.some(message=>message.type==="openSource"));
});
