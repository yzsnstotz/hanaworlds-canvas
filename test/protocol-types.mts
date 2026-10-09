import type { CanvasV5ProtocolSource, CanvasV5, CanvasRegionV1 } from 'hanaworlds-canvas';
import { checkProtocolCompatibility, protocolRequirement } from 'hanaworlds-contracts';
declare const publicService: CanvasV5ProtocolSource;
declare const canvas: CanvasV5;
declare const region: CanvasRegionV1;
const requirement = protocolRequirement('canvas/v6', []);
checkProtocolCompatibility(publicService.protocolHandshake, [requirement]);
checkProtocolCompatibility(canvas.protocolHandshake, [requirement]);
checkProtocolCompatibility(region.protocolHandshake, [protocolRequirement('canvas-region/v2', [])]);
