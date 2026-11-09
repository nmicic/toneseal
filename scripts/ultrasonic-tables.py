#!/usr/bin/env python3
# Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0
"""Generate shared Q30 mixer/low-pass constants for the experimental profile."""
import argparse
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
Q30 = 1 << 30

def coefficients(rate):
    taps = 97
    values = []
    for i in range(taps):
        x = i-(taps-1)/2
        sinc = 2*3000/rate if x == 0 else math.sin(2*math.pi*3000*x/rate)/(math.pi*x)
        window = .42-.5*math.cos(2*math.pi*i/(taps-1))+.08*math.cos(4*math.pi*i/(taps-1))
        values.append(sinc*window)
    total = sum(values)
    out = [round(v/total*Q30) for v in values]
    out[taps//2] += Q30-sum(out)
    assert out == out[::-1] and sum(out) == Q30
    assert 32768*sum(map(abs, out)) < 2**53
    return out

def rows(values):
    return ',\n'.join('  '+','.join(map(str, values[i:i+8])) for i in range(0, len(values), 8))

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    c = '/* Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0 */\n'
    c += '/* Q30 constants; regenerate with scripts/ultrasonic-tables.py. */\n#ifndef TONESEAL_ULTRASONIC_TABLES_H\n#define TONESEAL_ULTRASONIC_TABLES_H\n'
    js = '// Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0\n'
    js += '// Q30 constants; regenerate with scripts/ultrasonic-tables.py.\nexport const ultrasonicTables = Object.freeze({\n'
    for rate, period in ((44100, 441), (48000, 480)):
        mixer = [round(math.cos(2*math.pi*((181*i) % period)/period)*Q30) for i in range(period)]
        fir = coefficients(rate)
        for name, values in (('mix', mixer), ('filter', fir)):
            c += f'static const int32_t ts_ultrasonic_{name}_{rate}[{len(values)}] = {{\n{rows(values)}\n}};\n'
        js += f'  {rate}: Object.freeze({{mix: Object.freeze([\n{rows(mixer)}\n]), filter: Object.freeze([\n{rows(fir)}\n])}}),\n'
    c += '#endif\n'; js += '});\n'
    for name, text in (('native/ultrasonic_tables.h', c), ('web/ultrasonic-tables.mjs', js)):
        target = ROOT/name
        if args.check:
            if not target.exists() or target.read_text() != text: raise SystemExit('Regenerate '+name)
        else: target.write_text(text)

if __name__ == '__main__': main()
