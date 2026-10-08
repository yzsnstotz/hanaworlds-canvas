import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry';
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway';
const { default: displayPlugin } = await import(process.env.CANVAS_DISPLAY_ENTRY ?? new URL('../src/display-host.mjs', import.meta.url).href);

test('public DSH Gateway exposes exactly the display read method and rejects extra/invalid inputs', async () => {
  const ctx = new Context();
  await ctx.plugin(TypertRegistry);
  const calls = [];
  const view = { state: 'EMPTY', worldRef: 'world-1', objects: [], history: [] };
  ctx.provide('hanaworldsCanvasV5', { async readObjectsHistory(sessionRef) { calls.push(sessionRef); return view; } });
  const fiber = ctx.plugin(displayPlugin); await fiber;
  const gateway = new TypertGatewayService(ctx, { websocketHeartbeatIntervalMs: 2000, streamInboxBytes: 262144 });
  assert.deepEqual(await gateway.invoke({ namespace: 'hanaworldsCanvasDisplay', method: 'read', args: { sessionRef: 'session-1' } }), view);
  assert.deepEqual(calls, ['session-1']);
  await assert.rejects(() => gateway.invoke({ namespace: 'hanaworldsCanvasDisplay', method: 'read', args: { sessionRef: {}, worldRef: 'world-2' } }));
  await assert.rejects(() => gateway.invoke({ namespace: 'hanaworldsCanvasDisplay', method: 'write', args: {} }));
  assert.deepEqual(calls, ['session-1']);
  await fiber.dispose(); await ctx.fiber.dispose();
});

test('the single Canvas package entry automatically registers display in a real DSH Context', async () => {
  const { default: canvasPlugin } = await import(process.env.CANVAS_ENTRY ?? new URL('../src/index.mjs', import.meta.url).href);
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const profile = await mkdtemp(join(tmpdir(), 'canvas-dsh-display-'));
  const ctx = new Context();
  try {
    await ctx.plugin(TypertRegistry);
    ctx.provide('dshHomePath', (...parts) => join(profile, ...parts));
    await ctx.plugin(canvasPlugin);
    const canvas = ctx.get('hanaworldsCanvasV5'); await canvas.ready;
    assert.ok(ctx.get('hanaworldsCanvasDisplay'), 'one-entry Canvas bundle must own the display service');
    const gateway = new TypertGatewayService(ctx, { websocketHeartbeatIntervalMs: 2000, streamInboxBytes: 262144 });
    const result = await gateway.invoke({ namespace: 'hanaworldsCanvasDisplay', method: 'read', args: { sessionRef: null } });
    assert.deepEqual(result, { state: 'NO_SESSION', worldRef: null, objects: [], history: [] });
  } finally { await ctx.fiber.dispose(); await rm(profile, { recursive: true, force: true }); }
});

test('display namespace has exactly read/actions/undo, and undo accepts only the clicked row', async () => {
  const ctx = new Context();
  await ctx.plugin(TypertRegistry);
  const calls = [];
  ctx.provide('hanaworldsCanvasV5', {
    async readObjectsHistory() { return { state: 'EMPTY', worldRef: 'world-1', objects: [], history: [] }; },
    async readHistoryActions(sessionRef) { calls.push(['actions', sessionRef]); return { state: 'EMPTY', worldRef: 'world-1', objects: [] }; },
    async call(...args) { calls.push(['call', ...args]); throw new Error('must not be called'); } });
  const fiber = ctx.plugin(displayPlugin); await fiber;
  const gateway = new TypertGatewayService(ctx, { websocketHeartbeatIntervalMs: 2000, streamInboxBytes: 262144 });
  const invoke = (method, args) => gateway.invoke({ namespace: 'hanaworldsCanvasDisplay', method, args });
  assert.deepEqual(await invoke('actions', { sessionRef: null }), { state: 'NO_SESSION', worldRef: null, objects: [] });
  assert.deepEqual(await invoke('actions', { sessionRef: 's-1' }), { state: 'EMPTY', worldRef: 'world-1', objects: [] });
  // Renderer-supplied world/revisions/context are rejected by the strict descriptor.
  await assert.rejects(() => invoke('undo', { sessionRef: 's-1', objectRef: 'o', historyTransactionId: 't', worldRef: 'w' }));
  await assert.rejects(() => invoke('undo', { sessionRef: 's-1', objectRef: 'o', historyTransactionId: 't', localContext: {} }));
  await assert.rejects(() => invoke('undo', { sessionRef: null, objectRef: 'o', historyTransactionId: 't' }));
  await assert.rejects(() => invoke('undo', { sessionRef: 's-1', objectRef: 'o', historyTransactionId: 't' }),
    error => error.details?.reason === 'OBJECT_NOT_FOUND');
  await assert.rejects(() => invoke('redo', { sessionRef: 's-1', objectRef: 'o', historyTransactionId: 't' }));
  assert.equal(calls.filter(([kind]) => kind === 'call').length, 0);
  await fiber.dispose(); await ctx.fiber.dispose();
});
