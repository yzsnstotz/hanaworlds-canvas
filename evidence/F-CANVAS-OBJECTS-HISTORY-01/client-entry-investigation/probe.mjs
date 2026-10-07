import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
const root='/Users/yzliu/.cache/hanaworlds-runs/S1-CANVAS-REGION-UNDO-01/source';
const sdk='/Applications/HanaWorlds.app/Contents/Resources/hanaworlds-dsh/node_modules';
const req=createRequire(root+'/package.json');
const cordis=await import(sdk+'/@deepseek-ai/cordis/lib/index.js');
const slotsCore=await import(sdk+'/@deepseek-ai/dsh-client-ui-slots/lib/index.js');
const seed={'@deepseek-ai/cordis':cordis,'@deepseek-ai/dsh-client-ui-slots':slotsCore};
const doc={head:{append(){}},createElement(){return {dataset:{},remove(){}}}};
function bundle(path){let registration;vm.runInNewContext(readFileSync(path,'utf8'),{window:{__ModuleLoader__:{load(v){registration=v}}},crypto:webcrypto,document:doc,console,queueMicrotask,AbortController,URL,Symbol,setTimeout,clearTimeout});return registration.factory(id=>seed[id]??req(id));}
const renderer=bundle(sdk+'/@deepseek-ai/dsh-client-ui-renderer/lib/client.js');
const registry=bundle(sdk+'/@deepseek-ai/dsh-typert-registry/lib/client.js');
const gateway=bundle(sdk+'/@deepseek-ai/dsh-api-gateway/lib/client.js');
const client=bundle(root+'/lib/client.js');
const ctx=new cordis.Context();
try{
 await ctx.plugin(registry);
 ctx.provide('connection',{registerGenerationSource(){return ()=>{}},rpc:{open(){},call(){throw Error('not called')}},start(){return {stop(){}}},generation:{getSnapshot(){return null}}});
 await ctx.plugin(gateway);
 const slots=new renderer.SlotRegistry(ctx);
 slots.register({name:'root',children:{main:{kind:'keyed',scope:'root'},'sidebar.panellist':{kind:'list',scope:'root'}}},()=>null);
 ctx.provide('sessions',{});ctx.provide('layout',{});
 console.log('before apply',Object.keys(client),!!ctx.remote,!!ctx.slots);
 await ctx.plugin(client);
 assert.equal(slots.entries('main').length,1);
 assert.equal(slots.entries('main')[0].options.key,client.name);
 assert.equal(slots.entries('sidebar.panellist').length,1);
 assert.equal(slots.entries('sidebar.panellist')[0].options.id,client.name);
 assert.equal(slots.entries('sidebar.panellist')[0].options.label(),'对象与历史（Canvas）');
 assert.equal(typeof ctx.remote.hanaworldsCanvasDisplay.read,'function');
 console.log('after apply',slots.entries('main'),slots.entries('sidebar.panellist'));
 console.log('CLIENT_ENTRY_ASSERTIONS_PASS; real Cordis/ClientRemote/SlotRegistry, document+Connection+Session/layout fixture, no App/profile');
}catch(error){console.error(error.stack);process.exitCode=1;}
finally{await ctx.fiber.dispose();}
