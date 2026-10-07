import { CanvasV5, CanvasStore } from 'hanaworlds-canvas';
import type { NativeFactsPort, NativeFactsScopedState } from 'hanaworlds-canvas';
import { createFixtureNativeFactsPort, validateNativeFactsScopedState }
  from 'hanaworlds-canvas/examples/native-facts-consumer.mjs';
import * as consumer from 'hanaworlds-contracts';
const port: NativeFactsPort = await createFixtureNativeFactsPort(consumer);
const raw: NativeFactsScopedState = await port.readScopedState('local-connection', [[0, 1, 3]]);
const checked: NativeFactsScopedState = validateNativeFactsScopedState(raw, consumer);
declare const store: CanvasStore;
new CanvasV5({ store, nativeFacts: port });
checked.stateProfile.profileVersion satisfies 'state-profile/v2';
