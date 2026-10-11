import type { CanvasV5ProtocolSource, CanvasV5, CanvasRegionV1 } from 'hanaworlds-canvas';
import { checkProtocolCompatibility, protocolRequirement } from 'hanaworlds-contracts';
import { Context } from '@deepseek-ai/cordis';
import type { CanvasSelectionEvent } from 'hanaworlds-canvas';
declare const publicService: CanvasV5ProtocolSource;
declare const canvas: CanvasV5;
declare const region: CanvasRegionV1;
const requirement = protocolRequirement('canvas/v7', []);
checkProtocolCompatibility(publicService.protocolHandshake, [requirement]);
checkProtocolCompatibility(canvas.protocolHandshake, [requirement]);
checkProtocolCompatibility(region.protocolHandshake, [protocolRequirement('canvas-region/v3', [])]);
const ctx = new Context();
ctx.on('WorldConnectionSelectionChanged', event => {
  const operation: 'SelectWorldConnection' = event.operation;
  const wire: 'canvas/v7' = event.receipt.contractVersion;
});
ctx.on('ActiveWorldChanged', event => {
  const operation: 'SwitchWorldConnection' = event.operation;
});
declare const event: CanvasSelectionEvent;
if (event.event === 'ActiveWorldChanged') {
  const operation: 'SwitchWorldConnection' = event.operation;
}
ctx.on('AffectedObjectNotificationRequired', event => {
  const operation: 'DecideAffectedObjectNotification' = event.operation;
  const affected: ReadonlyArray<string> | undefined = event.receipt.result?.affectedObjectRefs;
});
if (event.event === 'AffectedObjectNotificationRequired') {
  const operation: 'DecideAffectedObjectNotification' = event.operation;
}
