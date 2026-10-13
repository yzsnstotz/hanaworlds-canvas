import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

test('normal package proof isolates lifecycle cache from an unusable inherited npm cache',async () => {
  const directory=await mkdtemp(fileURLToPath(new URL('../../package-cache-regression-',import.meta.url)));
  const blocker=join(directory,'inherited-cache-is-a-file');
  await writeFile(blocker,'This own fixture file makes the inherited cache unusable.\n');
  const child=spawn(process.execPath,['scripts/test-package-boundary.mjs'],{
    cwd:fileURLToPath(new URL('../',import.meta.url)),
    env:{PATH:process.env.PATH,HOME:process.env.HOME,
      CANVAS_BOUNDARY_EVIDENCE:join(directory,'proof'),
      npm_config_cache:join(blocker,'cache'),NPM_CONFIG_CACHE:join(blocker,'cache')},
    stdio:['ignore','pipe','pipe'],
  });
  let output='';child.stdout.on('data',bytes=>{output+=bytes;});child.stderr.on('data',bytes=>{output+=bytes;});
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  await writeFile(join(directory,'proof.log'),output);
  assert.equal(code,0,`Actual package proof failed; retained at ${directory}:\n${output.slice(-4000)}`);
  const result=output.split('\n').filter(line=>line.startsWith('{"result":"PACKAGE_BOUNDARY_PASS"')).map(JSON.parse).at(-1);
  assert.ok(result,'Full normal package gate must reach its success result');
  assert.equal(result.negatives.length,38,'All existing package/policy negatives still execute');
  const context=JSON.parse(await readFile(join(result.directory,'command-context.json'),'utf8'));
  assert.equal(context.cache,join(result.directory,'npm-cache'));
  assert.notEqual(context.cache,join(blocker,'cache'));
  const pack=await readFile(join(result.directory,'npm-pack.log'),'utf8');
  assert.match(pack,/BUILD_ARTIFACTS_PASS/,'Normal prepack must actually compile');
  assert.match(pack,/DOCUMENT_PROTOCOL_AND_SOURCE_CONSISTENT/,'Normal prepack must actually verify provenance');
});
