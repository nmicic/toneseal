#!/usr/bin/env python3
# Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0
"""Build ToneSeal's native CLI against installed libraries; never vendor them."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]

def flags(*packages):
    try:
        return shlex.split(subprocess.check_output(
            ['pkg-config', '--cflags', '--libs', *packages], text=True))
    except (OSError, subprocess.CalledProcessError) as error:
        raise RuntimeError('Install pkg-config and the requested system development libraries: '
                           + ', '.join(packages)) from error

def build(output, *, kind='cli', synth_root=None, sanitize=False):
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    cc = shlex.split(os.environ.get('CC', 'cc'))
    source = ROOT / 'native/cli'
    command = cc + ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-O2', '-Wall', '-Wextra', '-Werror',
                    '-I', str(source), '-I', str(ROOT / 'native')]
    if sanitize:
        command += ['-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-g']
    libraries = flags('libcrypto')
    sources = ['session.c']
    if kind == 'session-driver':
        sources += ['session_driver.c']
    elif kind == 'session-boundaries':
        sources = []
        command += [str(ROOT / 'tests/native-boundaries.c')]
    elif kind == 'transfer-driver':
        sources += ['transfer.c', 'transfer_driver.c']
    else:
        synth_root = Path(synth_root or os.environ.get('JOTTUNE_SYNTH_ROOT', ROOT.parent / 'jottune-synth')).resolve()
        bridge = synth_root / 'bindings/native'
        if not (bridge / 'jottune_bridge.h').is_file():
            raise RuntimeError('Provide a JotTune Synth checkout with --synth-root or JOTTUNE_SYNTH_ROOT.')
        # The SDK Makefile tracks source changes, but compiler/feature flags
        # also need separate products. Strict glibc C99 needs the default-source
        # feature declarations for the SDK's POSIX host helpers.
        cppflags = os.environ.get('CPPFLAGS', '')
        if sys.platform.startswith('linux'):
            cppflags += ' -D_DEFAULT_SOURCE=1'
        configuration = json.dumps([str(synth_root), cc, cppflags], separators=(',', ':')).encode()
        shared = output.parent / 'synth-native' / hashlib.sha256(configuration).hexdigest()[:12]
        subprocess.run(['make', '-C', str(bridge), 'BUILD_DIR=' + str(shared),
                        'CC=' + shlex.join(cc), 'HOSTCC=' + shlex.join(cc),
                        'CPPFLAGS=' + cppflags], check=True)
        command += ['-I', str(bridge)]
        command += ['-Wl,-dead_strip' if sys.platform == 'darwin' else '-Wl,--gc-sections']
        sources += ['modem.c']
        command += [str(ROOT / 'native/portable_core.c')]
        libraries += [str(shared / 'libjottune_native.a'), '-lm']
        if kind == 'modem-driver':
            sources += ['modem_driver.c']
        else:
            sources += ['audio.c', 'transfer.c', 'main.c']
            libraries += flags('portaudio-2.0')
    with tempfile.TemporaryDirectory(prefix='.toneseal-cli-', dir=output.parent) as temporary:
        staged = Path(temporary) / output.name
        subprocess.run(command + [str(source / name) for name in sources] + libraries + ['-o', str(staged)], check=True)
        os.replace(staged, output)
    return output

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--session-driver', dest='kind', action='store_const', const='session-driver', help='test-only session oracle')
    group.add_argument('--modem-driver', dest='kind', action='store_const', const='modem-driver', help='test-only PCM/framing oracle')
    group.add_argument('--transfer-driver', dest='kind', action='store_const', const='transfer-driver', help='test-only transfer oracle')
    group.add_argument('--session-boundaries', dest='kind', action='store_const', const='session-boundaries', help='test-only counter/replay boundaries')
    parser.set_defaults(kind='cli')
    parser.add_argument('--sanitize', action='store_true')
    parser.add_argument('--synth-root', type=Path)
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    try:
        print(build(args.out or ROOT / ('build/toneseal' if args.kind == 'cli' else 'build/' + args.kind),
                    kind=args.kind, synth_root=args.synth_root, sanitize=args.sanitize))
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'CLI build failed: {error}\n')
