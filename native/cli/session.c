/* Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0 */
/* Browser-compatible v2/v3/v6/v7 records. All cryptography is OpenSSL EVP. */
#include "session.h"
#include <openssl/core_names.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/kdf.h>
#include <openssl/params.h>
#include <openssl/rand.h>
#if !defined(OPENSSL_VERSION_MAJOR) || OPENSSL_VERSION_MAJOR < 3 || defined(LIBRESSL_VERSION_NUMBER)
#error "ToneSeal requires OpenSSL 3.x development libraries."
#endif
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define CONTROL UINT32_C(0x80000000)
enum { K_READY, K_MESSAGE, K_PASSWORD, K_REKEY_OFFER, K_REKEY_ANSWER,
       K_REKEY_REQUEST, K_ACK, K_TURN };
enum { RK_NONE, RK_REQUEST, RK_OFFER, RK_ANSWER, RK_COMMIT };
typedef struct { EVP_PKEY *key; uint8_t bytes[81]; } share;
typedef struct { uint32_t high; uint64_t bits; } window;
typedef struct {
    uint8_t id[8], tx_key[32], rx_key[32], tx_prefix[8], rx_prefix[8];
    uint32_t tx, tx_control;
    window rx, rx_control;
    int local, peer;
    char fingerprint[40];
} epoch;
typedef struct { ts_packet in, out; } response;
typedef struct { ts_packet in; ts_result event; } cached_turn;
typedef struct { uint32_t counter; ts_packet packet; } pending;
struct ts_session {
    int profile, chat, version, role, rekey, epoch_locked, data_locked;
    size_t public_len, share_len;
    share pairing, refresh;
    epoch *current, *candidate;
    ts_packet offer, rekey_packet, last;
    response responses[12]; size_t response_count;
    cached_turn turns[4]; size_t turn_count;
    pending outbox[TS_PENDING_MAX]; size_t outbox_count;
    char error[128];
};
static uint32_t be32(const uint8_t *p) {
    return (uint32_t)p[0]<<24 | (uint32_t)p[1]<<16 | (uint32_t)p[2]<<8 | p[3];
}
static void put32(uint8_t *p, uint32_t n) {
    p[0]=(uint8_t)(n>>24); p[1]=(uint8_t)(n>>16); p[2]=(uint8_t)(n>>8); p[3]=(uint8_t)n;
}
static int equal(const void *a, const void *b, size_t n) { return CRYPTO_memcmp(a,b,n)==0; }
static int fail(ts_session *s, const char *why) { snprintf(s->error,sizeof(s->error),"%s",why); return 0; }
static void free_share(share *p) { EVP_PKEY_free(p->key); OPENSSL_cleanse(p,sizeof(*p)); }
static void free_epoch(epoch *e) { if (e) OPENSSL_clear_free(e,sizeof(*e)); }
static int ready(const ts_session *s) { return s->current && s->current->local && s->current->peer && !s->rekey; }
static void remember(ts_session *s, const ts_packet *p) { s->last=*p; }
static int packet_equal(const ts_packet *p, const uint8_t *bytes, size_t len) {
    return p->len==len && equal(p->bytes,bytes,len);
}
int ts_utf8_valid(const uint8_t *p, size_t n) {
    size_t i=0;
    while (i<n) {
        uint8_t a=p[i++], b; unsigned rest;
        if (a<0x80) continue;
        if (a>=0xc2 && a<=0xdf) rest=1;
        else if (a>=0xe0 && a<=0xef) rest=2;
        else if (a>=0xf0 && a<=0xf4) rest=3;
        else return 0;
        if (n-i<rest) return 0;
        b=p[i];
        if ((a==0xe0 && b<0xa0) || (a==0xed && b>=0xa0) ||
            (a==0xf0 && b<0x90) || (a==0xf4 && b>=0x90)) return 0;
        while (rest--) if ((p[i++]&0xc0)!=0x80) return 0;
    }
    return 1;
}
int ts_sha256(const void *p, size_t n, uint8_t out[32]) {
    unsigned length=0;
    return EVP_Digest(p,n,out,&length,EVP_sha256(),NULL)==1 && length==32;
}
ts_session *ts_session_new(int profile, int chat) {
    ts_session *s;
    if ((profile!=TS_P256 && profile!=TS_X25519) || (chat!=0 && chat!=1)) return NULL;
    s=calloc(1,sizeof(*s)); if (!s) return NULL;
    s->profile=profile; s->chat=chat; s->version=(profile==TS_P256?2:3)+(chat?4:0);
    s->public_len=profile==TS_P256?65:32; s->share_len=s->public_len+16;
    return s;
}
void ts_session_reset(ts_session *s) {
    int profile=s->profile,chat=s->chat,version=s->version;
    size_t public_len=s->public_len,share_len=s->share_len;
    free_share(&s->pairing); free_share(&s->refresh); free_epoch(s->current); free_epoch(s->candidate);
    OPENSSL_cleanse(s,sizeof(*s));
    s->profile=profile; s->chat=chat; s->version=version; s->public_len=public_len; s->share_len=share_len;
}
void ts_session_free(ts_session *s) { if (s) { ts_session_reset(s); OPENSSL_clear_free(s,sizeof(*s)); } }
const char *ts_session_error(const ts_session *s) { return s->error; }
void ts_session_info(const ts_session *s, ts_info *info) {
    memset(info,0,sizeof(*info)); info->role=s->role; info->version=s->version;
    info->ready=ready(s); info->rekeying=s->rekey!=RK_NONE; info->pending_count=s->outbox_count;
    if (s->current) {
        info->local_confirmed=s->current->local; info->peer_confirmed=s->current->peer;
        memcpy(info->fingerprint,s->current->fingerprint,40); memcpy(info->session_id,s->current->id,8);
    }
}
static int valid_public(ts_session *s, const uint8_t *p) {
    int i;
    if (s->profile==TS_P256) return p[0]==4 || fail(s,"Invalid P-256 public encoding.");
    for (i=31;i>=0;--i) {
        unsigned bound=i==31?0x7f:i==0?0xed:0xff;
        if (p[i]<bound) return 1;
        if (p[i]>bound) break;
    }
    return fail(s,"Noncanonical X25519 public encoding.");
}
static int make_share(ts_session *s, share *out) {
    EVP_PKEY_CTX *ctx=NULL; size_t n=s->public_len; int ok=0;
    memset(out,0,sizeof(*out));
    ctx=EVP_PKEY_CTX_new_from_name(NULL,s->profile==TS_P256?"EC":"X25519",NULL);
    if (!ctx || EVP_PKEY_keygen_init(ctx)<=0) goto done;
    if (s->profile==TS_P256 && EVP_PKEY_CTX_set_group_name(ctx,"prime256v1")<=0) goto done;
    if (EVP_PKEY_generate(ctx,&out->key)<=0) goto done;
    if (s->profile==TS_P256) {
        if (EVP_PKEY_get_octet_string_param(out->key,OSSL_PKEY_PARAM_PUB_KEY,out->bytes,n,&n)<=0) goto done;
    } else if (EVP_PKEY_get_raw_public_key(out->key,out->bytes,&n)<=0) goto done;
    if (n!=s->public_len || !valid_public(s,out->bytes) || RAND_bytes(out->bytes+n,16)!=1) goto done;
    ok=1;
done:
    EVP_PKEY_CTX_free(ctx);
    if (!ok) { free_share(out); fail(s,"Native key generation failed."); }
    return ok;
}
static epoch *derive(ts_session *s, const share *local, const uint8_t *peer,
                     const uint8_t *offer, size_t offer_len, const uint8_t *answer,
                     size_t answer_len, const uint8_t *previous) {
    EVP_PKEY *key=NULL; EVP_PKEY_CTX *ctx=NULL,*derive_ctx=NULL;
    EVP_KDF *kdf=NULL; EVP_KDF_CTX *kctx=NULL; epoch *out=NULL;
    uint8_t secret[32]={0},material[80]={0},transcript[256],digest[32],finger[32],fp_input[320];
    char domain[64],info[64],group[]="prime256v1",hash[]="SHA256";
    size_t n=32,t=0,prefix; int ok=0,nonzero=0; unsigned i; OSSL_PARAM params[5];
    if (!valid_public(s,peer) || equal(local->bytes,peer,s->public_len)) { fail(s,"Invalid or reflected public key."); goto done; }
    if (s->profile==TS_X25519) key=EVP_PKEY_new_raw_public_key_ex(NULL,"X25519",NULL,peer,32);
    else {
        ctx=EVP_PKEY_CTX_new_from_name(NULL,"EC",NULL);
        params[0]=OSSL_PARAM_construct_utf8_string(OSSL_PKEY_PARAM_GROUP_NAME,group,0);
        params[1]=OSSL_PARAM_construct_octet_string(OSSL_PKEY_PARAM_PUB_KEY,(void *)peer,s->public_len);
        params[2]=OSSL_PARAM_construct_end();
        if (!ctx || EVP_PKEY_fromdata_init(ctx)<=0 || EVP_PKEY_fromdata(ctx,&key,EVP_PKEY_PUBLIC_KEY,params)<=0) goto done;
    }
    if (!key) goto done;
    derive_ctx=EVP_PKEY_CTX_new_from_pkey(NULL,local->key,NULL);
    if (!derive_ctx || EVP_PKEY_derive_init(derive_ctx)<=0 || EVP_PKEY_derive_set_peer_ex(derive_ctx,key,1)<=0 ||
        EVP_PKEY_derive(derive_ctx,secret,&n)<=0 || n!=32) goto done;
    for (i=0;i<32;++i) nonzero|=secret[i];
    if (!nonzero) goto done;
    prefix=(size_t)snprintf(domain,sizeof(domain),"audio-text-lab/session/v%d",s->version)+1;
    if (prefix+8+offer_len+answer_len>sizeof(transcript)) goto done;
    memcpy(transcript,domain,prefix); t=prefix;
    if (previous) { memcpy(transcript+t,previous,8); t+=8; }
    memcpy(transcript+t,offer,offer_len); t+=offer_len; memcpy(transcript+t,answer,answer_len); t+=answer_len;
    if (!ts_sha256(transcript,t,digest)) goto done;
    n=(size_t)snprintf(info,sizeof(info),"audio-text-lab/directional-traffic/v%d",s->version);
    params[0]=OSSL_PARAM_construct_utf8_string(OSSL_KDF_PARAM_DIGEST,hash,0);
    params[1]=OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_KEY,secret,32);
    params[2]=OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_SALT,digest,32);
    params[3]=OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_INFO,info,n);
    params[4]=OSSL_PARAM_construct_end();
    kdf=EVP_KDF_fetch(NULL,"HKDF",NULL); kctx=kdf?EVP_KDF_CTX_new(kdf):NULL;
    if (!kctx || EVP_KDF_derive(kctx,material,80,params)<=0) goto done;
    n=(size_t)snprintf(domain,sizeof(domain),"audio-text-lab/fingerprint/v%d",s->version)+1;
    memcpy(fp_input,domain,n); memcpy(fp_input+n,transcript,t);
    if (!ts_sha256(fp_input,n+t,finger)) goto done;
    out=calloc(1,sizeof(*out)); if (!out) goto done;
    memcpy(out->id,digest,8);
    memcpy(out->tx_key,material+(s->role==TS_INITIATOR?0:40),32);
    memcpy(out->rx_key,material+(s->role==TS_INITIATOR?40:0),32);
    memcpy(out->tx_prefix,material+(s->role==TS_INITIATOR?32:72),8);
    memcpy(out->rx_prefix,material+(s->role==TS_INITIATOR?72:32),8);
    for (i=0;i<8;++i) snprintf(out->fingerprint+i*5,sizeof(out->fingerprint)-i*5,"%02X%02X%s",finger[i*2],finger[i*2+1],i==7?"":" ");
    ok=1;
done:
    OPENSSL_cleanse(secret,sizeof(secret)); OPENSSL_cleanse(material,sizeof(material));
    EVP_PKEY_CTX_free(derive_ctx); EVP_PKEY_CTX_free(ctx); EVP_PKEY_free(key); EVP_KDF_CTX_free(kctx); EVP_KDF_free(kdf);
    if (!ok) { free_epoch(out); out=NULL; fail(s,"Native key agreement failed."); }
    return out;
}
static int seal(ts_session *s, epoch *e, int kind, const uint8_t *body, size_t len, ts_packet *out) {
    EVP_CIPHER_CTX *ctx=NULL; uint8_t plain[97],nonce[12]; uint32_t *tip,wire; int n=0,last=0,ok=0;
    if (len>96) return fail(s,"Payload exceeds 96 bytes.");
    tip=(kind==K_MESSAGE || kind==K_PASSWORD)?&e->tx:&e->tx_control;
    if (*tip>=TS_SEQUENCE_MAX) return fail(s,"Sequence exhausted; start a new session.");
    wire=++*tip | ((kind==K_MESSAGE || kind==K_PASSWORD)?0:CONTROL);
    out->bytes[0]=0xa7; out->bytes[1]=(uint8_t)s->version; out->bytes[2]=3;
    memcpy(out->bytes+3,e->id,8); put32(out->bytes+11,wire);
    memcpy(nonce,e->tx_prefix,8); memcpy(nonce+8,out->bytes+11,4);
    plain[0]=(uint8_t)kind; if (len) memcpy(plain+1,body,len);
    ctx=EVP_CIPHER_CTX_new();
    if (!ctx || EVP_EncryptInit_ex(ctx,EVP_aes_256_gcm(),NULL,e->tx_key,nonce)!=1 ||
        EVP_EncryptUpdate(ctx,NULL,&n,out->bytes,15)!=1 ||
        EVP_EncryptUpdate(ctx,out->bytes+15,&n,plain,(int)len+1)!=1 ||
        EVP_EncryptFinal_ex(ctx,out->bytes+15+n,&last)!=1 || n+last!=(int)len+1 ||
        EVP_CIPHER_CTX_ctrl(ctx,EVP_CTRL_GCM_GET_TAG,16,out->bytes+16+len)!=1) goto done;
    out->len=32+len; ok=1;
done:
    OPENSSL_cleanse(plain,sizeof(plain)); EVP_CIPHER_CTX_free(ctx);
    return ok || fail(s,"Native encryption failed.");
}
static void cache(ts_session *s, const ts_packet *in, const ts_packet *out) {
    size_t i;
    for (i=0;i<s->response_count;++i) if (packet_equal(&s->responses[i].in,in->bytes,in->len)) { s->responses[i].out=*out; return; }
    if (s->response_count==12) { memmove(s->responses,s->responses+1,11*sizeof(response)); s->response_count--; }
    s->responses[s->response_count++]=(response){*in,*out};
}
static int seen(const window *w, uint32_t n) { return n<=w->high && w->high-n<64 && ((w->bits>>(w->high-n))&1)!=0; }
static void mark(window *w, uint32_t n) {
    if (n>w->high) { uint32_t shift=n-w->high; w->bits=shift>=64?1:(w->bits<<shift)|1; w->high=n; }
    else w->bits|=UINT64_C(1)<<(w->high-n);
}
static void receipt(const epoch *e, uint32_t counter, uint8_t body[12]) {
    window w=e->rx; unsigned i;
    if (counter) mark(&w,counter);
    put32(body,w.high); for (i=0;i<8;++i) body[4+i]=(uint8_t)(w.bits>>(i*8));
}
static int acknowledge(ts_session *s, epoch *e, const uint8_t *body, size_t len, int empty, ts_result *result) {
    uint32_t high; uint64_t bits=0; size_t i,j,out=0;
    if (len!=12) return fail(s,"Invalid receipt length.");
    high=be32(body); for (i=0;i<8;++i) bits|=(uint64_t)body[4+i]<<(8*i);
    if (!high && !bits && empty) return 1;
    if (!high || high>e->tx || !(bits&1) || (high<64 && (bits>>high))) return fail(s,"Invalid receipt bitmap or unsent counter.");
    for (i=0;i<s->outbox_count;++i) {
        pending *p=&s->outbox[i];
        if (p->counter<=high && high-p->counter<64 && ((bits>>(high-p->counter))&1)) result->acknowledged[out++]=p->counter;
    }
    result->acknowledged_count=out;
    for (i=0,j=0;i<s->outbox_count;++i) {
        size_t k; int found=0;
        for (k=0;k<out;++k) if (s->outbox[i].counter==result->acknowledged[k]) found=1;
        if (!found) s->outbox[j++]=s->outbox[i];
    }
    OPENSSL_cleanse(s->outbox+j,(s->outbox_count-j)*sizeof(pending)); s->outbox_count=j;
    return 1;
}
int ts_session_offer(ts_session *s, ts_packet *out) {
    if (s->current || s->pairing.key || s->rekey) return fail(s,"Reset before another pairing.");
    if (!make_share(s,&s->pairing)) return 0;
    out->bytes[0]=0xa7; out->bytes[1]=(uint8_t)s->version; out->bytes[2]=1;
    memcpy(out->bytes+3,s->pairing.bytes,s->share_len); out->len=3+s->share_len;
    s->role=TS_INITIATOR; s->offer=*out; remember(s,out); return 1;
}
int ts_session_confirm(ts_session *s, ts_packet *out) {
    if (!s->current || s->rekey) return fail(s,"Complete public exchange first.");
    if (s->current->local) return fail(s,"Already confirmed.");
    if (!seal(s,s->current,K_READY,NULL,0,out)) return 0;
    s->current->local=1; remember(s,out); return 1;
}
int ts_session_send(ts_session *s, int password, const uint8_t *text, size_t len, ts_packet *out) {
    uint32_t counter;
    if (!ready(s)) return fail(s,"Both peers must confirm before sending.");
    if (s->chat && password) return fail(s,"Chat accepts Message only.");
    if (s->data_locked) return fail(s,"Chat close already committed.");
    if (!len || len>96 || !ts_utf8_valid(text,len)) return fail(s,"Use 1-96 valid UTF-8 bytes.");
    if (s->outbox_count==8 || (s->outbox_count && s->current->tx+1-s->outbox[0].counter>=64)) return fail(s,"Delivery queue/window is full.");
    if (!seal(s,s->current,password?K_PASSWORD:K_MESSAGE,text,len,out)) return 0;
    counter=be32(out->bytes+11); s->outbox[s->outbox_count++]=(pending){counter,*out}; remember(s,out); return 1;
}
int ts_session_retry(ts_session *s, ts_packet *out) {
    if (!s->last.len) return fail(s,"No packet to retry.");
    *out=s->last; return 1;
}
size_t ts_session_pending(const ts_session *s, uint32_t *counters) {
    size_t i; if (counters) for (i=0;i<s->outbox_count;++i) counters[i]=s->outbox[i].counter;
    return s->outbox_count;
}
int ts_session_retry_pending(ts_session *s, ts_packet *out) {
    if (!s->outbox_count) return fail(s,"No pending message.");
    *out=s->outbox[0].packet; remember(s,out); return 1;
}
static int start_rekey(ts_session *s, ts_packet *out) {
    if (s->outbox_count) return fail(s,"Drain pending messages before rekeying.");
    if (!make_share(s,&s->refresh)) return 0;
    if (!seal(s,s->current,K_REKEY_OFFER,s->refresh.bytes,s->share_len,out)) { free_share(&s->refresh); return 0; }
    s->rekey=RK_OFFER; s->rekey_packet=*out; remember(s,out); return 1;
}
int ts_session_rekey(ts_session *s, ts_packet *out) {
    if (s->epoch_locked) return fail(s,"Start a new chat to refresh keys.");
    if (s->rekey) { *out=s->rekey_packet; remember(s,out); return 1; }
    if (!ready(s)) return fail(s,"Establish session before rekeying.");
    if (s->outbox_count) return fail(s,"Drain pending messages before rekeying.");
    if (s->role==TS_INITIATOR) return start_rekey(s,out);
    if (!seal(s,s->current,K_REKEY_REQUEST,NULL,0,out)) return 0;
    s->rekey=RK_REQUEST; s->rekey_packet=*out; remember(s,out); return 1;
}
static void activate(ts_session *s) {
    free_epoch(s->current); s->current=s->candidate; s->candidate=NULL; s->rekey=RK_NONE;
    free_share(&s->refresh); OPENSSL_cleanse(s->turns,sizeof(s->turns)); s->turn_count=0;
}
static int process(ts_session *s, epoch *e, int kind, const uint8_t *body, size_t len,
                   const ts_packet *packet, uint32_t counter, int duplicate, ts_result *out) {
    if (s->epoch_locked && (kind==K_READY || kind==K_REKEY_OFFER || kind==K_REKEY_ANSWER || kind==K_REKEY_REQUEST)) return fail(s,"Chat setup is complete.");
    if (kind==K_READY) {
        if (len) return fail(s,"Invalid confirmation.");
        if (e==s->candidate) {
            if (s->rekey==RK_ANSWER) {
                if (!seal(s,e,K_READY,NULL,0,&out->outbound)) return 0;
                out->has_outbound=1; e->local=e->peer=1; cache(s,packet,&out->outbound); remember(s,&out->outbound);
            } else if (s->rekey!=RK_COMMIT || !e->local) return fail(s,"Unexpected rekey confirmation.");
            e->peer=1; activate(s);
        } else {
            if (s->rekey) return fail(s,"Unexpected old-epoch confirmation.");
            e->peer=1;
        }
        out->type=TS_READY; return 1;
    }
    if (e!=s->current || !e->local || !e->peer) return fail(s,"Unconfirmed session.");
    if (s->chat && (kind==K_PASSWORD || kind==K_ACK)) return fail(s,"Unsupported chat record.");
    if (kind==K_MESSAGE || kind==K_PASSWORD) {
        uint8_t ack[12];
        if (s->data_locked || (s->rekey && s->rekey!=RK_OFFER && s->rekey!=RK_REQUEST)) return fail(s,"Application data is paused/closed.");
        if (!len || !ts_utf8_valid(body,len)) return fail(s,"Invalid UTF-8 application data.");
        if (!s->chat) {
            receipt(e,counter,ack);
            if (!seal(s,e,K_ACK,ack,12,&out->outbound)) return 0;
            out->has_outbound=1; remember(s,&out->outbound);
        }
        out->type=duplicate?TS_DUPLICATE:kind==K_MESSAGE?TS_MESSAGE:TS_PASSWORD; out->counter=counter;
        if (!duplicate) { memcpy(out->text,body,len); out->text_len=len; }
        return 1;
    }
    if (kind==K_ACK) { out->type=TS_ACK; return acknowledge(s,e,body,len,0,out); }
    if (kind==K_TURN) {
        int stage;
        if (!s->chat || s->rekey || len!=19 || body[0]!=2 || body[1]>1 || body[6]>8) return fail(s,"Invalid chat turn.");
        out->number=be32(body+2); out->reply=body[1]; out->pending=body[6]&1; stage=body[6]>>1;
        if (!out->number || out->number>TS_SEQUENCE_MAX || out->reply!=(s->role==TS_INITIATOR) ||
            stage>TS_FINAL || (stage>=TS_COMMIT && out->pending) || (stage==TS_ACK_CLOSE && !out->reply) ||
            ((stage==TS_COMMIT || stage==TS_FINAL) && out->reply)) return fail(s,"Invalid chat turn role/flags.");
        out->close=stage; out->type=TS_TURN;
        return acknowledge(s,e,body+7,12,1,out);
    }
    if (kind==K_REKEY_REQUEST) {
        if (len || s->role!=TS_INITIATOR || s->rekey) return fail(s,"Unexpected rekey request.");
        if (!start_rekey(s,&out->outbound)) return 0;
        out->type=TS_REKEY; out->has_outbound=1; cache(s,packet,&out->outbound); return 1;
    }
    if (kind==K_REKEY_OFFER) {
        share local; epoch *next;
        if (len!=s->share_len || s->role!=TS_RESPONDER || (s->rekey && s->rekey!=RK_REQUEST) || s->outbox_count) return fail(s,"Unexpected rekey offer or pending data.");
        if (!make_share(s,&local)) return 0;
        next=derive(s,&local,body,body,len,local.bytes,s->share_len,e->id);
        if (!next) { free_share(&local); return 0; }
        if (!seal(s,e,K_REKEY_ANSWER,local.bytes,s->share_len,&out->outbound)) { free_share(&local); free_epoch(next); return 0; }
        free_share(&local); s->candidate=next; s->rekey=RK_ANSWER;
        s->rekey_packet=out->outbound; out->has_outbound=1; out->type=TS_REKEY;
        cache(s,packet,&out->outbound); remember(s,&out->outbound); return 1;
    }
    if (kind==K_REKEY_ANSWER) {
        epoch *next;
        if (len!=s->share_len || s->role!=TS_INITIATOR || s->rekey!=RK_OFFER) return fail(s,"Unexpected rekey answer.");
        next=derive(s,&s->refresh,body,s->refresh.bytes,s->share_len,body,len,e->id);
        if (!next) return 0;
        if (!seal(s,next,K_READY,NULL,0,&out->outbound)) { free_epoch(next); return 0; }
        next->local=1; s->candidate=next; s->rekey=RK_COMMIT; s->rekey_packet=out->outbound;
        out->type=TS_REKEY; out->has_outbound=1; cache(s,packet,&out->outbound); remember(s,&out->outbound); return 1;
    }
    return fail(s,"Unknown encrypted record.");
}
int ts_session_receive(ts_session *s, const uint8_t *bytes, size_t len, ts_result *out) {
    ts_packet packet; epoch *e; window *w; uint32_t wire,counter; int control,duplicate,n=0,last=0,ok=0;
    EVP_CIPHER_CTX *ctx=NULL; uint8_t plain[97+EVP_MAX_BLOCK_LENGTH]={0},nonce[12]; size_t i,body_len;
    if (len<3 || len>128 || bytes[0]!=0xa7 || bytes[1]!=s->version) { memset(out,0,sizeof(*out)); return fail(s,"Wrong protocol version/profile."); }
    memcpy(packet.bytes,bytes,len); packet.len=len;
    bytes=packet.bytes; memset(out,0,sizeof(*out));
    for (i=0;i<s->response_count;++i) if (packet_equal(&s->responses[i].in,bytes,len)) {
        if (s->epoch_locked) return fail(s,"Chat setup already completed.");
        out->type=TS_DUPLICATE; out->has_outbound=1; out->outbound=s->responses[i].out; remember(s,&out->outbound); return 1;
    }
    for (i=0;i<s->turn_count;++i) if (packet_equal(&s->turns[i].in,bytes,len)) {
        *out=s->turns[i].event; out->acknowledged_count=0; out->duplicate=1; out->pending_count=s->outbox_count; return 1;
    }
    if (bytes[2]==1 || bytes[2]==2) {
        if (len!=3+s->share_len || !valid_public(s,bytes+3)) return fail(s,"Invalid public record.");
        if (bytes[2]==1) {
            share local;
            if (s->current || s->pairing.key || s->rekey) return fail(s,"Already pairing or paired.");
            if (!make_share(s,&local)) return 0;
            out->outbound.bytes[0]=0xa7; out->outbound.bytes[1]=(uint8_t)s->version; out->outbound.bytes[2]=2;
            memcpy(out->outbound.bytes+3,local.bytes,s->share_len); out->outbound.len=len;
            s->role=TS_RESPONDER; e=derive(s,&local,bytes+3,bytes,len,out->outbound.bytes,len,NULL); free_share(&local);
            if (!e) { s->role=TS_NO_ROLE; return 0; }
            s->current=e; out->type=TS_OFFER; out->has_outbound=1;
            cache(s,&packet,&out->outbound); remember(s,&out->outbound); return 1;
        }
        if (s->role!=TS_INITIATOR || !s->pairing.key || s->current) return fail(s,"Unexpected answer.");
        e=derive(s,&s->pairing,bytes+3,s->offer.bytes,s->offer.len,bytes,len,NULL);
        if (!e) return 0;
        s->current=e; free_share(&s->pairing); out->type=TS_ANSWER; return 1;
    }
    if (bytes[2]!=3 || len<32) return fail(s,"Invalid encrypted packet.");
    e=s->candidate && equal(s->candidate->id,bytes+3,8)?s->candidate:
      s->current && equal(s->current->id,bytes+3,8)?s->current:NULL;
    if (!e) return fail(s,"Wrong session.");
    wire=be32(bytes+11); control=(wire&CONTROL)!=0; counter=wire&TS_SEQUENCE_MAX;
    w=control?&e->rx_control:&e->rx; duplicate=seen(w,counter);
    if (!counter || (uint64_t)counter+64<=w->high || (control && duplicate)) return fail(s,"Replay or stale counter.");
    memcpy(nonce,e->rx_prefix,8); memcpy(nonce+8,bytes+11,4);
    ctx=EVP_CIPHER_CTX_new(); body_len=len-31;
    if (!ctx || EVP_DecryptInit_ex(ctx,EVP_aes_256_gcm(),NULL,e->rx_key,nonce)!=1 ||
        EVP_DecryptUpdate(ctx,NULL,&n,bytes,15)!=1 || EVP_DecryptUpdate(ctx,plain,&n,bytes+15,(int)body_len)!=1 ||
        EVP_CIPHER_CTX_ctrl(ctx,EVP_CTRL_GCM_SET_TAG,16,(void *)(bytes+len-16))!=1 ||
        EVP_DecryptFinal_ex(ctx,plain+n,&last)!=1 || (size_t)(n+last)!=body_len) { fail(s,"Packet authentication failed."); goto done; }
    if (control==(plain[0]==K_MESSAGE || plain[0]==K_PASSWORD)) { fail(s,"Wrong sequence space."); goto done; }
    if (!process(s,e,plain[0],plain+1,body_len-1,&packet,counter,duplicate,out)) goto done;
    mark(w,counter); out->pending_count=s->outbox_count;
    if (out->type==TS_TURN) {
        if (s->turn_count==4) { memmove(s->turns,s->turns+1,3*sizeof(cached_turn)); s->turn_count--; }
        s->turns[s->turn_count].in=packet; s->turns[s->turn_count].event=*out;
        s->turns[s->turn_count++].event.acknowledged_count=0;
    }
    ok=1;
done:
    EVP_CIPHER_CTX_free(ctx); OPENSSL_cleanse(plain,sizeof(plain));
    if (!ok) OPENSSL_cleanse(out,sizeof(*out));
    return ok;
}
int ts_session_turn(ts_session *s, int reply, uint32_t number, int pending_flag, int close, ts_packet *out) {
    uint8_t body[19]={2,0};
    if (!s->chat || !ready(s)) return fail(s,"A ready chat session is required.");
    if (!number || number>TS_SEQUENCE_MAX || (reply!=0 && reply!=1) || (pending_flag!=0 && pending_flag!=1) ||
        close<TS_OPEN || close>TS_FINAL || (close>=TS_COMMIT && (pending_flag || s->outbox_count)) ||
        (close==TS_ACK_CLOSE && !reply) || ((close==TS_COMMIT || close==TS_FINAL) && reply)) return fail(s,"Invalid outgoing turn.");
    body[1]=(uint8_t)reply; put32(body+2,number); body[6]=(uint8_t)(pending_flag|(close<<1)); receipt(s->current,0,body+7);
    if (!seal(s,s->current,K_TURN,body,19,out)) return 0;
    remember(s,out); return 1;
}
int ts_session_lock_epoch(ts_session *s) {
    if (!s->chat || !ready(s)) return fail(s,"A ready chat session is required.");
    s->epoch_locked=1; return 1;
}
int ts_session_lock_data(ts_session *s) {
    if (!s->chat || !ready(s) || s->outbox_count) return fail(s,"Drain a ready chat before locking data.");
    s->data_locked=1; return 1;
}
static int clear_digest(const uint8_t *id, const uint8_t *text, size_t len, uint8_t out[32]) {
    static const char domain[]="audio-text-lab/clear/v1"; uint8_t input[sizeof(domain)+12+96]; int ok;
    memcpy(input,domain,sizeof(domain)); memcpy(input+sizeof(domain),id,12); memcpy(input+sizeof(domain)+12,text,len);
    ok=ts_sha256(input,sizeof(domain)+12+len,out); OPENSSL_cleanse(input,sizeof(input)); return ok;
}
int ts_clear_data(const uint8_t *text, size_t len, ts_packet *out) {
    uint8_t digest[32];
    if (!len || len>96 || !ts_utf8_valid(text,len)) return 0;
    out->bytes[0]=0xa8; out->bytes[1]=1; out->bytes[2]=1;
    if (RAND_bytes(out->bytes+3,12)!=1 || !clear_digest(out->bytes+3,text,len,digest)) return 0;
    memcpy(out->bytes+15,digest,16); memcpy(out->bytes+31,text,len); out->len=31+len; return 1;
}
int ts_clear_parse(const uint8_t *p, size_t n, int *kind, uint8_t *text, size_t *text_len) {
    uint8_t digest[32];
    if (n<31 || n>127 || p[0]!=0xa8 || p[1]!=1 || p[2]<1 || p[2]>3 || (p[2]==1?n==31:n!=31)) return 0;
    *kind=p[2]; *text_len=0;
    if (*kind==1) {
        if (!ts_utf8_valid(p+31,n-31) || !clear_digest(p+3,p+31,n-31,digest) || !equal(digest,p+15,16)) return 0;
        if (text) memcpy(text,p+31,n-31);
        *text_len=n-31;
    }
    return 1;
}
int ts_clear_control(const ts_packet *in, int kind, ts_packet *out) {
    int original; size_t length;
    if ((kind!=2 && kind!=3) || !ts_clear_parse(in->bytes,in->len,&original,NULL,&length)) return 0;
    memmove(out->bytes,in->bytes,31); out->bytes[2]=(uint8_t)kind; out->len=31; return 1;
}
int ts_clear_same(const ts_packet *a, const ts_packet *b) {
    return a->len>=31 && b->len>=31 && equal(a->bytes+3,b->bytes+3,28);
}
