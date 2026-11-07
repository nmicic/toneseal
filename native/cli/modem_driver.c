/* Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0 */
/* Test-only framing/PCM oracle, separate from the live client. */
#include "modem.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void hex(const uint8_t *p, size_t n) { size_t i; for (i=0;i<n;++i) printf("%02x",p[i]); }
static int unhex(const char *p, uint8_t *out, size_t *n) {
    size_t i,len=strlen(p); if (len%2 || len>256) return 0;
    for (i=0;i<len/2;++i) {
        unsigned value; char pair[3]={p[i*2],p[i*2+1],0};
        if (strspn(pair,"0123456789abcdef")!=2 || sscanf(pair,"%x",&value)!=1) return 0;
        out[i]=(uint8_t)value;
    }
    *n=len/2; return 1;
}
static int event(void *context, const ac_event *packet) {
    size_t *count=context; (*count)++;
    printf("{\"packet\":\""); hex(packet->payload,packet->payload_bytes); printf("\",\"sender\":%u,\"corrected\":%u}\n",packet->sender,packet->corrected_nibbles); return 0;
}
int main(int argc, char **argv) {
    ts_packet p={0}; ts_pcm pcm={0},physical={0}; char error[512]={0}; int ok=0;
    if (argc>=3 && !strcmp(argv[1],"frame")) {
        uint8_t out[196]; size_t len;
        if (!unhex(argv[2],p.bytes,&p.len)) return 64;
        len=ts_modem_frame(p.bytes,p.len,argc==4?(uint16_t)strtoul(argv[3],NULL,10):0,out);
        hex(out,len); putchar('\n'); return len?0:1;
    }
    if (argc==3 && !strcmp(argv[1],"timeline")) {
        char *tl; size_t len;
        if (!unhex(argv[2],p.bytes,&p.len) || !ts_modem_timeline(p.bytes,p.len,0,&tl,&len)) return 64;
        fwrite(tl,1,len,stdout); free(tl); return ferror(stdout)?74:0;
    }
    if (argc==6 && !strcmp(argv[1],"render")) {
        if (!unhex(argv[2],p.bytes,&p.len)) return 64;
        ok=ts_modem_render(&p,&pcm,NULL,error,sizeof(error)) && ts_pcm_profile(&pcm,(unsigned)atoi(argv[4]),!strcmp(argv[5],"telephone"),&physical) && ts_wav_write(argv[3],&physical,error,sizeof(error));
        if (ok) printf("{\"frames\":%zu,\"source_frames\":%zu,\"hash\":\"%016llx\"}\n",physical.frames,pcm.frames,(unsigned long long)pcm.hash);
    } else if (argc==4 && !strcmp(argv[1],"decode")) {
        ac_receiver *receiver=malloc(sizeof(*receiver)); ts_resampler resampler; size_t i,count=0;
        if (!receiver) return 70;
        ok=ts_wav_read(argv[2],&pcm,error,sizeof(error));
        if (ok) {
            ac_init(receiver,event,&count); ok=ts_resampler_init(&resampler,pcm.rate,!strcmp(argv[3],"telephone"));
            for (i=0;ok && i<pcm.frames;i+=997) {
                size_t n=pcm.frames-i; if (n>997) n=997;
                ok=ts_resampler_feed(&resampler,receiver,pcm.samples+i,n)==0;
            }
            if (ok) ok=ts_resampler_finish(&resampler,receiver)==0;
            printf("{\"packets\":%zu,\"crcFailures\":%llu}\n",count,(unsigned long long)receiver->counters.crc_failures);
        }
        free(receiver);
    } else return 64;
    ts_pcm_free(&pcm); ts_pcm_free(&physical);
    if (!ok) fprintf(stderr,"%s\n",error[0]?error:"Native modem operation failed.");
    return ok?0:1;
}
