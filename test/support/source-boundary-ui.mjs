import vm from 'node:vm';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

/** Test-only dependency consumer. Official packages are unmodified; normal npm install.
 * The browser fixture provides one approved Cordis/React runtime to all official UI packages.
 * No Canvas implementation or private peer module is copied into this harness.
 */
export async function openOfficialNavigationFixture() {
  const directory = await mkdtemp(fileURLToPath(new URL('../../../q127-ui-fixture-', import.meta.url)));
  const dependencies = Object.fromEntries(['dsh-client-store', 'dsh-client-ui-layout',
    'dsh-client-ui-renderer', 'dsh-client-ui-sidebar', 'dsh-client-ui-slots']
    .map(name => [`@deepseek-ai/${name}`, '0.2.1-alpha.2']));
  dependencies['@deepseek-ai/cordis'] = '4.0.5-alpha.1';
  dependencies.react = '18.3.1';
  dependencies['react-dom'] = '18.3.1';
  dependencies.zustand = '4.5.7';
  dependencies.immer = '10.1.1';
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name:'canvas-official-navigation-fixture',
    private:true, type:'module', dependencies }, null, 2));
  try {
    const child = spawn('npm', ['install', '--no-audit', '--no-fund'], {
      cwd:directory, env:process.env, stdio:['ignore','pipe','pipe'] });
    const output = [];
    child.stdout.on('data', data => output.push(data));
    child.stderr.on('data', data => output.push(data));
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    await writeFile(join(directory, 'install.log'), Buffer.concat(output));
    assert.equal(code, 0, `Official UI fixture install failed: ${Buffer.concat(output).toString()}`);
    const fixtureRequire = createRequire(join(directory, 'package.json'));
    const runtime = fixtureRequire('@deepseek-ai/cordis');
    console.log('OFFICIAL_UI_FIXTURE_READY: unmodified 0.2.1-alpha.2; one browser Cordis/React; normal npm install');
    return {
      directory,
      runtime,
      React:fixtureRequire('react'),
      renderToStaticMarkup:fixtureRequire('react-dom/server').renderToStaticMarkup,
      async load(name) {
        let factory;
        const path = fixtureRequire.resolve(`@deepseek-ai/${name}/client`);
        vm.runInNewContext(await readFile(path, 'utf8'), {
          window:{ __ModuleLoader__:{ load(entry) { factory = entry.factory; } } }, AbortController, console,
        }, { filename:path });
        return factory(id => id === '@deepseek-ai/dsh-client-ui-primitives' ?
          { SidebarFishLogo:()=>null, DshIcon:()=>null, ShortcutHint:()=>null, Button:()=>null, Icon:()=>null }
          : fixtureRequire(id));
      },
      async close() { await rm(directory, { recursive:true, force:true }); },
    };
  } catch (error) {
    // Keep failed dependency diagnostics. A setup failure is never accepted as behavior RED.
    error.message += ` (fixture evidence retained at ${directory})`;
    throw error;
  }
}
