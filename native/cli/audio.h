/* Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0 */
#ifndef TONESEAL_AUDIO_H
#define TONESEAL_AUDIO_H
#include "modem.h"
#include <stdio.h>
typedef struct ts_audio ts_audio;
typedef struct {
    uint64_t dropped_samples,overflows,underflows,clipped;
    double input_peak;
    unsigned rate;
} ts_audio_stats;
double ts_clock_ms(void);
int ts_audio_devices(FILE *, int json);
ts_audio *ts_audio_open(int, int, int, char *, size_t);
size_t ts_audio_read(ts_audio *, int16_t *, size_t);
void ts_audio_discard(ts_audio *);
int ts_audio_send(ts_audio *, const ts_packet *, volatile sig_atomic_t *, char *, size_t);
int ts_audio_active(ts_audio *);
void ts_audio_metrics(ts_audio *, ts_audio_stats *);
void ts_audio_close(ts_audio *);
#endif
