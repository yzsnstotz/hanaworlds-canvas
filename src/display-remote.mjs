import { z } from 'zod';

// Authored against the public Typert descriptor API; no private Desktop bridge.
const triple = z.tuple([z.number().int(), z.number().int(), z.number().int()]);
const displaySchema = () => z.object({
  state: z.enum(['NO_SESSION', 'NO_WORLD', 'EMPTY', 'READY']), worldRef: z.string().nullable(),
  objects: z.array(z.object({ objectRef: z.string(), name: z.string().nullable(),
    occupiedCells: z.number().int().nonnegative(), bounds: z.object({ min: triple,
      max: triple, size: triple }).nullable() })),
  history: z.array(z.object({ transactionId: z.string(), objectRef: z.string(),
    objectName: z.string().nullable(), sequence: z.number().int(),
    committedAt: z.string().nullable(), mode: z.enum(['CELL', 'REGION']).nullable(),
    affectedCells: z.number().int().nonnegative().nullable(), status: z.enum(['COMMITTED', 'UNDONE']) })),
});
export const displayDescriptor = {
  id: 'hanaworlds-canvas#hanaworldsCanvasDisplay/read',
  service: 'hanaworldsCanvasDisplay', namespace: 'hanaworldsCanvasDisplay', method: 'read',
  invocation: { kind: 'direct' },
  parameters: [{ name: 'sessionRef', wire: 'sessionRef', source: 'json',
    codec: { mode: 'strict', typeSymbol: 'hanaworlds-canvas#DisplaySessionRef',
      create: () => z.string().min(1).nullable() } }],
  result: { mode: 'strict', typeSymbol: 'hanaworlds-canvas#ObjectsHistoryDisplay', create: displaySchema },
};
export const displayHostContribution = { package: 'hanaworlds-canvas-display', face: 'host',
  schemas: [], invocations: [displayDescriptor], model: {} };
export const displayClientContribution = { package: 'hanaworlds-canvas-display', descriptors: [displayDescriptor] };
