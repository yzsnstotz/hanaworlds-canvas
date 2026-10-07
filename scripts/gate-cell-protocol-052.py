#!/usr/bin/env python3
"""Freeze clean Canvas, test real Cordis source/tar with public Contracts 0.5.2.

All install/build/runtime scratch lives under this card's run and is removed
after logs and durable state evidence have been retained. Existing E is immutable.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time

REPO = Path(__file__).resolve().parents[1]
RUN = Path('/Users/yzliu/.cache/hanaworlds-runs/S1-CANVAS-REGION-UNDO-01')
CONTRACT_E = Path('/Users/yzliu/.cache/hanaworlds-runs/S1-CONTRACT-REGION-V1-01/_evidence')
INPUTS = {
    'contracts-050': (CONTRACT_E / 'final-050/hanaworlds-contracts-0.5.0.tgz',
                      '7fb42f1eaaf4988730f6cf254faecb84bbbb1d84e293558b66727c470181b31e'),
    'consumer-052': (CONTRACT_E / 'final-052/hanaworlds-contracts-0.5.2.tgz',
                     'e6c50766ffc821ca90e07c38f473456952ef650e8a321f676dc44ce7d7d72209'),
    'canvas-051': (RUN / '_evidence/gate-c3069d4/hanaworlds-canvas-0.5.1.tgz',
                   '694ae85a3b0b5c14acd6dcb86cd953c98f1120c28ff970e8d16b686f29144210'),
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    commit, target = sys.argv[1:]
    out = Path(target)
    assert out.is_absolute() and not out.exists(), 'E must be a new absolute directory'
    out.mkdir(parents=True)
    work = Path(tempfile.mkdtemp(prefix='cell-protocol-052-', dir=RUN))
    steps = []
    env = dict(os.environ, DSH_HOME='', TMPDIR=str(work / 'tmp'),
               npm_config_cache=str(work / 'npm-cache'))
    Path(env['TMPDIR']).mkdir()
    node = None

    def execute(label, args, cwd=work, extra=None, expected=0):
        started = time.monotonic()
        print(f'{label}: START', flush=True)
        result = subprocess.run(args, cwd=cwd, env=env | (extra or {}),
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        (out / (label + '.log')).write_bytes(result.stdout)
        step = {'label': label, 'argv': args, 'cwd': str(cwd),
                'exitCode': result.returncode, 'seconds': time.monotonic() - started}
        steps.append(step)
        print(f'{label}: exit {result.returncode}', flush=True)
        assert result.returncode == expected, f'{label}: see {out / (label + ".log")}'
        return result.stdout.decode()

    def compare_contract(tar, installed):
        checked = []
        with tarfile.open(tar) as archive:
            for member in archive.getmembers():
                if not member.isfile() or member.name == 'package/package.json':
                    continue
                relative = member.name.removeprefix('package/')
                assert archive.extractfile(member).read() == (installed / relative).read_bytes(), relative
                checked.append(relative)
        return checked

    try:
        assert not subprocess.check_output(['git', 'status', '--porcelain'], cwd=REPO)
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO).decode().strip()
        assert commit == head
        sources = {}
        for label, (path, expected) in INPUTS.items():
            assert sha(path) == expected, label
            sources[label] = {'path': str(path), 'sha256': expected, 'bytes': path.stat().st_size}
        (out / 'inputs.json').write_text(json.dumps(sources, indent=2) + '\n')
        paths = execute('runtime-resolution', ['npx', '--yes', '--package=node@24.13.1',
            '--package=npm@11.8.0', '-c', 'command -v node; command -v npm']).strip().splitlines()
        paths = [line for line in paths if Path(line).is_absolute() and Path(line).is_file()]
        assert len(paths) == 2, 'runtime resolver must yield exactly Node and npm paths'
        node, npm = paths
        assert Path(node).name == 'node' and Path(npm).name == 'npm'
        env['PATH'] = str(Path(node).parent) + os.pathsep + str(Path(npm).parent) + os.pathsep + env['PATH']
        assert execute('node-version', [node, '--version']).strip() == 'v24.13.1'
        assert execute('npm-version', [node, npm, '--version']).strip() == '11.8.0'
        src = work / 'source'
        src.mkdir()
        archive = subprocess.check_output(['git', 'archive', commit], cwd=REPO)
        (work / 'source.tar').write_bytes(archive)
        with tarfile.open(work / 'source.tar') as frozen:
            frozen.extractall(src, filter='data')
        execute('source-npm-ci', [node, npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], src)
        execute('source-build', [node, npm, 'run', 'build'], src)
        comparison = {'source050': compare_contract(INPUTS['contracts-050'][0],
                      src / 'node_modules/hanaworlds-contracts')}
        consumer = work / 'consumer'
        consumer.mkdir()
        execute('consumer-install', [node, npm, 'install', '--prefix', str(consumer),
            '--ignore-scripts', '--no-audit', '--no-fund', str(INPUTS['consumer-052'][0])])
        consumer_entry = (consumer / 'node_modules/hanaworlds-contracts/dist/local/index.mjs').as_uri()
        comparison['consumer052'] = compare_contract(INPUTS['consumer-052'][0],
                                   consumer / 'node_modules/hanaworlds-contracts')
        for label, folder in [('source050', src), ('consumer052', consumer)]:
            public = folder / 'node_modules/hanaworlds-contracts'
            for file in ['README.md', 'types/local/contracts.d.ts', 'types/local/index.d.ts']:
                (out / (label + '-' + file.replace('/', '-'))).write_bytes((public / file).read_bytes())
        (out / 'contract-byte-comparison.json').write_text(json.dumps(comparison, indent=2) + '\n')
        for phase in ['source', 'packed']:
            (out / (phase + '-runtime')).mkdir()
        common = {'CANVAS_CONSUMER_ENTRY': consumer_entry}
        tests = ['test/protocol-handshake.test.mjs', 'test/local-world.test.mjs']
        execute('source-test', [node, '--test', *tests], src, common |
            {'CANVAS_RUNTIME_EVIDENCE': str(out / 'source-runtime')})
        execute('source-types', [node, str(src / 'node_modules/typescript/bin/tsc'),
            '--noEmit', '--strict', '--module', 'NodeNext',
            '--moduleResolution', 'NodeNext', '--target', 'ES2022', 'test/protocol-types.mts'], src)
        pack = json.loads(execute('npm-pack', [node, npm, 'pack', '--json',
            '--pack-destination', str(out)], src))[0]
        tar = out / pack['filename']
        (out / 'pack.json').write_text(json.dumps(pack, indent=2) + '\n')
        packed = work / 'packed'
        packed.mkdir()
        execute('packed-install', [node, npm, 'install', '--prefix', str(packed),
            '--ignore-scripts', '--no-audit', '--no-fund', str(tar),
            str(INPUTS['consumer-052'][0]), 'cordis@4.0.0-rc.10', 'typescript@5.8.3'])
        packed_canvas = packed / 'node_modules/hanaworlds-canvas'
        compared = []
        for file in pack['files']:
            relative = file['path']
            assert (src / relative).read_bytes() == (packed_canvas / relative).read_bytes(), relative
            compared.append(relative)
        (out / 'packed-byte-comparison.json').write_text(json.dumps(compared, indent=2) + '\n')
        shutil.copytree(src / 'test', packed / 'test')
        execute('packed-test', [node, '--test', *tests], packed, common | {
            'CANVAS_ENTRY': (packed_canvas / 'src/index.mjs').as_uri(),
            'CANVAS_RUNTIME_EVIDENCE': str(out / 'packed-runtime')})
        execute('packed-types', [node, str(packed / 'node_modules/typescript/bin/tsc'),
            '--noEmit', '--strict', '--module', 'NodeNext',
            '--moduleResolution', 'NodeNext', '--target', 'ES2022', 'test/protocol-types.mts'], packed)
        old = work / 'old'
        old.mkdir()
        execute('old-install', [node, npm, 'install', '--prefix', str(old),
            '--ignore-scripts', '--no-audit', '--no-fund', str(INPUTS['canvas-051'][0]),
            str(INPUTS['consumer-052'][0]), 'cordis@4.0.0-rc.10'])
        shutil.copytree(src / 'test', old / 'test')
        old_log = execute('old-051-red', [node, '--test', 'test/protocol-handshake.test.mjs'], old,
            common | {'CANVAS_ENTRY': (old / 'node_modules/hanaworlds-canvas/src/index.mjs').as_uri()},
            expected=1)
        assert 'MISSING_PUBLIC_CANVAS_V5_PROTOCOL_HANDSHAKE' in old_log
        # Only preserve reproducible input descriptions, not dependencies or npm caches.
        for label, folder in [('consumer', consumer), ('packed', packed), ('old', old)]:
            for name in ['package.json', 'package-lock.json']:
                shutil.copyfile(folder / name, out / (label + '-' + name))
        receipt = {'artifactSource': commit, 'sourceDirty': False, 'version': '0.5.2',
                   'tar': str(tar), 'sha256': sha(tar), 'bytes': tar.stat().st_size,
                   'node': '24.13.1', 'npm': '11.8.0', 'cordis': '4.0.0-rc.10',
                   'consumer': '0.5.2', 'runtime': 'REAL_CORDIS_CANVAS_AND_FS_STORE',
                   'external': 'HOST_PATH_ADAPTER_AND_WORLD_FIXTURE',
                   'notRun': ['real peers', 'Luanti', 'Desktop UI', 'model', 'clean-machine', 'product gate'],
                   'sourceTests': 5, 'packedTests': 5, 'oldExit': 1}
        (out / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
        print(json.dumps(receipt), flush=True)
    finally:
        (out / 'steps.json').write_text(json.dumps(steps, indent=2) + '\n')
        shutil.rmtree(work)
        assert not work.exists()
        (out / 'cleanup.json').write_text(json.dumps({'removedOwnScratch': str(work),
            'absent': True, 'preserved': 'source, fixed inputs, all previous E/world/rollback'}) + '\n')
        files = [{'path': str(p.relative_to(out)), 'bytes': p.stat().st_size, 'sha256': sha(p)}
                 for p in sorted(out.rglob('*')) if p.is_file() and p.name != 'INDEX.json']
        (out / 'INDEX.json').write_text(json.dumps({'files': files}, indent=2) + '\n')


if __name__ == '__main__':
    main()
