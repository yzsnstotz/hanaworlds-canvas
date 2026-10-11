import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { regionCapabilities } from 'hanaworlds-contracts';
import { ADAPTER_REGION_REQUIREMENT, ADAPTER_CELL_REQUIREMENT, CANVAS_REGION_CAPABILITIES,
  REGION_WIRE } from '../src/index.mjs';

// J3.S2: the Adapter requirement is every capability Contracts assigns to the world-source role,
// whatever package fills it; no world source package name appears in Canvas's region code.
test('region ownership is read by role and wire, never by a package name', async () => {
  const worldSource = regionCapabilities.filter(c => c.owner === 'world-source').map(c => c.id).sort();
  assert.ok(worldSource.length > 0);
  assert.deepEqual([...ADAPTER_REGION_REQUIREMENT.capabilities, ...ADAPTER_CELL_REQUIREMENT.capabilities]
    .sort(), worldSource);
  assert.deepEqual(CANVAS_REGION_CAPABILITIES, regionCapabilities
    .filter(c => c.id.startsWith(`${REGION_WIRE}:`)).map(c => c.id).sort());
  const source = await readFile(new URL('../src/region-v1.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /owner\s*===\s*'hanaworlds-|adapter-luanti|[Ll]uanti/);
});
