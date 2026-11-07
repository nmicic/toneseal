/* Copyright (c) 2026 Nenad Micic */
/* SPDX-License-Identifier: Apache-2.0 */
#ifndef ACOUSTIC_PORTABLE_CORE_H
#define ACOUSTIC_PORTABLE_CORE_H
#include <stddef.h>
#include <stdint.h>

#define AC_WINDOW 960
#define AC_RING 4096
#define AC_PAYLOAD 128
#define AC_GLYPHS 196
#define AC_CANDIDATES 8
#define AC_OFFSETS 5
#define AC_LIMIT UINT64_C(9223372036854775807)

typedef struct { int32_t re, im; } ac_complex;
typedef struct {
    ac_complex fft[AC_WINDOW];
    uint64_t power[64];
    uint32_t normalized[64];
    int bad;
} ac_workspace;

typedef struct {
    uint64_t onset;
    uint16_t count, target, ties;
    uint32_t minimum_margin;
    uint8_t values[AC_GLYPHS];
    uint8_t active;
} ac_hypothesis;

typedef struct {
    uint64_t onset;
    uint32_t score;
    ac_hypothesis hypotheses[AC_OFFSETS];
    uint8_t count;
} ac_candidate;

typedef struct {
    uint64_t local_candidates, admitted_candidates, dropped_new_candidates;
    uint64_t evicted_candidates, suppressed_candidates, invalid_headers;
    uint64_t oversize_headers, invalid_payloads, crc_failures, ring_overruns, packets;
    uint64_t eof_packets, pending_at_eof, groups_at_eof, demodulated_windows;
    uint64_t max_candidate_groups, max_hypotheses, max_demod_batch;
    uint64_t max_oldest_window_age, max_retained_glyphs, operation_errors;
    uint64_t reentrant_calls, numeric_refusals;
} ac_counters;

typedef struct {
    uint8_t payload[AC_PAYLOAD];
    uint16_t payload_bytes, sender, physical_glyphs, ties, corrected_nibbles;
    uint8_t ignored_padding;
    uint64_t onset, data_end, logical_sample, delivered_sample;
    uint32_t riff_score, minimum_margin;
    uint8_t at_eof;
} ac_event;

/* Event storage is valid only during the callback. Nonzero return closes
 * the receiver. Reentrant feed/finish refuse without invoking callbacks. */
typedef int (*ac_callback)(void *, const ac_event *);

typedef struct {
    int16_t ring[AC_RING], quantum[48], acquisition[2448], window[AC_WINDOW];
    uint32_t projections[141][8];
    uint32_t local_scores[13];
    int64_t local_indices[13];
    ac_candidate groups[AC_CANDIDATES];
    ac_workspace workspace;
    ac_counters counters;
    uint64_t samples, input_samples, delivery_sample, accepted_through;
    uint64_t windows, scores;
    uint32_t maximum_riff_score;
    uint16_t quantum_count, acquisition_count;
    uint8_t local_count, group_count, closed, busy, finishing;
    ac_callback callback;
    void *callback_context;
} ac_receiver;

/* Return0 on success,1 on a closed/busy/bounded-input refusal,2 on an
 * internal numerical/support failure,3 on callback refusal. */
void ac_init(ac_receiver *, ac_callback, void *);
int ac_feed(ac_receiver *, const int16_t *, size_t);
int ac_finish(ac_receiver *);

/* Fixed-window and framing controls used by the host driver. */
int ac_features(ac_workspace *, const int16_t[AC_WINDOW]);
uint8_t ac_symbol(const uint32_t[64], uint8_t *, uint32_t *);
int ac_rs_decode(const uint8_t[15], uint8_t[11], uint16_t *);
int ac_header(const uint8_t[24], uint16_t *, uint16_t *, uint16_t *);
int ac_frame(const uint8_t *, uint16_t, ac_event *);
/* Host controls exercise capacity without changing the core policy.
 * Test-only precondition: onset <= AC_LIMIT, as in normal acquisition. */
void ac_admit(ac_receiver *, uint64_t, uint32_t);
#endif
