import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CanvasV5, CanvasStore } from '../src/index.mjs';
import { ObjectsHistoryView } from '../src/display-view.mjs';
import { createUndoExample } from './support/undo-example.mjs';
import { undoSessionRef } from './support/undo-fixture-world.mjs';
import { openOfficialNavigationFixture } from './support/source-boundary-ui.mjs';

let official;
before(async () => { official = await openOfficialNavigationFixture(); });
after(async () => { await official?.close(); });

function loadCanvasClient(source) {
  let factory;
  vm.runInNewContext(source, {
    window:{ __ModuleLoader__:{ load(entry) { factory = entry.factory; } } },
    document:{ head:{ append() {} }, createElement:()=>({ dataset:{}, remove() {} }) },
  });
  return factory(id => { assert.equal(id, 'react'); return official.React; });
}
async function compose(t, panelId) {
  const directory = await mkdtemp(fileURLToPath(new URL('../../q127-navigation-profile-', import.meta.url)));
  const { Context, Service } = official.runtime;
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await rm(directory, { recursive:true, force:true }); });
  const storePath = join(directory, 'canvas');
  await createUndoExample(storePath); // Existing public Canvas operations; world inputs are fixtures.
  const canvas = new CanvasV5({ store:await CanvasStore.open(storePath) });
  const renderer = await official.load('dsh-client-ui-renderer');
  new renderer.SlotRegistry(ctx);
  assert.ok(ctx.get('slots') instanceof Service, 'Official renderer and client share one browser runtime');
  const slots = ctx.get('slots');
  slots.register({ name:'root', children:{ main:{kind:'keyed',scope:'root'},
    sidebar:{kind:'single',scope:'root'}, 'shell.leading':{kind:'single',scope:'root'} } }, () => null);
  let selected = null;
  const { LayoutController } = await official.load('dsh-client-ui-layout');
  const layout = new LayoutController({ selectPanel(id) { selected=id; },
    toggleSidebar() {}, openRightbar() {}, closeRightbar() {} },
    id => slots.entries('main').some(row => row.options.key === id),
    { getSnapshot:()=>({activePanelId:selected}), subscribe:()=>()=>{} });
  t.after(() => layout.dispose());
  ctx.provide('layout', layout);
  // Non-navigation shell inputs and Remote transport are explicit fixtures.
  ctx.provide('locale', { register:()=>()=>{}, subscribe:()=>()=>{} });
  ctx.provide('uiWorkspace', { startSession() {} });
  ctx.provide('shortcuts', { catalog:{ getSnapshot:()=>[], subscribe:()=>()=>{} } });
  ctx.provide('sessions', {});
  let reads=0;
  new class extends Service {
    constructor() {
      super(ctx, 'remote');
      this.hanaworldsCanvasDisplay = {
        read:async ref => { reads++; return {ok:true,value:await canvas.readObjectsHistory(ref)}; },
        actions:async () => ({ok:true,value:{state:'READY',worldRef:'undo-fixture-world',objects:[]}}),
        changes:() => ({ dispose() {}, async *[Symbol.asyncIterator]() {} }),
      };
    }
    async $mount() { return async () => {}; }
  }();
  ctx.provide('remote.hanaworldsCanvasDisplay', ctx.get('remote').hanaworldsCanvasDisplay);
  await ctx.plugin(await official.load('dsh-client-ui-sidebar'));
  const bundle = loadCanvasClient(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'));
  const fiber = ctx.plugin({ name:'independently-renamed-canvas-client', inject:bundle.inject,
    apply:c => bundle.apply(c, panelId === undefined ? undefined : {panelId}) });
  await fiber;
  const row = slots.entriesOfSlot('sidebar.panellist').find(row => row.options.label() === '对象与历史（Canvas）');
  assert.ok(row, 'Canvas publishes its actual navigation target');
  const main = slots.entries('main').find(entry => entry.options.key === row.options.id);
  assert.ok(main, 'Sidebar and main use the same actual keyed target');
  return { ctx, fiber, row, main, layout, slots, get selected() { return selected; }, get reads() { return reads; } };
}
const sessions = select => select({byId:{[undoSessionRef]:{id:undoSessionRef,retainedBy:{mainView:1}}}});

for (const panelId of [undefined, 'renamed-canvas-public-target'])
test(`official live navigation selects and reads Canvas objects/history: ${panelId ?? 'default'}`, async t => {
  const env = await compose(t, panelId);
  if (panelId !== undefined) assert.equal(env.row.options.id, panelId, 'A legitimate renamed target must be registered');
  env.layout.selectPanel(env.row.options.id);
  assert.equal(env.selected, env.row.options.id);
  const panel = env.main.component({useSessions:sessions});
  const view = await panel.props.read(undoSessionRef);
  assert.equal(view.state, 'READY');
  assert.equal(view.objects.length, 2);
  assert.equal(view.history.length, 2);
  assert.equal(env.reads, 1);
  const html = official.renderToStaticMarkup(official.React.createElement(ObjectsHistoryView, {view,pending:false,error:null}));
  assert.match(html, /对象/); assert.match(html, /历史/);
  for (const invalid of ['', 'missing-target', 'wrong-target'])
    assert.throws(() => env.layout.selectPanel(invalid), /not registered/);
  const navigation = env.layout.beginNavigation();
  env.layout.selectPanel(env.row.options.id);
  assert.equal(navigation.aborted, true);
  await env.fiber.dispose();
  assert.equal(env.slots.entries('main').length, 0);
  assert.equal(env.slots.entriesOfSlot('sidebar.panellist').length, 0);
  assert.throws(() => env.layout.selectPanel(env.row.options.id), /not registered/);
});
for (const panelId of ['', 17])
test(`invalid public Canvas navigation target is named and never read: ${JSON.stringify(panelId)}`, async t => {
  const env = await compose(t, panelId);
  env.layout.selectPanel(env.row.options.id);
  const html = official.renderToStaticMarkup(env.main.component({useSessions:sessions}));
  assert.match(html, /INVALID_CANVAS_PANEL_ID/);
  assert.equal(env.reads, 0);
});
