/* Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0 */
/* Test-only packet oracle. Never linked into the production audio client. */
#include "session.h"
#include <openssl/crypto.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void hex(const uint8_t *p, size_t n) { size_t i; for (i=0;i<n;++i) printf("%02x",p[i]); }
static int unhex(const char *p, uint8_t *out, size_t *len) {
    size_t n=strlen(p),i;
    if (n%2 || n>256) return 0;
    for (i=0;i<n/2;++i) {
        unsigned a,b; char x=p[2*i],y=p[2*i+1];
        if (x>='0' && x<='9') a=(unsigned)(x-'0'); else if (x>='a' && x<='f') a=(unsigned)(x-'a'+10); else return 0;
        if (y>='0' && y<='9') b=(unsigned)(y-'0'); else if (y>='a' && y<='f') b=(unsigned)(y-'a'+10); else return 0;
        out[i]=(uint8_t)((a<<4)|b);
    }
    *len=n/2; return 1;
}
static void emit(ts_session *s, int ok, const ts_packet *p, const ts_result *event) {
    static const char *types[]={"none","offer","answer","ready","rekey","ack","message","password","duplicate","chat-turn"};
    static const char *closes[]={"open","drain","commit","ack","final"};
    ts_info info; uint32_t counters[8]; size_t i,count;
    ts_session_info(s,&info); count=ts_session_pending(s,counters);
    printf("{\"ok\":%s",ok?"true":"false");
    if (!ok) printf(",\"error\":\"%s\"",ts_session_error(s));
    if (p && p->len) { printf(",\"packet\":\""); hex(p->bytes,p->len); printf("\""); }
    if (event && ok) {
        printf(",\"type\":\"%s\",\"counter\":%u,\"number\":%u,\"reply\":%s,\"pending\":%s,\"close\":\"%s\",\"duplicate\":%s",
            types[event->type],event->counter,event->number,event->reply?"true":"false",event->pending?"true":"false",closes[event->close],event->duplicate?"true":"false");
        if (event->has_outbound) { printf(",\"outbound\":\""); hex(event->outbound.bytes,event->outbound.len); printf("\""); }
        if (event->text_len) { printf(",\"text_hex\":\""); hex(event->text,event->text_len); printf("\""); }
        printf(",\"acknowledged\":["); for (i=0;i<event->acknowledged_count;++i) printf("%s%u",i?",":"",event->acknowledged[i]); printf("]");
    }
    printf(",\"info\":{\"state\":\"%s\",\"role\":",info.rekeying?"rekeying":info.ready?"ready":info.fingerprint[0]?"verify":info.role?"offering":"idle");
    if (info.role) printf("\"%s\"",info.role==TS_INITIATOR?"initiator":"responder"); else printf("null");
    printf(",\"fingerprint\":\"%s\",\"localConfirmed\":%s,\"peerConfirmed\":%s,\"pendingCount\":%zu,\"version\":%d,\"sessionId\":\"",
        info.fingerprint,info.local_confirmed?"true":"false",info.peer_confirmed?"true":"false",count,info.version);
    hex(info.session_id,8); printf("\"},\"pendingCounters\":[");
    for (i=0;i<count;++i) printf("%s%u",i?",":"",counters[i]);
    printf("]}\n"); fflush(stdout);
}
int main(int argc, char **argv) {
    ts_session *s; char line[1024]; int chat,profile;
    if (argc!=3 || (strcmp(argv[1],"p256") && strcmp(argv[1],"x25519")) ||
        (strcmp(argv[2],"message") && strcmp(argv[2],"chat"))) return 64;
    profile=!strcmp(argv[1],"x25519")?TS_X25519:TS_P256; chat=!strcmp(argv[2],"chat");
    s=ts_session_new(profile,chat); if (!s) return 70;
    while (fgets(line,sizeof(line),stdin)) {
        ts_packet packet={0}; ts_result event={0}; uint8_t bytes[128]={0}; size_t len=0;
        char *command,*arg; int ok=0,has_event=0;
        line[strcspn(line,"\r\n")]=0; command=strtok(line," "); if (!command) continue;
        arg=strtok(NULL," ");
        if (!strcmp(command,"offer")) ok=ts_session_offer(s,&packet);
        else if (!strcmp(command,"confirm")) ok=ts_session_confirm(s,&packet);
        else if (!strcmp(command,"rekey")) ok=ts_session_rekey(s,&packet);
        else if (!strcmp(command,"retry")) ok=ts_session_retry(s,&packet);
        else if (!strcmp(command,"retry-pending")) ok=ts_session_retry_pending(s,&packet);
        else if (!strcmp(command,"reset")) { ts_session_reset(s); ok=1; }
        else if (!strcmp(command,"info")) ok=1;
        else if (!strcmp(command,"lock-epoch")) ok=ts_session_lock_epoch(s);
        else if (!strcmp(command,"lock-data")) ok=ts_session_lock_data(s);
        else if (!strcmp(command,"receive") && arg && unhex(arg,bytes,&len)) { has_event=1; ok=ts_session_receive(s,bytes,len,&event); }
        else if (!strcmp(command,"message") && arg && unhex(arg,bytes,&len)) ok=ts_session_send(s,0,bytes,len,&packet);
        else if (!strcmp(command,"password") && arg && unhex(arg,bytes,&len)) ok=ts_session_send(s,1,bytes,len,&packet);
        else if (!strcmp(command,"clear") && arg && unhex(arg,bytes,&len)) ok=ts_clear_data(bytes,len,&packet);
        else if (!strcmp(command,"turn") && arg) {
            char *number=strtok(NULL," "),*pending=strtok(NULL," "),*close=strtok(NULL," ");
            if (number && pending && close) ok=ts_session_turn(s,atoi(arg),(uint32_t)strtoul(number,NULL,10),atoi(pending),atoi(close),&packet);
        }
        emit(s,ok,packet.len?&packet:NULL,has_event?&event:NULL);
        OPENSSL_cleanse(bytes,sizeof(bytes)); OPENSSL_cleanse(&event,sizeof(event)); OPENSSL_cleanse(line,sizeof(line));
    }
    ts_session_free(s); return ferror(stdin)?74:0;
}
