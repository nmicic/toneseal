#!/usr/bin/env python3
# Copyright (c) 2026 Nenad Micic
# SPDX-License-Identifier: Apache-2.0
"""Build the standalone experimental receiver; never rebuild the synth."""
import argparse
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
NATIVE = HERE / 'native'
EXPORTS = ('reset input feed finish count payload length sender onset corrected numeric_errors crc_failures invalid_headers invalid_payloads state_bytes').split()

def build(output, wasm=False, cc=None):
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.acoustic-build-', dir=output.parent) as directory:
        temporary = Path(directory) / output.name
        if wasm:
            command = shlex.split(cc or os.environ.get('ZIG', 'zig')) + ['cc', '-target', 'wasm32-freestanding',
                '-std=c99', '-O2', '-g0', '-ffreestanding', '-fno-builtin', '-nostdlib', '-I', str(NATIVE / 'freestanding'),
                '-Wl,--no-entry', '-Wl,--export-memory', '-Wl,-z,stack-size=65536',
                '-Wl,--initial-memory=262144', '-Wl,--max-memory=262144', '-Wl,--strip-all']
            command += ['-Wl,--export=acoustic_' + name for name in EXPORTS]
            sources = ['portable_core.c', 'wasm_adapter.c', 'wasm_runtime.c']
        else:
            command = shlex.split(cc or os.environ.get('CC', 'cc')) + ['-std=c99', '-O2', '-Wall', '-Wextra', '-Werror']
            sources = ['portable_core.c', 'portable_cli.c']
        subprocess.run(command + [str(NATIVE / name) for name in sources] + ['-o', str(temporary)], check=True)
        os.replace(temporary, output)
    return output

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wasm', action='store_true')
    parser.add_argument('--out', type=Path)
    parser.add_argument('--cc', help='native compiler command; for --wasm, the Zig executable')
    args = parser.parse_args()
    print(build(args.out or HERE / ('web/communication-decoder.wasm' if args.wasm else 'build/receiver'), args.wasm, args.cc))
