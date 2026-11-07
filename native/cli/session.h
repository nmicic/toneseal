/* Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0 */
#ifndef TONESEAL_SESSION_H
#define TONESEAL_SESSION_H
#include <stddef.h>
#include <stdint.h>

#define TS_PACKET_MAX 128
#define TS_TEXT_MAX 96
#define TS_PENDING_MAX 8
#define TS_SEQUENCE_MAX UINT32_C(0x7fffffff)
enum { TS_P256, TS_X25519 };
enum { TS_NO_ROLE, TS_INITIATOR, TS_RESPONDER };
enum { TS_OPEN, TS_DRAIN, TS_COMMIT, TS_ACK_CLOSE, TS_FINAL };
enum { TS_NONE, TS_OFFER, TS_ANSWER, TS_READY, TS_REKEY, TS_ACK,
       TS_MESSAGE, TS_PASSWORD, TS_DUPLICATE, TS_TURN };
typedef struct { uint8_t bytes[TS_PACKET_MAX]; size_t len; } ts_packet;
typedef struct {
    int type, has_outbound, duplicate;
    ts_packet outbound;
    uint8_t text[TS_TEXT_MAX]; size_t text_len;
    uint32_t counter, number, acknowledged[TS_PENDING_MAX];
    size_t acknowledged_count, pending_count;
    int reply, pending, close;
} ts_result;
typedef struct {
    int role, ready, rekeying, local_confirmed, peer_confirmed, version;
    size_t pending_count;
    char fingerprint[40];
    uint8_t session_id[8];
} ts_info;
typedef struct ts_session ts_session;

ts_session *ts_session_new(int profile, int chat);
void ts_session_reset(ts_session *);
void ts_session_free(ts_session *);
const char *ts_session_error(const ts_session *);
void ts_session_info(const ts_session *, ts_info *);
int ts_session_offer(ts_session *, ts_packet *);
int ts_session_confirm(ts_session *, ts_packet *);
int ts_session_send(ts_session *, int password, const uint8_t *, size_t, ts_packet *);
int ts_session_receive(ts_session *, const uint8_t *, size_t, ts_result *);
int ts_session_rekey(ts_session *, ts_packet *);
int ts_session_retry(ts_session *, ts_packet *);
int ts_session_retry_pending(ts_session *, ts_packet *);
size_t ts_session_pending(const ts_session *, uint32_t *);
int ts_session_turn(ts_session *, int reply, uint32_t number, int pending, int close, ts_packet *);
int ts_session_lock_epoch(ts_session *);
int ts_session_lock_data(ts_session *);
int ts_utf8_valid(const uint8_t *, size_t);
int ts_sha256(const void *, size_t, uint8_t[32]);
int ts_clear_data(const uint8_t *, size_t, ts_packet *);
int ts_clear_parse(const uint8_t *, size_t, int *, uint8_t *, size_t *);
int ts_clear_control(const ts_packet *, int kind, ts_packet *);
int ts_clear_same(const ts_packet *, const ts_packet *);
#endif
