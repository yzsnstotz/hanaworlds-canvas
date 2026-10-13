import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import canonicalize from 'canonicalize';
import { Context, Service } from '@deepseek-ai/cordis';
import canvasPlugin, { STORE_ROOT } from '../src/index.mjs';
import { prepareSummaryPeers } from '../scripts/production-summary-fixture.mjs';

test('public summary names malformed Frame versions as bad facts, then reads restored facts without a write',async t => {
  const directory = await mkdtemp(fileURLToPath(new URL('../../d70-summary-version-',import.meta.url)));
  const peers = await prepareSummaryPeers(join(directory,'data',STORE_ROOT));
  const source = {kind:'LOADED_WORLD_DECLARATION',factRef:'declaration:tools',revision:'declaration-generation:3'};
  const unit = {name:'world-cell',metersPerGridUnit:null};
  const body = {profileVersion:'canvas-source-facts/v1',connection:peers.scope,
    provider:{providerRef:'opaque-provider:1',providerRevision:'opaque-generation:1'},
    tools:[{toolRef:'tool:fill',purpose:{value:'填充选定区域',source},
      typicalScale:{value:{size:[7,5,9],unit:unit.name},source}}],
    unit:{value:unit,source},frame:{value:{profileVersion:'frame/v2',frameId:'frame:world',
      origin:[0,0,0],axes:['+X','+Y','+Z'],handedness:'left',gridUnit:unit,transformRevision:'r3'},source},
    partition:{value:{edge:[16,16,16]},source:{kind:'NATIVE_OBSERVATION',factRef:'partition:1',revision:'r4'}}};
  const ctx = new Context(); t.after(() => ctx.fiber.dispose());
  ctx.provide('dshHomePath',(...parts) => join(directory,...parts));
  let worldWrites=0,commits=0;
  ctx.provide('hanaworldsWorldAdapterV6',{...peers.world.adapter,call(operation,request) {
    if (!/^(Read|Discover|List|Inspect)/.test(operation)) worldWrites++;
    return peers.world.adapter.call(operation,request);
  }});
  ctx.provide('hanaworldsWorkshopV3',peers.sessions);
  await ctx.plugin({name:'declared-renamed-world-source',apply(owner) {
    new class extends Service {
      constructor() { super(owner,'hanaworldsWorldFacts'); }
      async readCanvasFacts(scope) {
        assert.deepEqual(scope,peers.scope);
        assert.equal(this.ctx.get('hanaworldsCanvasV5'),canvas);
        return structuredClone({...body,sourceRevision:createHash('sha256').update(canonicalize(body)).digest('hex')});
      }
    }();
  }});
  await ctx.plugin(canvasPlugin);
  const canvas=ctx.get('hanaworldsCanvasV5'); await canvas.ready;
  assert.equal(canvas.storageState,'READY');
  const before=canonicalize(canvas.store.snapshot);
  const commit=canvas.store.commit.bind(canvas.store);
  canvas.store.commit=(...args) => { commits++; return commit(...args); };
  const request={sessionRef:peers.sessionRef};
  const normal=await canvas.readToolSummary(request);
  for (const version of ['frame/v1','invalid',null,3]) {
    body.frame.value.profileVersion=version;
    await assert.rejects(() => canvas.readToolSummary(request),error =>
      error.publicError?.code==='SCHEMA_INVALID' && error.publicError.mutationState==='NONE' &&
      error.publicError.transactionRef===null);
  }
  body.frame.value.profileVersion='frame/v2';
  const restored=await canvas.readToolSummary(request);
  assert.deepEqual(restored,normal);
  assert.equal(canonicalize(canvas.store.snapshot),before);
  assert.equal(commits,0); assert.equal(worldWrites,0);
  await writeFile(join(directory,'read-audit.json'),JSON.stringify({before,after:canonicalize(canvas.store.snapshot),
    commits,worldWrites,restored:true},null,2));
});
