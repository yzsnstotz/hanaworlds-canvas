import type { CanvasFactsScope, CanvasSourceFacts, CatalogueHostFacts } from './index.js';
import type { Ref, Positions, StateProfile, ScopedCells } from './protocol/index.js';

/** Documented C-world-facts@2 Host read, preserving opaque source digests. */
export interface NativeFactsScopedState {
  readonly worldRef: Ref;
  readonly stateProfile: StateProfile;
  readonly cells: ScopedCells;
}
export interface NativeFactsPort {
  readScopedState(connectionRef: Ref, positions: Positions): NativeFactsScopedState | Promise<NativeFactsScopedState>;
}
/** C-world-facts (world-facts/v1) port of the bound World's source (Host key hanaworldsWorldFacts).
 * Canvas reads the provider-bearing Catalogue Host method. Host ReadWriteProfile is a Bridge
 * runtime handoff, never authorization for Canvas to read the Adapter. */
export interface WorldFactsPort {
  readonly protocolHandshake?: unknown;
  readonly contractHandshake?: unknown;
  readScopedState?: NativeFactsPort['readScopedState'];
  readCanvasFacts?(scope: CanvasFactsScope): Promise<CanvasSourceFacts>;
  readCatalogue?(scope: CanvasFactsScope): Promise<CatalogueHostFacts>;
  call?(operation: 'ReadCatalogue' | 'ReadWriteProfile', request: unknown): Promise<unknown>;
}
