#!/usr/bin/env python3
# Copyright (c) 2026 Nenad Micic
# SPDX-License-Identifier: Apache-2.0
"""Build the receiver and assemble a standalone site with unchanged synth assets."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def inside(root, relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError(f'Asset escapes the synth web directory: {relative}')
    return path


def renderer_support_assets(assets, entries):
    names = ['policy.mjs', 'worker.mjs', 'runtime.mjs', 'engines.json']
    worker_source = (assets / 'worker.mjs').read_text()
    # Newer workers import the authoring adapter at startup, even when a caller
    # only renders an existing timeline. Older renderers do not require it.
    if './authoring.mjs' in worker_source:
        if not inside(assets, 'authoring.mjs').is_file():
            raise ValueError('Synth worker requires missing authoring.mjs.')
        names.append('authoring.mjs')
    spatial = inside(assets, 'spatial.mjs')
    # Older prepared renderers do not have this optional display module. Newer
    # workers import it even when the caller skips projection for mono audio.
    if './spatial.mjs' in worker_source and not spatial.is_file():
        raise ValueError('Synth worker requires missing spatial.mjs.')
    if spatial.is_file():
        names.append('spatial.mjs')
    # Portable TL validation is shared by the worker, policy and authoring
    # adapter. Keep it in the prepared dependency bundle, including when only
    # a transitive importer needs it; do not maintain another metadata parser.
    if any('./tl-document.mjs' in inside(assets, name).read_text()
           for name in names if name.endswith('.mjs') and inside(assets, name).is_file()):
        if not inside(assets, 'tl-document.mjs').is_file():
            raise ValueError('Synth renderer requires missing tl-document.mjs.')
        names.append('tl-document.mjs')
    manifest_path = inside(assets, 'spatial-view.json')
    helper_path = inside(assets, 'spatial-view.wasm')
    if manifest_path.exists() or helper_path.exists():
        if not spatial.is_file() or not manifest_path.is_file() or not helper_path.is_file():
            raise ValueError('Spatial companion requires its module, manifest and Wasm asset.')
        manifest_bytes = manifest_path.read_bytes()
        if len(manifest_bytes) > 4096:
            raise ValueError('Spatial companion manifest is too large.')
        manifest = json.loads(manifest_bytes)
        if not isinstance(manifest, dict) or manifest.get('format') != 1:
            raise ValueError('Unsupported spatial companion manifest.')
        digest = manifest.get('wasm_sha256')
        helper = helper_path.read_bytes()
        if (not isinstance(digest, str) or len(digest) != 64 or
                any(c not in '0123456789abcdef' for c in digest) or
                len(helper) > 4 * 1024 * 1024 or hashlib.sha256(helper).hexdigest() != digest):
            raise ValueError('Spatial companion checksum or size mismatch.')
        if not any(manifest.get('browser_sha256') == entry.get('browser_sha256') and
                   manifest.get('library_sha256') == entry.get('library_sha256') and
                   entry.get('browser_wasm') and entry.get('library_wasm') for entry in entries):
            raise ValueError('Spatial companion does not match an installed renderer.')
        names.extend(['spatial-view.json', 'spatial-view.wasm'])
    return names


BUILD_INVENTORY = 'toneseal-build.json'


def output_path(output):
    output = output.absolute()
    if output == ROOT or not output.is_relative_to(ROOT):
        raise ValueError('Choose an output subdirectory of the ToneSeal checkout.')
    relative = output.relative_to(ROOT)
    protected = {'web', 'native', 'tests', 'scripts', 'docs', '.github', '.git'}
    repository_path = any(part.casefold() == '.git' for part in relative.parts)
    if '..' in relative.parts or repository_path or relative.parts[0].casefold() in protected:
        raise ValueError('Output may not replace source or repository directories.')
    current = ROOT
    for part in relative.parts:
        current /= part
        if current.is_symlink() or (current.exists() and not current.is_dir()):
            raise ValueError('Output and its parents must be directories without symlinks.')
    if (ROOT / '.git').exists():
        tracked = subprocess.check_output(['git', '--literal-pathspecs', 'ls-files', '-z', '--', str(relative)], cwd=ROOT)
        if tracked:
            raise ValueError('Selected output contains tracked source files.')
    return output


def site_inventory(directory):
    """Include all files and directories. Never traverse a symlink or read a device."""
    inventory = {}
    for entry in directory.rglob('*'):
        relative = entry.relative_to(directory).as_posix()
        mode = entry.lstat().st_mode
        if stat.S_ISREG(mode):
            if relative != BUILD_INVENTORY:
                inventory[relative] = hashlib.sha256(entry.read_bytes()).hexdigest()
        elif stat.S_ISDIR(mode) and relative != BUILD_INVENTORY:
            inventory[relative] = None
        else:
            raise ValueError(f'Unexpected file type in output: {relative}')
    return inventory


def install_site(staged, output):
    output = output_path(output)
    fresh = site_inventory(staged)
    inventory = {'format': 'toneseal-static-site-v1', 'entries': fresh}
    (staged / BUILD_INVENTORY).write_text(json.dumps(inventory, sort_keys=True, indent=2) + '\n')
    if not output.exists():
        staged.rename(output)
        return
    # Read and validate the whole existing tree before replacing it.
    marker = output / BUILD_INVENTORY
    if marker.is_symlink():
        raise ValueError('Refusing a symlinked output inventory.')
    if any(output.iterdir()):
        if marker.is_file():
            expected = json.loads(marker.read_text())
            actual = {'format': inventory['format'], 'entries': site_inventory(output)}
            if expected != actual:
                raise ValueError('Output has changed since it was built. Move it aside or choose a fresh --out.')
        else:
            # Legacy dist has no inventory, so compare each byte to the staged
            # version. A newer build may add files such as a license notice.
            if output != ROOT / 'dist' or not (output / 'index.html').is_file():
                raise ValueError('Output contains existing files. Move it aside or choose a fresh --out.')
            old = site_inventory(output)
            if not old.items() <= fresh.items():
                raise ValueError('Existing dist differs from the build. Move it aside or choose a fresh --out.')
    # Keep the old tree recoverable if installation or restoration fails.
    holding = Path(tempfile.mkdtemp(prefix='.toneseal-site-', dir=output.parent))
    previous = holding / 'previous'
    try:
        output.rename(previous)
        try:
            staged.rename(output)
        except BaseException:
            previous.rename(output)
            raise
        shutil.rmtree(previous)
    finally:
        if not previous.exists():
            holding.rmdir()


def build(assets, output):
    assets, output = assets.resolve(), output_path(output)
    if assets.is_relative_to(output) or output.is_relative_to(assets):
        raise ValueError('Renderer inputs and generated output must use separate directories.')
    registry = json.loads((assets / 'engines.json').read_text())
    entries = registry.get('engines', [])
    selected = [entry for entry in entries if registry.get('default') in (entry.get('id'), entry.get('release_id'))]
    if len(selected) != 1 or selected[0].get('withdrawn') or selected[0].get('withdrawn_at'):
        raise ValueError('A unique, available default renderer is required.')
    for entry in entries:
        for name, digest_name in [('wasm','sha256'), ('browser_wasm','browser_sha256'),
                                  ('runtime_module','runtime_sha256'), ('library_wasm','library_sha256')]:
            if not entry.get(name):
                continue
            file = inside(assets, entry[name])
            digest = hashlib.sha256(file.read_bytes()).hexdigest()
            if digest != entry.get(digest_name):
                raise ValueError(f'Synth asset checksum mismatch: {entry[name]}')
        if entry.get('toolchain_notices') and not inside(assets, entry['toolchain_notices']).is_dir():
            raise ValueError(f'Missing toolchain notices for {entry["id"]}')
    support_assets = renderer_support_assets(assets, entries)
    # Reuse the synth's cursor FFT for the live audio dock. Keep the source in
    # its owning project rather than maintaining another DSP implementation.
    if not inside(assets, 'media.mjs').is_file():
        raise ValueError('Live audio views require the synth media.mjs module.')
    support_assets.append('media.mjs')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.toneseal-site-', dir=output.parent) as temporary:
        staged = Path(temporary) / 'site'
        shutil.copytree(ROOT / 'web', staged, ignore=shutil.ignore_patterns('.DS_Store'))
        subprocess.run([sys.executable, str(ROOT / 'build.py'), '--wasm', '--out', str(staged / 'communication-decoder.wasm')], check=True)
        for name in support_assets:
            shutil.copy2(assets / name, staged / name)
        shutil.copytree(assets / 'vendor' / 'browser_wasi_shim', staged / 'vendor' / 'browser_wasi_shim')
        # Keep the complete referenced archives, including each archived runtime,
        # its vendored dependencies, project licence and compiler notices.
        for entry in entries:
            engine_id = entry['id']
            if not isinstance(engine_id, str) or '/' in engine_id or engine_id in ('.', '..'):
                raise ValueError('Invalid renderer directory.')
            archive = inside(assets, 'engines/' + engine_id)
            destination = staged / 'engines' / engine_id
            if not destination.exists():
                shutil.copytree(archive, destination)
        shutil.copy2(ROOT / 'LICENSE', staged / 'LICENSE')
        for name in ('LICENSE', 'NOTICE'):
            source = assets.parent / name
            if source.is_file():
                shutil.copy2(source, staged / ('SYNTH-' + name))
        install_site(staged, output)
    print(f'Standalone web app: {output}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--synth-root', type=Path, default=Path(os.environ.get('JOTTUNE_SYNTH_ROOT', ROOT.parent / 'jottune-synth')))
    parser.add_argument('--assets', type=Path, help='Prepared synth web bundle; overrides --synth-root/web')
    parser.add_argument('--out', type=Path, default=ROOT / 'dist')
    args = parser.parse_args()
    try:
        build(args.assets or args.synth_root / 'web', args.out)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Build failed: {error}\n')
