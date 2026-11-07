/* Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0 */
#include "modem.h"
#include "jottune_bridge.h"
#include <openssl/crypto.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static unsigned mul(unsigned a, unsigned b) {
    unsigned out=0,i;
    for (i=0;i<4;++i) { if (b&1) out^=a; b>>=1; a<<=1; if (a&16) a^=19; }
    return out;
}
static unsigned crc(const uint8_t *p, size_t n, unsigned bits, unsigned poly, unsigned value) {
    unsigned top=1u<<(bits-1),mask=(1u<<bits)-1,j; size_t i;
    for (i=0;i<n;++i) { value^=(unsigned)p[i]<<(bits-8); for (j=0;j<8;++j) value=((value<<1)^((value&top)?poly:0))&mask; }
    return value;
}
static void rs(const uint8_t data[11], uint8_t out[15]) {
    uint8_t polynomial[5]={1},work[15]={0}; unsigned power=1,root,i,j;
    for (root=1;root<=4;++root) {
        uint8_t next[5]={0}; power=mul(power,2);
        for (i=0;i<root;++i) { next[i]^=polynomial[i]; next[i+1]^=(uint8_t)mul(polynomial[i],power); }
        memcpy(polynomial,next,sizeof(next));
    }
    memcpy(work,data,11);
    for (i=0;i<11;++i) { unsigned v=work[i]; for (j=1;j<5;++j) work[i+j]^=(uint8_t)mul(v,polynomial[j]); }
    memcpy(out,data,11); memcpy(out+11,work+11,4);
}
static size_t pack(const uint8_t *nibbles, size_t n, uint8_t *out) {
    size_t i;
    for (i=0;i<(n+1)/2;++i) out[i]=(uint8_t)((nibbles[2*i]<<4)|(2*i+1<n?nibbles[2*i+1]:0));
    return (n+1)/2;
}
size_t ts_modem_frame(const uint8_t *payload, size_t n, uint16_t sender, uint8_t out[196]) {
    uint8_t prefix[11]={0},check_bytes[5],word[15],header[8],data[264]={0},blocks[24][15],interleaved[360],body[180];
    size_t length=n*2,count,i,j,position=0,body_len; unsigned check;
    if (n>128) return 0;
    prefix[0]=(uint8_t)((length>>8)&15); prefix[1]=(uint8_t)((length>>4)&15); prefix[2]=(uint8_t)(length&15);
    for (i=0;i<4;++i) prefix[4+i]=(uint8_t)((sender>>(12-4*i))&15);
    pack(prefix,9,check_bytes); check=crc(check_bytes,5,8,7,0); prefix[8]=(uint8_t)(check>>4); prefix[9]=(uint8_t)(check&15);
    rs(prefix,word); pack(word,15,header);
    for (i=0;i<n;++i) { data[i*2]=payload[i]>>4; data[i*2+1]=payload[i]&15; }
    check=crc(payload,n,16,0x1021,0xffff);
    for (i=0;i<4;++i) data[length+i]=(uint8_t)((check>>(12-4*i))&15);
    count=(length+4+10)/11;
    for (i=0;i<count;++i) rs(data+i*11,blocks[i]);
    for (i=0;i<15;++i) for (j=0;j<count;++j) interleaved[position++]=blocks[j][i];
    body_len=pack(interleaved,position,body);
    memcpy(out,header,8); memcpy(out+8,body,8); memcpy(out+16,header,8); memcpy(out+24,body+8,body_len-8);
    return 16+body_len;
}
static int append(char *out, size_t cap, size_t *used, const char *format, ...) {
    va_list args; int n;
    va_start(args,format); n=vsnprintf(out+*used,cap-*used,format,args); va_end(args);
    if (n<0 || (size_t)n>=cap-*used) return 0;
    *used+=(size_t)n; return 1;
}
int ts_modem_timeline(const uint8_t *payload, size_t n, uint16_t sender, char **out, size_t *len) {
    static const uint8_t preamble[8]={0,255,85,170,51,204,105,150};
    uint8_t glyphs[204]; char engine[160],*text; size_t count,used=0,i; unsigned voice;
    const size_t cap=160000;
    if (n>128) return 0;
    memcpy(glyphs,preamble,8); count=ts_modem_frame(payload,n,sender,glyphs+8)+8;
    fms_engine_line(engine,sizeof(engine));
    text=malloc(cap); if (!text) return 0;
    if (!append(text,cap,&used,"timeline draft1\nengine %s\nfs 48000\nlength_ns %llu\nstreams message\npatch sine 0 65536 300 0 0 0 1 1 0 1\npatch sine 1 65536 0 0 0 0 1 1 0 1\n",
                engine,(unsigned long long)(80+count*20)*1000000)) goto failed;
    for (voice=0;voice<4;++voice) if (!append(text,cap,&used,"voice %u sine\n",voice)) goto failed;
    for (i=0;i<count;++i) {
        unsigned long long start=(40+(unsigned long long)i*20)*1000000;
        for (voice=0;voice<4;++voice) {
            unsigned frequency=600+50*(voice*16+((glyphs[i]>>4)^mul(glyphs[i]&15,voice)));
            if (!append(text,cap,&used,"%llu message %u on %u 32767\n%llu message %u off\n",start,voice,frequency*1000,start+18000000,voice)) goto failed;
        }
    }
    *out=text; *len=used; return 1;
failed:
    free(text); return 0;
}
void ts_pcm_free(ts_pcm *p) {
    if (p->samples) OPENSSL_clear_free(p->samples,p->frames*sizeof(int16_t));
    memset(p,0,sizeof(*p));
}
int ts_modem_render(const ts_packet *packet, ts_pcm *out, volatile sig_atomic_t *cancel, char *error, size_t cap) {
    fms_player_t *player=NULL,*replay=NULL; fms_info_t info; char *timeline=NULL,*record=NULL;
    size_t len=0,record_len; uint32_t position=0,written=0; int16_t buffer[113]; int ok=0;
    memset(out,0,sizeof(*out));
    if (!ts_modem_timeline(packet->bytes,packet->len,0,&timeline,&len)) { snprintf(error,cap,"Cannot prepare the packet timeline."); goto done; }
    if (cancel && *cancel) goto done;
    if (fms_player_import(timeline,len,NULL,&player,error,cap)!=FMS_OK) goto done;
    fms_player_info(player,&info);
    if (info.fs!=48000 || info.channels!=1 || !info.frames || info.frames>48000*6u) { snprintf(error,cap,"Unexpected synth dimensions."); goto done; }
    out->frames=info.frames; out->rate=info.fs; out->samples=malloc(out->frames*sizeof(int16_t));
    if (!out->samples) goto done;
    while (position<info.frames) {
        uint32_t count=info.frames-position; if (count>256) count=256;
        if ((cancel && *cancel) || fms_player_render_checked(player,out->samples+position,count,NULL,&written,error,cap)!=FMS_OK || !written || written>count) goto done;
        position+=written;
    }
    if (fms_player_clipped(player)) { snprintf(error,cap,"Synth waveform clipped."); goto done; }
    out->hash=fms_player_hash(player); record_len=fms_player_record_text(player,NULL,0);
    if (!record_len || record_len>200000) { snprintf(error,cap,"Canonical synth record is unavailable."); goto done; }
    record=malloc(record_len); if (!record || fms_player_record_text(player,record,record_len)!=record_len) goto done;
    if (fms_player_import(record,record_len-1,NULL,&replay,error,cap)!=FMS_OK) goto done;
    for (position=0;position<info.frames;position+=written) {
        uint32_t count=info.frames-position; if (count>113) count=113;
        if ((cancel && *cancel) || fms_player_render_checked(replay,buffer,count,NULL,&written,error,cap)!=FMS_OK || !written || written>count ||
            memcmp(buffer,out->samples+position,written*sizeof(int16_t))) { snprintf(error,cap,"Canonical synth replay differs."); goto done; }
    }
    if (fms_player_hash(replay)!=out->hash || fms_player_clipped(replay)) { snprintf(error,cap,"Canonical synth hash differs."); goto done; }
    ok=1;
done:
    fms_player_close(player); fms_player_close(replay); free(timeline); free(record);
    if (!ok) { ts_pcm_free(out); if (cancel && *cancel) snprintf(error,cap,"Cancelled."); else if (!error[0]) snprintf(error,cap,"Native packet rendering failed."); }
    return ok;
}
static int16_t rounded(double value) {
    if (value>32767) return 32767;
    if (value< -32768) return -32768;
    return (int16_t)floor(value+0.5);
}
int ts_pcm_profile(const ts_pcm *source, unsigned rate, int telephone, ts_pcm *out) {
    size_t i; double scale;
    if ((rate!=44100 && rate!=48000) || !source->frames || source->rate!=48000) return 0;
    scale=48000.0*(telephone?0.75:1)/rate;
    memset(out,0,sizeof(*out)); out->rate=rate; out->frames=(size_t)ceil(source->frames/scale);
    out->samples=malloc(out->frames*sizeof(int16_t)); if (!out->samples) return 0;
    for (i=0;i<out->frames;++i) {
        double position=i*scale,fraction; size_t index=(size_t)position,next;
        if (index>=source->frames) index=source->frames-1;
        fraction=position-floor(position); next=index+1<source->frames?index+1:index;
        out->samples[i]=rounded(source->samples[index]*(1-fraction)+source->samples[next]*fraction);
    }
    return 1;
}
static unsigned le16(const uint8_t *p) { return p[0]|(unsigned)p[1]<<8; }
static uint32_t le32(const uint8_t *p) { return le16(p)|(uint32_t)le16(p+2)<<16; }
static void put16(uint8_t *p, unsigned n) { p[0]=(uint8_t)n; p[1]=(uint8_t)(n>>8); }
static void put32(uint8_t *p, uint32_t n) { put16(p,n&65535); put16(p+2,n>>16); }
int ts_wav_read(const char *name, ts_pcm *out, char *error, size_t cap) {
    FILE *f=NULL; uint8_t *file=NULL; size_t len,offset,data=0,size=0,i,frames;
    unsigned encoding=0,channels=0,rate=0,align=0,bits=0; int format=0,have_data=0,ok=0;
    memset(out,0,sizeof(*out)); f=fopen(name,"rb"); if (!f) goto done;
    file=malloc(4*1024*1024+1); if (!file) goto done;
    len=fread(file,1,4*1024*1024+1,f);
    if (ferror(f) || len<44 || len>4*1024*1024 || memcmp(file,"RIFF",4) || memcmp(file+8,"WAVE",4) || (uint64_t)le32(file+4)+8!=len) goto done;
    for (offset=12;offset+8<=len;) {
        size_t n=le32(file+offset+4),end;
        if (n>len-offset-8) goto done;
        end=offset+8+n;
        if (!memcmp(file+offset,"fmt ",4)) {
            if (format || n<16) goto done;
            format=1; encoding=le16(file+offset+8); channels=le16(file+offset+10); rate=le32(file+offset+12);
            align=le16(file+offset+20); bits=le16(file+offset+22);
        }
        if (!memcmp(file+offset,"data",4)) { if (have_data) goto done; have_data=1; data=offset+8; size=n; }
        offset=end+(n&1);
    }
    if (!format || !have_data || encoding!=1 || (channels!=1 && channels!=2) || (rate!=44100 && rate!=48000) || bits!=16 || align!=channels*2 || size%align) goto done;
    frames=size/align; if (!frames || frames>rate*20u) goto done;
    out->samples=malloc(frames*sizeof(int16_t)); if (!out->samples) goto done;
    out->frames=frames; out->rate=rate;
    for (i=0;i<frames;++i) { unsigned n=le16(file+data+i*align); out->samples[i]=(int16_t)(n>=32768?(int)n-65536:(int)n); }
    ok=1;
done:
    if (f) fclose(f);
    if (file) OPENSSL_clear_free(file,4*1024*1024+1);
    if (!ok) { ts_pcm_free(out); snprintf(error,cap,"Use a complete mono/stereo PCM16 WAV, 44.1/48 kHz, at most 20 seconds and 4 MiB."); }
    return ok;
}
static int write_all(int fd, const uint8_t *p, size_t n) {
    while (n) { ssize_t wrote=write(fd,p,n); if (wrote<0 && errno==EINTR) continue; if (wrote<=0) return 0; p+=wrote; n-=(size_t)wrote; }
    return 1;
}
int ts_wav_write(const char *name, const ts_pcm *pcm, char *error, size_t cap) {
    uint8_t header[44]={0},data[4096]; int fd; size_t i,offset=0; int ok=1;
    if (pcm->frames>(UINT32_MAX-36)/2) return 0;
    fd=open(name,O_WRONLY|O_CREAT|O_EXCL,0600);
    if (fd<0) { snprintf(error,cap,"Cannot create a new WAV output: %s",strerror(errno)); return 0; }
    memcpy(header,"RIFF",4); put32(header+4,(uint32_t)(pcm->frames*2+36)); memcpy(header+8,"WAVEfmt ",8);
    put32(header+16,16); put16(header+20,1); put16(header+22,1); put32(header+24,pcm->rate); put32(header+28,pcm->rate*2);
    put16(header+32,2); put16(header+34,16); memcpy(header+36,"data",4); put32(header+40,(uint32_t)(pcm->frames*2));
    ok=write_all(fd,header,44);
    while (ok && offset<pcm->frames) {
        size_t n=pcm->frames-offset; if (n>2048) n=2048;
        for (i=0;i<n;++i) put16(data+i*2,(uint16_t)pcm->samples[offset+i]);
        ok=write_all(fd,data,n*2); offset+=n;
    }
    if (close(fd)) ok=0;
    if (!ok) { unlink(name); snprintf(error,cap,"WAV output failed."); }
    return ok;
}
int ts_resampler_init(ts_resampler *r, unsigned rate, int telephone) {
    if (rate!=44100 && rate!=48000) return 0;
    memset(r,0,sizeof(*r)); r->step=rate*(telephone?4:1); r->den=48000*(telephone?3:1); return 1;
}
int ts_resampler_feed(ts_resampler *r, ac_receiver *receiver, const int16_t *input, size_t n) {
    size_t i;
    for (i=0;i<n;++i,++r->index) {
        uint64_t now=r->index*r->den;
        while (r->next<=now) {
            double value=input[i];
            if (r->started) { double fraction=(double)(r->next-(r->index-1)*r->den)/r->den; value=r->previous*(1-fraction)+input[i]*fraction; }
            r->buffer[r->count++]=rounded(value); r->next+=r->step;
            if (r->count==1024) { int status=ac_feed(receiver,r->buffer,r->count); r->count=0; if (status) return status; }
        }
        r->previous=input[i]; r->started=1;
    }
    if (r->count) { int status=ac_feed(receiver,r->buffer,r->count); r->count=0; if (status) return status; }
    return 0;
}
int ts_resampler_finish(ts_resampler *r, ac_receiver *receiver) {
    (void)r; return ac_finish(receiver);
}
