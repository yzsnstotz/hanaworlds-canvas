import type { CanvasV5 } from 'hanaworlds-canvas';
import type { CatalogueFacts } from '../types/protocol/index.js';
declare const canvas: CanvasV5;
const value: { provider: { providerRef: string; providerRevision: string }; facts: CatalogueFacts } = await canvas.readCatalogue({ sessionRef: 'S' });
value.facts.catalogue.profileVersion satisfies 'catalogue/v3';
value.facts.connection.connectionIncarnationRef satisfies string;
value.facts.presentation['material'].color satisfies string | null;
value.facts.orientationIndex[0].quarterTurnsAboutUp satisfies number | null;
await canvas.readCatalogue({ sessionRef: 'S', expectedConnection: value.facts.connection,
  expectedCatalogueDigest: value.facts.catalogueDigest, expectedProvider: value.provider });
// @ts-expect-error sessionRef is required
await canvas.readCatalogue({});
// @ts-expect-error full three-field connection is required
await canvas.readCatalogue({ sessionRef: 'S', expectedConnection: { worldRef: 'W' } });
// @ts-expect-error renderer cannot select a world through this read
await canvas.readCatalogue({ sessionRef: 'S', worldRef: 'W' });
// @ts-expect-error digest is an opaque string, not a numeric revision
await canvas.readCatalogue({ sessionRef: 'S', expectedCatalogueDigest: 1 });
// @ts-expect-error complete provider identity needs both references
await canvas.readCatalogue({ sessionRef: 'S', expectedProvider: { providerRef: 'P' } });
