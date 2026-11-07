/* Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0 */
#ifndef TONESEAL_TRANSFER_H
#define TONESEAL_TRANSFER_H
#include "session.h"

enum { TS_MODE_MESSAGE, TS_MODE_PASSWORD, TS_MODE_CLEAR };
enum { TS_IDLE, TS_DISCOVERING, TS_VERIFY, TS_CONFIRMING, TS_REFRESHING,
       TS_RECEIVING, TS_SENDING, TS_CONNECTED, TS_CLOSING, TS_DELIVERED,
       TS_RECEIVED, TS_CLOSED, TS_STOPPED, TS_FAILED };
typedef struct {
    int sender, mode, chat, profile, telephone, verify, auto_close;
    unsigned idle_ms;
} ts_options;
typedef struct {
    int phase,active,connected,verified,closing,close_confirmed;
    uint32_t turn,last_queued;
    size_t pending;
    unsigned sent,received,retries,rejected,delivered;
    double now,next_due,idle_deadline,run_deadline;
    char fingerprint[40],reason[160];
} ts_status;
typedef struct ts_transfer ts_transfer;
typedef void (*ts_message_callback)(void *, int mode, const uint8_t *, size_t, uint32_t);
typedef void (*ts_delivery_callback)(void *, uint32_t);

/* One owner, monotonic milliseconds. No audio, file, thread or network calls.
 * next() grants one physical transmission; sent() completes it after echo guard.
 * Test drivers supply a virtual clock using exactly this same state machine. */
ts_transfer *ts_transfer_new(const ts_options *, const uint8_t *, size_t, double,
                             ts_message_callback, ts_delivery_callback, void *);
void ts_transfer_free(ts_transfer *);
void ts_transfer_status(const ts_transfer *, ts_status *);
const char *ts_phase_name(int);
void ts_transfer_tick(ts_transfer *, double);
int ts_transfer_next(ts_transfer *, double, ts_packet *);
void ts_transfer_sent(ts_transfer *, double);
void ts_transfer_receive(ts_transfer *, const uint8_t *, size_t, double);
int ts_transfer_confirm(ts_transfer *, double);
int ts_transfer_enqueue(ts_transfer *, const uint8_t *, size_t, double);
void ts_transfer_close(ts_transfer *, double);
void ts_transfer_stop(ts_transfer *);
void ts_transfer_fail(ts_transfer *, const char *);
#endif
