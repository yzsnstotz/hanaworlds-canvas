import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'acorn';

// SOURCE_CONFIG_GUARD. No Chrome is launched by these tests; this is neither a
// functional/UI RED nor proof that a system dialog has disappeared.
// Walk executable AST arguments so comments/unused constants cannot pass it.
function launches(source) {
  const found = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'launchOwned') {
      const options = node.arguments[0];
      if (options?.type === 'ObjectExpression') {
        const args = options.properties.find(row => row.key?.name === 'args')?.value;
        if (args?.type === 'ArrayExpression') found.push(args.elements.filter(row => row?.type === 'Literal').map(row => row.value));
      }
    }
    for (const child of Object.values(node)) if (Array.isArray(child)) child.forEach(visit); else visit(child);
  }
  visit(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }));
  return found.filter(args => args.includes('--headless=new'));
}
for (const file of ['support/canvas-module-browser.mjs', '../tools/client-verification/chromium.mjs'])
test(`SOURCE_CONFIG_GUARD: ${file} suppresses keychain access in the actual Chrome argv`, async () => {
  const args = launches(await readFile(new URL(file, import.meta.url), 'utf8'));
  assert.equal(args.length, 1, 'Exactly one actual headless Chrome launch site is covered');
  for (const flag of ['--use-mock-keychain', '--password-store=basic'])
    assert.ok(args[0].includes(flag), `Actual Chrome launch must include ${flag}; no system authorization prompt is allowed`);
  assert.ok(args[0].includes('--incognito') && args[0].includes('--no-first-run'), 'Existing browser isolation stays enabled');
});
