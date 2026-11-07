/* Copyright (c) 2026 Nenad Micic */
/* SPDX-License-Identifier: Apache-2.0 */
/* Host I/O driver; portable_core.c is the bounded receiver. */
#include "portable_core.h"
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <time.h>

static void put_unsigned(uint64_t value, unsigned bytes)
{
    unsigned i;
    for (i=0;i<bytes;++i) { putchar((int)(value&255u)); value>>=8; }
}

static size_t read_pcm(FILE *file, int16_t *out, size_t count, int *bad)
{
    unsigned char bytes[8192];
    size_t i,n=fread(bytes,1,2*count,file);
    if (n&1u) { *bad=1; return 0; }
    for (i=0;i<n/2;++i) {
        unsigned value=(unsigned)bytes[2*i]+256u*bytes[2*i+1];
        out[i]=(int16_t)(value>=32768u?(int32_t)value-65536:(int32_t)value);
    }
    return n/2;
}

static int event_output(void *context, const ac_event *event)
{
    unsigned i;
    (void)context;
    printf("{\"kind\":\"packet\",\"payload_hex\":\"");
    for (i=0;i<event->payload_bytes;++i) printf("%02x",event->payload[i]);
    printf("\",\"payload_bytes\":%u,\"sender\":%u,\"physical_glyphs\":%u,\"ties\":%u,\"corrected_nibbles\":%u,\"ignored_padding\":%u",
        event->payload_bytes,event->sender,event->physical_glyphs,event->ties,event->corrected_nibbles,event->ignored_padding);
    printf(",\"inferred_onset_sample\":%" PRIu64 ",\"inferred_data_end_sample\":%" PRIu64 ",\"logical_available_sample\":%" PRIu64 ",\"delivered_at_sample\":%" PRIu64,
        event->onset,event->data_end,event->logical_sample,event->delivered_sample);
    printf(",\"riff_score_q19\":%" PRIu32 ",\"minimum_margin_q16\":%" PRIu32 ",\"at_eof\":%s}\n",event->riff_score,event->minimum_margin,event->at_eof?"true":"false");
    return ferror(stdout)?1:0;
}

#define COUNTER(name) printf(",\"" #name "\":%" PRIu64,r.counters.name)
static int stream(FILE *file, const char *pattern)
{
    const unsigned irregular[7]={1,47,128,1009,17,4093,64};
    ac_receiver r;
    int16_t input[4096];
    unsigned fixed=0,part=0;
    int bad=0,status=0;
    size_t got;
    clock_t start=clock();
    struct rusage usage;
    struct alignment { char first; ac_receiver receiver; };
    if (!strcmp(pattern,"63")) fixed=63;
    else if (!strcmp(pattern,"256")) fixed=256;
    else if (!strcmp(pattern,"997")) fixed=997;
    else if (!strcmp(pattern,"4096")) fixed=4096;
    else if (strcmp(pattern,"irregular")) return 64;
    ac_init(&r,event_output,NULL);
    while ((got=read_pcm(file,input,fixed?fixed:irregular[part++%7],&bad))>0) {
        status=ac_feed(&r,input,got);
        if (status) break;
    }
    if (!status && !bad && !ferror(file)) status=ac_finish(&r);
    if (bad || ferror(file)) status=65;
    (void)getrusage(RUSAGE_SELF,&usage);
    printf("{\"kind\":\"summary\",\"status\":%d,\"samples\":%" PRIu64 ",\"windows\":%" PRIu64 ",\"scores\":%" PRIu64 ",\"maximum_riff_score_q19\":%" PRIu32,
        status,r.input_samples,r.windows,r.scores,r.maximum_riff_score);
    printf(",\"state_bytes\":%zu,\"state_alignment\":%zu,\"workspace_bytes\":%zu,\"cpu_ticks\":%" PRIu64 ",\"clocks_per_second\":%" PRIu64 ",\"maximum_rss_native\":%ld",
        sizeof(r),offsetof(struct alignment,receiver),sizeof(ac_workspace),(uint64_t)(clock()-start),(uint64_t)CLOCKS_PER_SEC,usage.ru_maxrss);
    COUNTER(local_candidates); COUNTER(admitted_candidates); COUNTER(dropped_new_candidates);
    COUNTER(evicted_candidates); COUNTER(suppressed_candidates); COUNTER(invalid_headers);
    COUNTER(oversize_headers); COUNTER(invalid_payloads); COUNTER(crc_failures); COUNTER(ring_overruns); COUNTER(packets);
    COUNTER(eof_packets); COUNTER(pending_at_eof); COUNTER(groups_at_eof); COUNTER(demodulated_windows);
    COUNTER(max_candidate_groups); COUNTER(max_hypotheses); COUNTER(max_demod_batch);
    COUNTER(max_oldest_window_age); COUNTER(max_retained_glyphs); COUNTER(operation_errors);
    COUNTER(reentrant_calls); COUNTER(numeric_refusals);
    printf("}\n");
    return status;
}

static int features(FILE *file)
{
    ac_workspace work;
    int16_t input[960];
    size_t count;
    int bad=0,status;
    unsigned i;
    uint8_t tie,symbol;
    uint32_t margin;
    while ((count=read_pcm(file,input,960,&bad))>0) {
        if (count!=960) return 65;
        status=ac_features(&work,input);
        if (status) return status;
        for (i=0;i<64;++i) {
            put_unsigned((uint32_t)work.fft[i+12].re,4);
            put_unsigned((uint32_t)work.fft[i+12].im,4);
        }
        for (i=0;i<64;++i) put_unsigned(work.power[i],8);
        for (i=0;i<64;++i) put_unsigned(work.normalized[i],4);
        symbol=ac_symbol(work.normalized,&tie,&margin);
        put_unsigned(symbol,1); put_unsigned(tie,1); put_unsigned(margin,4);
    }
    return bad || ferror(file) || ferror(stdout)?65:0;
}

static int reed_solomon(FILE *file)
{
    uint8_t word[15],data[11];
    uint16_t mask;
    size_t count;
    while ((count=fread(word,1,15,file))>0) {
        int status;
        if (count!=15) return 65;
        memset(data,0,11); mask=0;
        status=ac_rs_decode(word,data,&mask);
        put_unsigned((unsigned)status,1);
        if (!status) { memset(data,0,11); mask=0; }
        fwrite(data,1,11,stdout); put_unsigned(mask,2);
    }
    return ferror(file) || ferror(stdout)?65:0;
}

static int headers(FILE *file)
{
    uint8_t values[24];
    uint16_t length,sender,count;
    size_t got;
    while ((got=fread(values,1,24,file))>0) {
        int status;
        if (got!=24) return 65;
        length=sender=count=0;
        status=ac_header(values,&length,&sender,&count);
        put_unsigned((unsigned)(status+1),1); put_unsigned(length,2);
        put_unsigned(sender,2); put_unsigned(count,2);
    }
    return ferror(file) || ferror(stdout)?65:0;
}

static int frames(FILE *file)
{
    uint8_t values[196],header[2];
    size_t got;
    ac_event event;
    while ((got=fread(header,1,2,file))>0) {
        unsigned count;
        int status;
        if (got!=2) return 65;
        count=(unsigned)header[0]+256u*header[1];
        if (count>196 || fread(values,1,count,file)!=count) return 65;
        memset(&event,0,sizeof(event));
        status=ac_frame(values,(uint16_t)count,&event);
        if (status) event_output(NULL,&event);
        else printf("{\"kind\":\"refused\"}\n");
    }
    return ferror(file) || ferror(stdout)?65:0;
}

int main(int argc, char **argv)
{
    FILE *file;
    int result;
    if (argc<3) return 64;
    file=fopen(argv[2],"rb");
    if (!file) return 66;
    if (!strcmp(argv[1],"stream") && argc==4) result=stream(file,argv[3]);
    else if (!strcmp(argv[1],"features") && argc==3) result=features(file);
    else if (!strcmp(argv[1],"rs") && argc==3) result=reed_solomon(file);
    else if (!strcmp(argv[1],"headers") && argc==3) result=headers(file);
    else if (!strcmp(argv[1],"frames") && argc==3) result=frames(file);
    else result=64;
    if (fclose(file)) return 74;
    return result;
}
