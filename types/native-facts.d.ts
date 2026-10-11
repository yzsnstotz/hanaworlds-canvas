import type { Ref, Positions, StateProfile, ScopedCells } from 'hanaworlds-contracts';

/** The existing Canvas-owned injection method's complete raw return. This is
 * not ScopedWorldBinding, a new Contracts wire, or a request/response envelope.
 */
export interface NativeFactsScopedState {
  readonly worldRef: Ref;
  readonly stateProfile: StateProfile;
  readonly cells: ScopedCells;
}
export interface NativeFactsPort {
  readScopedState(connectionRef: Ref, positions: Positions): NativeFactsScopedState | Promise<NativeFactsScopedState>;
}
/** C-world-facts (world-facts/v1) port of the bound World's source (Host key hanaworldsWorldFacts).
 * Canvas reads ReadCatalogue and ReadWriteProfile; absence is refused by name, never defaulted. */
export interface WorldFactsPort {
  readonly protocolHandshake?: unknown;
  readonly contractHandshake?: unknown;
  call?(operation: 'ReadCatalogue' | 'ReadWriteProfile', request: unknown): Promise<unknown>;
}
