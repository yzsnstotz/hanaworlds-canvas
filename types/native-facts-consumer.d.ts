import type { NativeFactsPort, NativeFactsScopedState } from './native-facts.js';
type PublicConsumer = Pick<typeof import('hanaworlds-contracts'), 'validateType' | 'canonicalJSON'>;
export function validateNativeFactsScopedState(raw: unknown, consumer?: PublicConsumer): NativeFactsScopedState;
/** Explicit fixed SOURCE/FIXTURE provider only. */
export function createFixtureNativeFactsPort(consumer?: PublicConsumer): Promise<NativeFactsPort>;
