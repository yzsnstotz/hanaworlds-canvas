import { Context } from '@deepseek-ai/cordis';
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry';
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway';
import type { TypertCodec } from '@deepseek-ai/dsh-typert-protocol/types';
import { z } from 'zod';
import canvasPlugin, { apply, Config, type CanvasHostContext,
  type CanvasConfig, type CanvasV5, type CanvasRegionV1, type ObjectsHistoryDisplay } from 'hanaworlds-canvas';
import displayPlugin, { CanvasDisplayService } from 'hanaworlds-canvas/display';

// Public declarations must compose after the official Host augmentations load.
// No `any`, context cast, local replacement interface or skipLibCheck escape.
const ctx = new Context();
const host: CanvasHostContext = ctx;
const config: CanvasConfig = { placement: { frontGapCells: 0, forwardSearchCells: 3 } };
const validated: CanvasConfig = Config(config);
ctx.plugin(TypertRegistry);
ctx.plugin(TypertGatewayService, { websocketHeartbeatIntervalMs: 2000, streamInboxBytes: 262144 });
ctx.plugin(canvasPlugin, validated);
ctx.plugin(displayPlugin);
const display = new CanvasDisplayService(ctx);
const view: ObjectsHistoryDisplay = await display.read(null);
view.state satisfies 'NO_SESSION' | 'NO_WORLD' | 'EMPTY' | 'READY';
type IsAny<T> = 0 extends (1 & T) ? true : false;
const readMustBeTyped: IsAny<Awaited<ReturnType<CanvasDisplayService['read']>>> = false;
// @ts-expect-error display session input cannot be an object
await display.read({ sessionRef: 'S' });
await display.actions(null);
const service: CanvasV5 = apply(host, validated);
const codec: TypertCodec = { mode: 'strict', typeSymbol: 'canvas-host-test#ref',
  create: () => z.string().min(1).nullable() };
codec.create().parse(null);
declare const region: CanvasRegionV1;
await service.readObjectsHistory(null);
await region.describe(null);
