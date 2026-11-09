/* Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0 */
#include "audio.h"
#include <portaudio.h>
#include <openssl/crypto.h>
#include <math.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef __APPLE__
#include <mach/mach_time.h>
#endif

#define RING_SIZE (1u<<18)
struct ts_audio {
    PaStream *stream;
    float *ring,*transmit;
    size_t transmit_frames;
    atomic_uint_fast64_t written,read,dropped,overflows,underflows;
    atomic_size_t transmit_at;
    atomic_int transmitting;
    unsigned rate; int audio_profile,output_channels;
    double output_latency,input_peak;
    uint64_t clipped;
    struct { ts_packet packet; ts_pcm pcm; } cache[4]; size_t cache_next;
};
double ts_clock_ms(void) {
#ifdef __APPLE__
    static mach_timebase_info_data_t timebase;
    if (!timebase.denom) mach_timebase_info(&timebase);
    return (double)mach_continuous_time()*timebase.numer/timebase.denom/1000000;
#else
    struct timespec t;
#ifdef CLOCK_BOOTTIME
    clock_gettime(CLOCK_BOOTTIME,&t);
#else
    clock_gettime(CLOCK_MONOTONIC,&t);
#endif
    return t.tv_sec*1000.0+t.tv_nsec/1000000.0;
#endif
}
static void pause_ms(unsigned ms) { struct timespec t={(time_t)(ms/1000),(long)(ms%1000)*1000000}; nanosleep(&t,NULL); }
static int callback(const void *input, void *output, unsigned long count,
                    const PaStreamCallbackTimeInfo *time, PaStreamCallbackFlags flags, void *context) {
    ts_audio *a=context; const float *in=input; float *out=output; size_t i,position=0;
    uint64_t write_at=atomic_load_explicit(&a->written,memory_order_relaxed),read_at=atomic_load_explicit(&a->read,memory_order_acquire);
    int transmitting=atomic_load_explicit(&a->transmitting,memory_order_acquire);
    (void)time;
    if (flags&paInputOverflow) atomic_fetch_add_explicit(&a->overflows,1,memory_order_relaxed);
    if (flags&paOutputUnderflow) atomic_fetch_add_explicit(&a->underflows,1,memory_order_relaxed);
    if (transmitting) position=atomic_load_explicit(&a->transmit_at,memory_order_relaxed);
    for (i=0;i<count;++i) {
        float sample=transmitting && position<a->transmit_frames?a->transmit[position++]:0;
        if (out) { int channel; for (channel=0;channel<a->output_channels;++channel) out[i*a->output_channels+channel]=sample; }
        if (!transmitting) {
            if (write_at-read_at<RING_SIZE) a->ring[(write_at++)&(RING_SIZE-1)]=in?in[i]:0;
            else atomic_fetch_add_explicit(&a->dropped,1,memory_order_relaxed);
        }
    }
    atomic_store_explicit(&a->written,write_at,memory_order_release);
    if (transmitting) {
        atomic_store_explicit(&a->transmit_at,position,memory_order_relaxed);
        if (position>=a->transmit_frames) atomic_store_explicit(&a->transmitting,0,memory_order_release);
    }
    return paContinue;
}
static void print_name(FILE *out, const char *name) {
    const unsigned char *p=(const unsigned char *)name;
    for (;*p;++p) {
        if (*p<32 || *p==127 || *p=='"' || *p=='\\') fprintf(out,"\\u%04x",*p);
        else fputc(*p,out);
    }
}
int ts_audio_devices(FILE *out, int json) {
    PaError error=Pa_Initialize(); int count,i;
    if (error!=paNoError) return 0;
    count=Pa_GetDeviceCount();
    if (json) fputs("[",out);
    for (i=0;i<count;++i) {
        const PaDeviceInfo *info=Pa_GetDeviceInfo(i);
        if (json) { fprintf(out,"%s{\"id\":%d,\"name\":\"",i?",":"",i); print_name(out,info->name); fprintf(out,"\",\"inputs\":%d,\"outputs\":%d,\"defaultInput\":%s,\"defaultOutput\":%s}",info->maxInputChannels,info->maxOutputChannels,i==Pa_GetDefaultInputDevice()?"true":"false",i==Pa_GetDefaultOutputDevice()?"true":"false"); }
        else { fprintf(out,"%d  ",i); print_name(out,info->name); fprintf(out,"  input:%d output:%d%s%s\n",info->maxInputChannels,info->maxOutputChannels,i==Pa_GetDefaultInputDevice()?" [default input]":"",i==Pa_GetDefaultOutputDevice()?" [default output]":""); }
    }
    if (json) fputs("]\n",out);
    if (!json && count==0) fputs("No audio devices are available.\n",out);
    Pa_Terminate(); return count>=0 && !ferror(out);
}
ts_audio *ts_audio_open(int input, int output, int profile, char *error, size_t cap) {
    ts_audio *a=NULL; PaStreamParameters in={0},out={0}; const PaDeviceInfo *in_info,*out_info; PaError result;
    if (!ts_audio_profile_valid(profile)) { snprintf(error,cap,"Choose a supported audio profile."); return NULL; }
    result=Pa_Initialize(); if (result!=paNoError) { snprintf(error,cap,"Cannot initialize audio: %s",Pa_GetErrorText(result)); return NULL; }
    if (input<0) input=Pa_GetDefaultInputDevice();
    if (output<0) output=Pa_GetDefaultOutputDevice();
    in_info=Pa_GetDeviceInfo(input); out_info=Pa_GetDeviceInfo(output);
    if (!in_info || !out_info || in_info->maxInputChannels<1 || out_info->maxOutputChannels<1) { snprintf(error,cap,"Choose an available microphone and speaker; use 'toneseal devices'."); goto failed; }
    a=calloc(1,sizeof(*a)); if (!a) goto failed;
    atomic_init(&a->written,0); atomic_init(&a->read,0); atomic_init(&a->dropped,0);
    atomic_init(&a->overflows,0); atomic_init(&a->underflows,0);
    atomic_init(&a->transmit_at,0); atomic_init(&a->transmitting,0);
    if (!atomic_is_lock_free(&a->written) || !atomic_is_lock_free(&a->transmit_at) || !atomic_is_lock_free(&a->transmitting)) {
        snprintf(error,cap,"This audio backend requires lock-free native atomics."); goto failed;
    }
    a->ring=calloc(RING_SIZE,sizeof(float)); if (!a->ring) goto failed;
    a->audio_profile=profile;
    in.device=input; in.channelCount=1; in.sampleFormat=paFloat32; in.suggestedLatency=in_info->defaultLowInputLatency;
    out.device=output; out.channelCount=out_info->maxOutputChannels>=2?2:1; out.sampleFormat=paFloat32; out.suggestedLatency=out_info->defaultLowOutputLatency;
    a->rate=48000;
    if (Pa_IsFormatSupported(&in,&out,a->rate)!=paFormatIsSupported) {
        a->rate=44100;
        if (Pa_IsFormatSupported(&in,&out,a->rate)!=paFormatIsSupported) {
            out.channelCount=1; a->rate=48000;
            if (Pa_IsFormatSupported(&in,&out,a->rate)!=paFormatIsSupported) { a->rate=44100; if (Pa_IsFormatSupported(&in,&out,a->rate)!=paFormatIsSupported) { snprintf(error,cap,"Audio devices must support 44.1 or 48 kHz together."); goto failed; } }
        }
    }
    a->output_channels=out.channelCount;
    result=Pa_OpenStream(&a->stream,&in,&out,a->rate,paFramesPerBufferUnspecified,paClipOff,callback,a);
    if (result!=paNoError) { snprintf(error,cap,"Cannot open audio; check microphone permission/devices: %s",Pa_GetErrorText(result)); goto failed; }
    a->output_latency=Pa_GetStreamInfo(a->stream)->outputLatency;
    result=Pa_StartStream(a->stream);
    if (result!=paNoError) { snprintf(error,cap,"Cannot start audio: %s",Pa_GetErrorText(result)); goto failed; }
    return a;
failed:
    if (a) { if (a->stream) Pa_CloseStream(a->stream); free(a->ring); free(a); }
    Pa_Terminate(); if (!error[0]) snprintf(error,cap,"Cannot allocate audio buffers."); return NULL;
}
size_t ts_audio_read(ts_audio *a, int16_t *out, size_t cap) {
    uint64_t read_at=atomic_load_explicit(&a->read,memory_order_relaxed),write_at=atomic_load_explicit(&a->written,memory_order_acquire);
    size_t count=(size_t)(write_at-read_at),i;
    if (count>cap) count=cap;
    if (count) a->input_peak=0;
    for (i=0;i<count;++i) {
        float value=a->ring[(read_at+i)&(RING_SIZE-1)];
        if (!isfinite(value)) value=0;
        if (fabs(value)>a->input_peak) a->input_peak=fabs(value);
        if (value>32767.0/32768 || value< -1) a->clipped++;
        out[i]=value>=32767.0/32768?32767:value<= -1?-32768:(int16_t)floor(value*32768.0+0.5);
    }
    atomic_store_explicit(&a->read,read_at+count,memory_order_release); return count;
}
void ts_audio_discard(ts_audio *a) {
    atomic_store_explicit(&a->read,atomic_load_explicit(&a->written,memory_order_acquire),memory_order_release);
}
int ts_audio_active(ts_audio *a) { return Pa_IsStreamActive(a->stream)==1; }
void ts_audio_metrics(ts_audio *a, ts_audio_stats *out) {
    out->dropped_samples=atomic_load_explicit(&a->dropped,memory_order_relaxed);
    out->overflows=atomic_load_explicit(&a->overflows,memory_order_relaxed); out->underflows=atomic_load_explicit(&a->underflows,memory_order_relaxed);
    out->clipped=a->clipped; out->input_peak=a->input_peak; out->rate=a->rate;
}
int ts_audio_send(ts_audio *a, const ts_packet *packet, volatile sig_atomic_t *cancel, char *error, size_t cap) {
    ts_pcm *pcm=NULL,physical={0}; size_t i; int ok=0; double deadline;
    for (i=0;i<4;++i) if (a->cache[i].packet.len==packet->len && !memcmp(a->cache[i].packet.bytes,packet->bytes,packet->len)) pcm=&a->cache[i].pcm;
    if (!pcm) {
        size_t slot=a->cache_next++%4;
        ts_pcm_free(&a->cache[slot].pcm);
        if (!ts_modem_render_profile(packet,a->audio_profile,&a->cache[slot].pcm,cancel,error,cap)) return 0;
        a->cache[slot].packet=*packet; pcm=&a->cache[slot].pcm;
    }
    if (!ts_pcm_profile(pcm,a->rate,a->audio_profile,&physical)) { snprintf(error,cap,"Cannot prepare playback sample rate."); return 0; }
    a->transmit=malloc(physical.frames*sizeof(float));
    if (!a->transmit) { ts_pcm_free(&physical); snprintf(error,cap,"Cannot allocate playback buffer."); return 0; }
    for (i=0;i<physical.frames;++i) a->transmit[i]=physical.samples[i]/32768.0f;
    a->transmit_frames=physical.frames; ts_pcm_free(&physical); ts_audio_discard(a);
    atomic_store_explicit(&a->transmit_at,0,memory_order_relaxed);
    atomic_store_explicit(&a->transmitting,1,memory_order_release);
    deadline=ts_clock_ms()+a->transmit_frames*1000.0/a->rate+5000;
    while (atomic_load_explicit(&a->transmitting,memory_order_acquire)) {
        if ((cancel && *cancel) || !ts_audio_active(a) || ts_clock_ms()>deadline) goto done;
        pause_ms(4);
    }
    deadline=ts_clock_ms()+350+a->output_latency*1000;
    while (ts_clock_ms()<deadline) { if (cancel && *cancel) goto done; pause_ms(4); }
    ok=1;
done:
    if (!ok) { Pa_AbortStream(a->stream); atomic_store_explicit(&a->transmitting,0,memory_order_release); snprintf(error,cap,"Playback was cancelled, interrupted or timed out."); }
    OPENSSL_clear_free(a->transmit,a->transmit_frames*sizeof(float)); a->transmit=NULL; a->transmit_frames=0;
    ts_audio_discard(a); return ok;
}
void ts_audio_close(ts_audio *a) {
    size_t i;
    if (!a) return;
    Pa_AbortStream(a->stream); Pa_CloseStream(a->stream);
    for (i=0;i<4;++i) ts_pcm_free(&a->cache[i].pcm);
    OPENSSL_clear_free(a->ring,RING_SIZE*sizeof(float)); free(a->transmit); OPENSSL_clear_free(a,sizeof(*a)); Pa_Terminate();
}
