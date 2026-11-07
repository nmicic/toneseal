/* Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0 */
/* Include the production implementation in this TEST executable to inspect
 * otherwise unreachable counter boundaries. No test hooks enter the client. */
#include "../native/cli/session.c"
#include <assert.h>

static void pair(ts_session *a, ts_session *b) {
    ts_packet p; ts_result r;
    assert(ts_session_offer(a,&p)); assert(ts_session_receive(b,p.bytes,p.len,&r));
    p=r.outbound; assert(ts_session_receive(a,p.bytes,p.len,&r));
    assert(ts_session_confirm(a,&p)); assert(ts_session_receive(b,p.bytes,p.len,&r));
    assert(ts_session_confirm(b,&p)); assert(ts_session_receive(a,p.bytes,p.len,&r));
    assert(ready(a) && ready(b));
}
static void limits(int profile) {
    ts_session *a=ts_session_new(profile,0),*b=ts_session_new(profile,0);
    ts_packet p; ts_result r; uint8_t body[1]={'x'};
    assert(a && b); pair(a,b);
    a->current->tx=TS_SEQUENCE_MAX-1;
    assert(ts_session_send(a,0,body,1,&p)); assert(be32(p.bytes+11)==TS_SEQUENCE_MAX);
    assert(ts_session_receive(b,p.bytes,p.len,&r)); assert(r.type==TS_MESSAGE && r.text_len==1);
    assert(ts_session_receive(a,r.outbound.bytes,r.outbound.len,&r)); assert(!a->outbox_count);
    assert(!ts_session_send(a,0,body,1,&p)); assert(a->current->tx==TS_SEQUENCE_MAX);
    a->current->tx_control=TS_SEQUENCE_MAX-1;
    assert(seal(a,a->current,K_READY,NULL,0,&p)); assert(be32(p.bytes+11)==UINT32_MAX);
    assert(!seal(a,a->current,K_READY,NULL,0,&p)); assert(a->current->tx_control==TS_SEQUENCE_MAX);
    ts_session_reset(a); assert(!a->current && !a->outbox_count && !a->pairing.key);
    ts_session_free(a); ts_session_free(b);
}
static void retained_hole(int profile) {
    ts_session *a=ts_session_new(profile,0),*b=ts_session_new(profile,0);
    ts_packet p,missing; ts_result r; unsigned i; uint8_t body[1]={'x'};
    assert(a && b); pair(a,b); assert(ts_session_send(a,0,body,1,&missing));
    for (i=2;i<=64;++i) {
        assert(ts_session_send(a,0,body,1,&p)); assert(be32(p.bytes+11)==i);
        assert(ts_session_receive(b,p.bytes,p.len,&r)); assert(ts_session_receive(a,r.outbound.bytes,r.outbound.len,&r));
        assert(a->outbox_count==1 && a->outbox[0].counter==1);
    }
    assert(!ts_session_send(a,0,body,1,&p)); assert(a->current->tx==64);
    assert(ts_session_retry_pending(a,&p)); assert(packet_equal(&missing,p.bytes,p.len));
    assert(ts_session_receive(b,p.bytes,p.len,&r)); assert(r.type==TS_MESSAGE);
    assert(ts_session_receive(a,r.outbound.bytes,r.outbound.len,&r)); assert(!a->outbox_count);
    assert(ts_session_send(a,0,body,1,&p)); assert(be32(p.bytes+11)==65);
    /* An authenticated 64-position stale DATA cannot be displayed again. */
    assert(ts_session_receive(b,p.bytes,p.len,&r)); assert(!ts_session_receive(b,missing.bytes,missing.len,&r));
    ts_session_free(a); ts_session_free(b);
}
static void tampering(int profile) {
    ts_session *a=ts_session_new(profile,0),*b=ts_session_new(profile,0);
    ts_packet p,changed; ts_result r; uint8_t body[96]; size_t i,j;
    assert(a && b); pair(a,b); memset(body,'a',sizeof(body)); assert(ts_session_send(a,1,body,sizeof(body),&p));
    assert(p.len==128);
    for (i=0;i<p.len;++i) for (j=0;j<8;++j) {
        changed=p; changed.bytes[i]^=(uint8_t)(1u<<j); memset(&r,0xff,sizeof(r));
        assert(!ts_session_receive(b,changed.bytes,changed.len,&r));
        assert(r.type==TS_NONE && !r.has_outbound && !r.text_len);
        assert(b->current->rx.high==0 && b->current->rx_control.high==1);
    }
    assert(ts_session_receive(b,p.bytes,p.len,&r)); assert(r.type==TS_PASSWORD && r.text_len==96);
    assert(ts_session_receive(b,p.bytes,p.len,&r)); assert(r.type==TS_DUPLICATE && !r.text_len);
    ts_session_free(a); ts_session_free(b);
}
static void invalid_public(void) {
    int profile,i; ts_result r;
    for (profile=TS_P256;profile<=TS_X25519;++profile) for (i=0;i<5;++i) {
        ts_session *s=ts_session_new(profile,0); uint8_t input[84]={0}; size_t n=3+s->share_len;
        input[0]=0xa7; input[1]=(uint8_t)s->version; input[2]=1;
        if (profile==TS_P256) { input[3]=(uint8_t)(i==0?4:i); }
        else if (i==1) input[3]=1;
        else if (i>=2) { memset(input+3,0xff,32); input[34]=i==2?0x7f:0xff; if (i==4) input[3]=0xed; }
        assert(!ts_session_receive(s,input,n,&r)); assert(!s->current && !s->candidate);
        ts_session_free(s);
    }
}
int main(void) {
    int profile;
    for (profile=TS_P256;profile<=TS_X25519;++profile) { limits(profile); retained_hole(profile); tampering(profile); }
    invalid_public(); puts("PASS native counter exhaustion, replay-window edge, retained hole, 2048 authenticated mutations and invalid public keys"); return 0;
}
