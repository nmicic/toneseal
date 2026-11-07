/* Copyright (c) 2026 Nenad Micic */
/* SPDX-License-Identifier: Apache-2.0 */
/* One fixed receiver per isolated Worker instance. No audio/synth code here. */
#include "portable_core.h"
#include <string.h>
#define MAX_SAMPLES (48000u*20u)
#define MAX_MESSAGES 8u
static ac_receiver receiver;
static int16_t input[4096];
static ac_event messages[MAX_MESSAGES];
static uint32_t count, samples;
static int status;
static int receive(void *context,const ac_event *event)
{ (void)context;if(count==MAX_MESSAGES)return 1;messages[count++]=*event;return 0; }
void acoustic_reset(void)
{ count=0;samples=0;status=0;memset(messages,0,sizeof(messages));ac_init(&receiver,receive,0); }
int16_t *acoustic_input(void){return input;}
int acoustic_feed(uint32_t length)
{ if(status)return status;if(length>4096 || length>MAX_SAMPLES-samples)return status=1;samples+=length;return status=ac_feed(&receiver,input,length); }
int acoustic_finish(void){return status?status:(status=ac_finish(&receiver));}
uint32_t acoustic_count(void){return count;}
const uint8_t *acoustic_payload(uint32_t index){return index<count?messages[index].payload:0;}
uint32_t acoustic_length(uint32_t index){return index<count?messages[index].payload_bytes:0;}
uint32_t acoustic_sender(uint32_t index){return index<count?messages[index].sender:0;}
uint32_t acoustic_onset(uint32_t index){return index<count?(uint32_t)messages[index].onset:0;}
uint32_t acoustic_corrected(uint32_t index){return index<count?messages[index].corrected_nibbles:0;}
uint32_t acoustic_numeric_errors(void){return (uint32_t)receiver.counters.numeric_refusals;}
uint32_t acoustic_crc_failures(void){return (uint32_t)receiver.counters.crc_failures;}
uint32_t acoustic_invalid_headers(void){return (uint32_t)receiver.counters.invalid_headers;}
uint32_t acoustic_invalid_payloads(void){return (uint32_t)receiver.counters.invalid_payloads;}
uint32_t acoustic_state_bytes(void){return (uint32_t)sizeof(receiver);}
