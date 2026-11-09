/* Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0 */
/* Test-only virtual-clock driver for the production transfer controller. */
#include "transfer.h"
#include <openssl/crypto.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef struct { int delivery,mode; uint32_t counter; uint8_t text[96]; size_t len; } event;
static event events[16]; static size_t event_count;
static void message(void *context, int mode, const uint8_t *text, size_t len, uint32_t counter) {
    event *e; (void)context;
    if (event_count==16) abort();
    e=&events[event_count++]; e->mode=mode; e->counter=counter; memcpy(e->text,text,len); e->len=len;
}
static void delivery(void *context, uint32_t counter) {
    event *e; (void)context;
    if (event_count==16) abort();
    e=&events[event_count++]; e->delivery=1; e->counter=counter;
}
static void hex(const uint8_t *p, size_t n) { size_t i; for (i=0;i<n;++i) printf("%02x",p[i]); }
static int unhex(const char *p, uint8_t *out, size_t *len) {
    size_t n=strlen(p),i; if (n%2 || n>256) return 0;
    for (i=0;i<n/2;++i) { char pair[3]={p[i*2],p[i*2+1],0}; unsigned v; if (strspn(pair,"0123456789abcdef")!=2 || sscanf(pair,"%x",&v)!=1) return 0; out[i]=(uint8_t)v; }
    *len=n/2; return 1;
}
static void emit(ts_transfer *t, double now, int ok) {
    ts_status s; ts_packet packet; size_t i;
    int sending=ts_transfer_next(t,now,&packet); ts_transfer_status(t,&s);
    printf("{\"ok\":%s",ok?"true":"false");
    if (sending) { printf(",\"packet\":\""); hex(packet.bytes,packet.len); printf("\""); }
    printf(",\"state\":{\"phase\":\"%s\",\"active\":%s,\"connected\":%s,\"verified\":%s,\"closing\":%s,\"closeConfirmed\":%s,\"pending\":%zu,\"turn\":%u,\"sent\":%u,\"received\":%u,\"delivered\":%u,\"retries\":%u,\"rejected\":%u,\"nextDue\":%.3f,\"idleDeadline\":%.3f,\"fingerprint\":\"%s\",\"reason\":\"%s\"},\"events\":[",
           ts_phase_name(s.phase),s.active?"true":"false",s.connected?"true":"false",s.verified?"true":"false",s.closing?"true":"false",s.close_confirmed?"true":"false",s.pending,s.turn,s.sent,s.received,s.delivered,s.retries,s.rejected,s.next_due,s.idle_deadline,s.fingerprint,s.reason);
    for (i=0;i<event_count;++i) {
        event *e=&events[i]; printf("%s{\"type\":\"%s\",\"counter\":%u,\"mode\":%d",i?",":"",e->delivery?"delivered":"message",e->counter,e->mode);
        if (!e->delivery) { printf(",\"hex\":\""); hex(e->text,e->len); printf("\""); }
        printf("}");
    }
    printf("]}\n"); fflush(stdout); OPENSSL_cleanse(events,sizeof(events)); event_count=0;
}
int main(int argc, char **argv) {
    ts_options options={0}; ts_transfer *t; uint8_t initial[128]={0}; size_t len=0;
    char line[1024]; double now=0;
    if (argc<7 || argc>9 || (strcmp(argv[1],"p256") && strcmp(argv[1],"x25519"))) return 64;
    options.profile=!strcmp(argv[1],"x25519")?TS_X25519:TS_P256;
    options.chat=!strcmp(argv[2],"chat");
    options.mode=!strcmp(argv[2],"password")?TS_MODE_PASSWORD:!strcmp(argv[2],"clear")?TS_MODE_CLEAR:TS_MODE_MESSAGE;
    options.sender=!strcmp(argv[3],"send"); options.verify=atoi(argv[4]); options.auto_close=atoi(argv[5]);
    options.idle_ms=argc>=8?(unsigned)atoi(argv[7]):60000; options.audio_profile=argc==9?atoi(argv[8]):0;
    if (!unhex(argv[6],initial,&len)) return 64;
    t=ts_transfer_new(&options,initial,len,0,message,delivery,NULL); OPENSSL_cleanse(initial,sizeof(initial)); if (!t) return 64;
    while (fgets(line,sizeof(line),stdin)) {
        char *command,*time,*arg; int ok=1; uint8_t packet[128]; size_t n=0; double next;
        line[strcspn(line,"\r\n")]=0; command=strtok(line," "); time=strtok(NULL," "); arg=strtok(NULL," ");
        if (!command || !time) { emit(t,now,0); continue; }
        next=strtod(time,NULL); if (!isfinite(next) || next<now) { emit(t,now,0); continue; } now=next;
        if (!strcmp(command,"tick")) ts_transfer_tick(t,now);
        else if (!strcmp(command,"sent")) ts_transfer_sent(t,now);
        else if (!strcmp(command,"receive") && arg && unhex(arg,packet,&n)) ts_transfer_receive(t,packet,n,now);
        else if (!strcmp(command,"confirm")) ok=ts_transfer_confirm(t,now);
        else if (!strcmp(command,"close")) ts_transfer_close(t,now);
        else if (!strcmp(command,"stop")) ts_transfer_stop(t);
        else if (!strcmp(command,"enqueue") && arg && unhex(arg,packet,&n)) ok=ts_transfer_enqueue(t,packet,n,now);
        else ok=0;
        emit(t,now,ok); OPENSSL_cleanse(packet,sizeof(packet)); OPENSSL_cleanse(line,sizeof(line));
    }
    ts_transfer_free(t); return ferror(stdin)?74:0;
}
