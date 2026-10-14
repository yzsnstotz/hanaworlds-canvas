import { Context } from '@deepseek-ai/cordis';
import type { CanvasV5, CanvasConfigSupply, WorldFactsPort } from 'hanaworlds-canvas';
import type { MaterialSourceConnection, ReadWriteProfileRequest, ReadWriteProfileResponse, CompilationConfig }
  from '../types/protocol/index.js';
declare const canvas: CanvasV5;
declare const supply: CanvasConfigSupply;
declare const bridgeContext: Context;
const release: () => void = canvas.attachConfigSource(bridgeContext,
  async function (this: Context, scope: MaterialSourceConnection, request: ReadWriteProfileRequest): Promise<ReadWriteProfileResponse> {
    this satisfies Context;
    scope.connectionIncarnationRef satisfies string;
    request.contractVersion satisfies 'world-facts/v1';
    return this.get('hanaworldsWorldFacts').call('ReadWriteProfile', request);
  });
release();
const result = await supply.readCompilerConfig('W');
result.compilationConfig satisfies CompilationConfig;
result.compilerRevision satisfies string;
(await supply.read('W')).current.observedSequence satisfies number;
// Original compatibility shape remains; this type grants no Host source-reading role.
declare const compatibilityPort: WorldFactsPort;
compatibilityPort.call?.('ReadWriteProfile', {});
// @ts-expect-error JSON cannot substitute a real Cordis context
canvas.attachConfigSource({ root: 'fake', fiber: 'fake' }, async () => null);
// @ts-expect-error runtime reader must be callable
canvas.attachConfigSource(bridgeContext, {});
// @ts-expect-error source reader returns a full bound response, never a CompilationConfig alone
canvas.attachConfigSource(bridgeContext, async () => result.compilationConfig);
