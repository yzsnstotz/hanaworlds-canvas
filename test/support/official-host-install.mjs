import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runPluginCommand } from '@deepseek-ai/dsh-plugin-manager/operations';

// Runs inside the independent official installation, through the same locked
// package-operation API as `dsh plugin`. No peer exemption or policy switch.
const require = createRequire(import.meta.url);
const [profile, tgz, pnpm] = process.argv.slice(2);
const result = await runPluginCommand({ profile: 'canvas-host-supply-test', dir: profile,
  home: profile, cwd: profile, installAnchor: require.resolve('@deepseek-ai/dsh/package.json') },
['add', '--save-exact', tgz], { command: process.execPath, args: [pnpm], execution: 'service',
  outputBytes: 4 * 1024 * 1024, activateNewBundles: true,
  onOutput: (value, stream) => process[stream].write(value) });
await writeFile(new URL('./manager-result.json', import.meta.url), JSON.stringify(result, null, 2));
assert.equal(result.exitCode, 0, `Official manager rejected Canvas: ${result.logPath}`);
