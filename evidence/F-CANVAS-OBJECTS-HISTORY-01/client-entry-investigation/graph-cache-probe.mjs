import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const sdk='/Applications/HanaWorlds.app/Contents/Resources/hanaworlds-dsh/node_modules/@deepseek-ai/';
const {Context}=await import(sdk+'cordis/lib/index.js');
const {ClientModuleRegistry}=await import(sdk+'dsh-client-modules/lib/index.js');
const root='/Users/yzliu/.cache/hanaworlds-runs/S1-CANVAS-REGION-UNDO-01/source';
const run='/Users/yzliu/.cache/hanaworlds-runs/F-CANVAS-OBJECTS-HISTORY-01';
const tmp=mkdtempSync(run+'/graph-cache-fixture-');
const pkgPath=tmp+'/package.json';const clientPath=tmp+'/lib/client.js';mkdirSync(tmp+'/lib');writeFileSync(tmp+'/index.mjs','');
writeFileSync(clientPath,readFileSync(root+'/lib/client.js'));
const own=JSON.parse(readFileSync(root+'/package.json'));
const noClient={...structuredClone(own),version:'0.5.3',exports:{'.':'./index.mjs'}};delete noClient.dsh.client;
const entry={options:{name:tmp+'/index.mjs'},fiber:{},disabled:false,parent:{tree:{ctx:{baseUrl:pathToFileURL(tmp+'/tree.yml').href}}}};
async function compose(){const ctx=new Context();ctx.provide('loader',{entries(){return [entry]}});await ctx.plugin(ClientModuleRegistry);return ctx;}
let current,fresh;
try{
 writeFileSync(pkgPath,JSON.stringify(noClient));current=await compose();
 assert.equal(current.clientModules.graph().entries.length,0);
 writeFileSync(pkgPath,JSON.stringify({...own,exports:{...own.exports,'.':'./index.mjs'}}));
 current.emit('internal/plugin',{entry});await Promise.resolve();
 assert.equal(current.clientModules.graph().entries.length,0,'running registry retains old negative declaration');
 fresh=await compose();
 assert.deepEqual(fresh.clientModules.graph().entries.map(x=>x.id),['hanaworlds-canvas']);
 console.log(JSON.stringify({real:'official ClientModuleRegistry+Cordis Context',fixture:'loader entries and own run package files, no App/profile',oldManifest:'no dsh.client',initialGraph:[],afterPackageReplacementAndLifecycleEvent:[],freshRegistryGraph:fresh.clientModules.graph().entries,success:true},null,2));
}finally{if(fresh)await fresh.fiber.dispose();if(current)await current.fiber.dispose();rmSync(tmp,{recursive:true,force:true});}
