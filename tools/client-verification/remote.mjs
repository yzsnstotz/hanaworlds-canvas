import { z } from 'zod';

// This namespace belongs to the separately loaded observation tool. It is not
// a Canvas business API. A recursive JSON codec preserves every nested DTO key
// instead of stripping fields from request/response/source/error evidence.
const jsonObject = () => z.record(z.string(), z.json());
const parameter = name => ({ name, wire: name, source: 'json', codec: {
  mode: 'strict', typeSymbol: `canvas-client-verification#${name}`,
  create: () => z.string().min(1),
} });
const descriptor = (method, parameters) => ({
  id: `canvas-client-verification#hanaworldsCanvasVerification/${method}`,
  service: 'hanaworldsCanvasVerification', namespace: 'hanaworldsCanvasVerification',
  method, invocation: { kind: 'direct' }, parameters,
  cancellation: { parameter: 'signal' },
  result: { mode: 'strict', typeSymbol: `canvas-client-verification#${method}Result`, create: jsonObject },
});
export const inspectDescriptor = descriptor('inspect', []);
export const invokeDescriptor = descriptor('invoke', [parameter('caseId'), parameter('mode')]);
export const verificationDescriptors = [inspectDescriptor, invokeDescriptor];
export const verificationClientContribution = {
  package: 'hanaworlds-canvas-client-verification', descriptors: verificationDescriptors,
};
export const verificationHostContribution = {
  package: 'hanaworlds-canvas-client-verification', face: 'host', schemas: [],
  invocations: verificationDescriptors, model: {},
};
