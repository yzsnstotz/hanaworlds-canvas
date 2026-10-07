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
  readScopedState(connectionRef: Ref, positions: Positions): Promise<NativeFactsScopedState>;
}
