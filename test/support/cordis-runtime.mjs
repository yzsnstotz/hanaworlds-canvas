import { Context } from 'cordis';
import { join } from 'node:path';
import { fixtureSessions } from '../../scripts/fixture-sessions.mjs';

const canvasModule = await import(process.env.CANVAS_ENTRY ??
  new URL('../../src/index.mjs', import.meta.url).href);

// Only Host paths, Adapter/world facts and the FIXTURE session/v3 port are fixtures.
// Cordis, Canvas apply(), public service registration, and the Canvas fsynced store are real.
export async function openRuntime(profile, { adapter, nativeFacts,
  sessions = fixtureSessions() } = {}) {
  const ctx = new Context();
  ctx.provide('dshHomePath', (...parts) => join(profile, ...parts));
  if (adapter) ctx.provide('hanaworldsWorldAdapterV6', adapter);
  if (nativeFacts) ctx.provide('hanaworldsLuantiNativeFacts', nativeFacts);
  if (sessions) ctx.provide('hanaworldsWorkshopV3', sessions);
  const fiber = ctx.plugin(canvasModule.default);
  await fiber;
  const canvas = ctx.get('hanaworldsCanvasV5');
  await canvas.ready;
  return { ctx, canvas, async dispose() {
    await fiber.dispose();
    await ctx.fiber.dispose();
  } };
}
