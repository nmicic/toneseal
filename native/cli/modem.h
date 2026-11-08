/* Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0 */
#ifndef TONESEAL_MODEM_H
#define TONESEAL_MODEM_H
#include "session.h"
#include "portable_core.h"
#include <signal.h>
#include <stdint.h>
#include <stddef.h>

typedef struct { int16_t *samples; size_t frames; unsigned rate; uint64_t hash; } ts_pcm;
#define TS_TIMELINE_MAX 200000u
typedef struct {
    uint64_t index,next;
    unsigned step,den;
    int16_t previous,buffer[1024]; size_t count;
    int started;
} ts_resampler;
size_t ts_modem_frame(const uint8_t *, size_t, uint16_t, uint8_t[196]);
int ts_modem_timeline(const uint8_t *, size_t, uint16_t, char **, size_t *);
int ts_modem_render(const ts_packet *, ts_pcm *, volatile sig_atomic_t *, char *, size_t);
int ts_modem_record(const ts_packet *, char **, size_t *, volatile sig_atomic_t *, char *, size_t);
int ts_timeline_read(const char *, ts_pcm *, volatile sig_atomic_t *, char *, size_t);
void ts_pcm_free(ts_pcm *);
int ts_pcm_profile(const ts_pcm *, unsigned, int, ts_pcm *);
int ts_wav_read(const char *, ts_pcm *, char *, size_t);
int ts_wav_write(const char *, const ts_pcm *, char *, size_t);
int ts_resampler_init(ts_resampler *, unsigned, int);
int ts_resampler_feed(ts_resampler *, ac_receiver *, const int16_t *, size_t);
int ts_resampler_finish(ts_resampler *, ac_receiver *);
#endif
