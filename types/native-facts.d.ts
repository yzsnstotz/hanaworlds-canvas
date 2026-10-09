import type { Ref, Positions, StateProfile, ScopedCells, Catalogue, ConfigEngineFacts } from 'hanaworlds-contracts';

/** The existing Canvas-owned injection method's complete raw return. This is
 * not ScopedWorldBinding, a new Contracts wire, or a request/response envelope.
 */
export interface NativeFactsScopedState {
  readonly worldRef: Ref;
  readonly stateProfile: StateProfile;
  readonly cells: ScopedCells;
}
export interface NativeFactsPort {
  /** Read-only public engine facts; no player geometry. Optional absence is refused by name. */
  readCatalogue?(worldRef: Ref): Catalogue | Promise<Catalogue>;
  readConfigEngineFacts?(worldRef: Ref): ConfigEngineFacts | Promise<ConfigEngineFacts>;
  readScopedState(connectionRef: Ref, positions: Positions): NativeFactsScopedState | Promise<NativeFactsScopedState>;
}
