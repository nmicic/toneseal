#!/usr/bin/env python3
# Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0
"""Build and check the native client without using physical audio devices."""
import argparse
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sanitize', action='store_true', help='instrument ToneSeal C with ASan/UBSan')
    parser.add_argument('--pcm', action='store_true', help='optional browser/native PCM checks; requires a built dist/')
    args = parser.parse_args()
    environment = dict(os.environ)
    if args.sanitize: environment['TONESEAL_SANITIZE'] = '1'
    environment['TONESEAL_MODEM'] = str(ROOT/'build/modem-driver')

    def run(command, **extra):
        print('+ '+' '.join(map(str, command)), flush=True)
        subprocess.run(command, cwd=ROOT, env=dict(environment, **extra), check=True)

    kinds = ['modem-driver', 'transfer-driver'] if args.pcm else ['cli', 'modem-driver', 'session-boundaries']
    for kind in kinds:
        run(['python3', 'scripts/build-cli.py', *([] if kind == 'cli' else ['--'+kind]), *(['--sanitize'] if args.sanitize else [])])
    if args.pcm:
        run(['node', '--test', 'tests/native-modem.mjs'], TONESEAL_BROWSER_PCM='1')
        for case in ('password-C-sender', 'chat-C-receiver', 'telephone-chat'):
            run(['node', 'tests/native-transfer.mjs'], TONESEAL_TRANSFER_PCM='1', TONESEAL_CASE=case)
        return
    run([str(ROOT/'build/session-boundaries')])
    run(['node', '--test', 'tests/native-session.mjs'])
    run(['node', 'tests/native-transfer.mjs'])
    run(['node', '--test', 'tests/native-modem.mjs'])
    for test in ('native-files.py', 'native-terminal.py', 'native-audio.py'):
        run(['python3', 'tests/'+test])

if __name__ == '__main__': main()
