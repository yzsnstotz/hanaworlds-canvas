import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/** Execute the unmodified official browser export through its public module loader.
 * React primitives are a presentation FIXTURE; registry, layout, sidebar and store are real.
 */
export async function officialUi(name) {
  let factory;
  const path = import.meta.resolve(`@deepseek-ai/${name}/client`);
  vm.runInNewContext(await readFile(new URL(path), 'utf8'), {
    window: { __ModuleLoader__: { load(entry) { factory = entry.factory; } } },
    AbortController, console,
  }, { filename: path });
  return factory(id => id === '@deepseek-ai/dsh-client-ui-primitives' ?
    { SidebarFishLogo: () => null, DshIcon: () => null, ShortcutHint: () => null,
      Button: () => null, Icon: () => null } : require(id));
}
