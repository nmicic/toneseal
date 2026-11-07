/* Copyright (c) 2026 Nenad Micic */
/* SPDX-License-Identifier: Apache-2.0 */
/* Fixed-memory experimental receiver. Numerical policy and limits: README.md. */
#include "portable_core.h"
#include <limits.h>
#include <string.h>
#include "portable_tables.h"

#define AC_BOUND INT64_C(536870928)
#define AC_THRESHOLD UINT32_C(655360)
static const uint8_t ac_radix[8] = {2,2,2,2,2,2,3,5};
static const int8_t ac_offsets[5] = {0,-12,12,-24,24};
static const uint8_t gf_exp[15] = {1,2,4,8,3,6,12,11,5,10,7,14,15,13,9};
static const uint8_t gf_inv[16] = {0,1,9,14,13,11,7,6,15,2,12,5,10,4,3,8};
typedef char ac_width_check[(sizeof(int16_t)==2 && sizeof(int32_t)==4 && sizeof(int64_t)==8) ? 1 : -1];

static uint8_t gf_mul(uint8_t a, uint8_t b)
{
    uint8_t result = 0;
    unsigned i;
    for (i=0; i<4; ++i) {
        if (b & 1u) result ^= a;
        b = (uint8_t)(b >> 1);
        a = (uint8_t)((unsigned)a << 1);
        if (a & 16u) a ^= 19u;
    }
    return result;
}

static int32_t rounded(int64_t value, int64_t denominator, int *bad)
{
    int64_t result;
    value = value >= 0 ? value + denominator/2 : value - denominator/2;
    result = value / denominator;
    if (result < -AC_BOUND || result > AC_BOUND) { *bad=1; return 0; }
    return (int32_t)result;
}

static void fft_work(ac_complex *out, const int16_t *input, unsigned stride,
                     unsigned count, unsigned stage, int *bad)
{
    ac_complex saved[5];
    unsigned radix, part, j, k, q;
    if (count==1) {
        out[0].re=(int32_t)input[0] * INT32_C(16384);
        out[0].im=0;
        return;
    }
    radix=ac_radix[stage]; part=count/radix;
    for (j=0; j<radix; ++j)
        fft_work(out+j*part, input+j*stride, stride*radix, part, stage+1, bad);
    for (k=0; k<part; ++k) {
        for (j=0; j<radix; ++j) saved[j]=out[k+j*part];
        for (q=0; q<radix; ++q) {
            int64_t real=0, imaginary=0;
            for (j=0; j<radix; ++j) {
                unsigned index=(j*(k+q*part)*stride)%960u;
                int32_t cosine=ac_cosine[index];
                int32_t sine=ac_cosine[(index+720u)%960u];
                real += (int64_t)saved[j].re*cosine + (int64_t)saved[j].im*sine;
                imaginary += (int64_t)saved[j].im*cosine - (int64_t)saved[j].re*sine;
            }
            out[k+q*part].re=rounded(real, (int64_t)radix*INT64_C(1073741824), bad);
            out[k+q*part].im=rounded(imaginary, (int64_t)radix*INT64_C(1073741824), bad);
        }
    }
}

static uint32_t ratio_q16(uint64_t numerator, uint64_t denominator)
{
    uint32_t result=0;
    unsigned i;
    if (!denominator) return 0;
    if (numerator==denominator) return 65536u;
    for (i=0; i<16; ++i) {
        result <<= 1;
        if (numerator >= denominator-numerator) {
            numerator -= denominator-numerator;
            result |= 1u;
        } else numerator *= 2u;
    }
    return result;
}

int ac_features(ac_workspace *work, const int16_t input[AC_WINDOW])
{
    unsigned i, band;
    work->bad=0;
    fft_work(work->fft, input, 1, 960, 0, &work->bad);
    if (work->bad) return 2;
    for (i=0; i<64; ++i) {
        int64_t real=work->fft[i+12].re, imaginary=work->fft[i+12].im;
        work->power[i]=(uint64_t)(real*real)+(uint64_t)(imaginary*imaginary);
        if (work->power[i] > (uint64_t)(AC_BOUND*AC_BOUND)) { work->bad=1; return 2; }
    }
    for (band=0; band<4; ++band) {
        uint64_t sum=0;
        for (i=0; i<16; ++i) {
            uint64_t value=work->power[16*band+i];
            if (UINT64_MAX-sum < value) { work->bad=1; return 2; }
            sum += value;
        }
        for (i=0; i<16; ++i)
            work->normalized[16*band+i]=ratio_q16(work->power[16*band+i],sum);
    }
    return 0;
}

uint8_t ac_symbol(const uint32_t normalized[64], uint8_t *tie, uint32_t *margin)
{
    uint32_t best=0, second=0;
    unsigned value, winner=0;
    *tie=0;
    for (value=0; value<256; ++value) {
        uint32_t score=normalized[ac_glyphs[value][0]]+normalized[ac_glyphs[value][1]]+
            normalized[ac_glyphs[value][2]]+normalized[ac_glyphs[value][3]];
        if (value==0 || score>best) {
            second=best; best=score; winner=value; *tie=0;
        } else if (score==best) { second=best; *tie=1; }
        else if (score>second) second=score;
    }
    *margin=best-second;
    return (uint8_t)winner;
}

static void syndromes(const uint8_t word[15], uint8_t out[4])
{
    unsigned j, i;
    for (j=0; j<4; ++j) {
        uint8_t value=0;
        for (i=0; i<15; ++i) value=gf_mul(value,gf_exp[j+1])^word[i];
        out[j]=value;
    }
}

int ac_rs_decode(const uint8_t word[15], uint8_t data[11], uint16_t *positions_mask)
{
    uint8_t s[4], locator[5]={1,0,0,0,0}, prior[5]={1,0,0,0,0};
    uint8_t saved[5], corrected[15], positions[2], magnitudes[2];
    uint8_t old=1;
    unsigned degree=0, gap=1, n, i, roots=0;
    *positions_mask=0;
    for (i=0; i<15; ++i) if (word[i]>15) return 0;
    syndromes(word,s);
    if (!(s[0]|s[1]|s[2]|s[3])) { memcpy(data,word,11); return 1; }
    for (n=0; n<4; ++n) {
        uint8_t discrepancy=s[n], scale;
        for (i=1; i<=degree; ++i) discrepancy ^= gf_mul(locator[i],s[n-i]);
        if (!discrepancy) { ++gap; continue; }
        memcpy(saved,locator,5);
        scale=gf_mul(discrepancy,gf_inv[old]);
        for (i=0; i+gap<5; ++i) locator[i+gap] ^= gf_mul(scale,prior[i]);
        if (2*degree<=n) {
            degree=n+1-degree; memcpy(prior,saved,5); old=discrepancy; gap=1;
        } else ++gap;
    }
    if (degree<1 || degree>2) return 0;
    for (n=0; n<15; ++n) {
        uint8_t x=gf_exp[(n+1)%15], value=0;
        for (i=degree+1; i>0; --i) value=gf_mul(value,x)^locator[i-1];
        if (!value) {
            if (roots==2) return 0;
            positions[roots++]=(uint8_t)n;
        }
    }
    if (roots!=degree) return 0;
    if (degree==1) magnitudes[0]=gf_mul(s[0],gf_inv[gf_exp[14-positions[0]]]);
    else {
        uint8_t x=gf_exp[14-positions[0]], y=gf_exp[14-positions[1]];
        uint8_t a=gf_mul(s[1]^gf_mul(s[0],y),gf_inv[x^y]);
        magnitudes[0]=gf_mul(a,gf_inv[x]);
        magnitudes[1]=gf_mul(s[0]^a,gf_inv[y]);
    }
    memcpy(corrected,word,15);
    for (i=0; i<degree; ++i) {
        if (!magnitudes[i]) return 0;
        corrected[positions[i]] ^= magnitudes[i];
        *positions_mask |= (uint16_t)(1u<<positions[i]);
    }
    syndromes(corrected,s);
    if (s[0]|s[1]|s[2]|s[3]) return 0;
    memcpy(data,corrected,11);
    return 1;
}

static uint16_t crc_bytes(const uint8_t *bytes, unsigned count, unsigned width,
                          uint16_t polynomial, uint16_t initial)
{
    uint32_t value=initial, top=1u<<(width-1), mask=(1u<<width)-1u;
    unsigned i,j;
    for (i=0; i<count; ++i) {
        value ^= (uint32_t)bytes[i]<<(width-8);
        for (j=0; j<8; ++j) value=((value<<1)^((value&top)?polynomial:0u))&mask;
    }
    return (uint16_t)value;
}

static int header_one(const uint8_t bytes[8], uint8_t header[11], uint16_t *length,
                       uint16_t *sender, uint16_t *blocks)
{
    uint8_t nibbles[15], packed[5];
    uint16_t mask;
    unsigned i, nibble_length;
    for (i=0; i<15; ++i) nibbles[i]=(uint8_t)((bytes[i/2]>>(i%2?0:4))&15u);
    if (!ac_rs_decode(nibbles,header,&mask)) return 0;
    nibble_length=((unsigned)header[0]<<8)|((unsigned)header[1]<<4)|header[2];
    if (header[3] || header[10] || (nibble_length&1u) || nibble_length>4094u) return 0;
    for (i=0; i<4; ++i) packed[i]=(uint8_t)((header[2*i]<<4)|header[2*i+1]);
    packed[4]=(uint8_t)(header[10]<<4);
    if (crc_bytes(packed,5,8,7,0)!=((unsigned)header[8]<<4|header[9])) return 0;
    *length=(uint16_t)(nibble_length/2);
    *sender=(uint16_t)((header[4]<<12)|(header[5]<<8)|(header[6]<<4)|header[7]);
    *blocks=(uint16_t)((nibble_length+14)/11);
    return 1;
}

int ac_header(const uint8_t values[24], uint16_t *length, uint16_t *sender, uint16_t *count)
{
    uint8_t first[11], second[11];
    uint16_t l1=0,l2=0,s1=0,s2=0,b1=0,b2=0,blocks;
    int a=header_one(values,first,&l1,&s1,&b1), b=header_one(values+16,second,&l2,&s2,&b2);
    if (!a && !b) return 0;
    if (a && b && memcmp(first,second,11)) return 0;
    *length=a?l1:l2; *sender=a?s1:s2; blocks=a?b1:b2;
    *count=(uint16_t)(16+(15*blocks+1)/2);
    return *length>128 || *count>196 ? -1 : 1;
}

static uint8_t body_nibble(const uint8_t *values, unsigned n)
{
    unsigned byte=n/2, position=byte<8?8+byte:24+byte-8;
    return (uint8_t)((values[position]>>(n%2?0:4))&15u);
}

static int frame_checked(const uint8_t *values, uint16_t count, ac_event *event,
                         unsigned *crc_failed)
{
    uint16_t length,sender,expected,mask;
    uint8_t decoded[264], word[15], data[11];
    unsigned blocks,block,i,needed,trailer;
    if (count<24 || ac_header(values,&length,&sender,&expected)!=1 || count<expected) return 0;
    blocks=(2u*length+14)/11; needed=2u*length+4;
    event->corrected_nibbles=0;
    for (block=0; block<blocks; ++block) {
        for (i=0; i<15; ++i) word[i]=body_nibble(values,i*blocks+block);
        if (!ac_rs_decode(word,data,&mask)) return 0;
        for (i=0; i<15; ++i) event->corrected_nibbles+=(uint16_t)((mask>>i)&1u);
        memcpy(decoded+block*11,data,11);
    }
    for (i=needed; i<11*blocks; ++i) if (decoded[i]) return 0;
    for (i=0; i<length; ++i) event->payload[i]=(uint8_t)((decoded[2*i]<<4)|decoded[2*i+1]);
    trailer=((unsigned)decoded[2*length]<<12)|((unsigned)decoded[2*length+1]<<8)|
        ((unsigned)decoded[2*length+2]<<4)|decoded[2*length+3];
    if (crc_bytes(event->payload,length,16,0x1021,0xffff)!=trailer) {
        if (crc_failed) *crc_failed=1;
        return 0;
    }
    event->payload_bytes=length; event->sender=sender; event->physical_glyphs=expected;
    event->ignored_padding=(uint8_t)(((values[7]&15u)!=0)+((values[23]&15u)!=0));
    if ((15*blocks)&1u) event->ignored_padding+=(uint8_t)(body_nibble(values,15*blocks)!=0);
    return 1;
}

int ac_frame(const uint8_t *values, uint16_t count, ac_event *event)
{
    return frame_checked(values,count,event,NULL);
}

static void remove_group(ac_receiver *r, unsigned index)
{
    if (index+1<r->group_count)
        memmove(r->groups+index,r->groups+index+1,(r->group_count-index-1)*sizeof(r->groups[0]));
    --r->group_count;
}

void ac_admit(ac_receiver *r, uint64_t onset, uint32_t score)
{
    unsigned i,worst=0,total=0;
    ac_candidate *group;
    if (onset<r->accepted_through) { ++r->counters.suppressed_candidates; return; }
    if (r->group_count==8) {
        for (i=1; i<8; ++i)
            if (r->groups[i].score<r->groups[worst].score ||
                (r->groups[i].score==r->groups[worst].score && r->groups[i].onset>r->groups[worst].onset)) worst=i;
        if (score<r->groups[worst].score || (score==r->groups[worst].score && onset>=r->groups[worst].onset)) {
            ++r->counters.dropped_new_candidates; return;
        }
        remove_group(r,worst); ++r->counters.evicted_candidates;
    }
    group=r->groups+r->group_count++;
    memset(group,0,sizeof(*group)); group->onset=onset; group->score=score;
    for (i=0; i<5; ++i) {
        ac_hypothesis *h=group->hypotheses+i;
        if (ac_offsets[i]<0 && onset<(unsigned)(-ac_offsets[i])) continue;
        h->onset=ac_offsets[i]<0?onset-(unsigned)(-ac_offsets[i]):onset+(unsigned)ac_offsets[i];
        h->minimum_margin=UINT32_MAX; h->active=1; ++group->count;
    }
    ++r->counters.admitted_candidates;
    if (r->group_count>r->counters.max_candidate_groups) r->counters.max_candidate_groups=r->group_count;
    for (i=0; i<r->group_count; ++i) total+=r->groups[i].count;
    if (total>r->counters.max_hypotheses) r->counters.max_hypotheses=total;
}

static void score_local(ac_receiver *r, int64_t index, uint32_t score)
{
    unsigned i,winner=0;
    if (r->local_count==13) {
        memmove(r->local_scores,r->local_scores+1,12*sizeof(uint32_t));
        memmove(r->local_indices,r->local_indices+1,12*sizeof(int64_t));
        --r->local_count;
    }
    r->local_scores[r->local_count]=score; r->local_indices[r->local_count++]=index;
    if (r->local_count<13) return;
    for (i=1; i<13; ++i)
        if (r->local_scores[i]>r->local_scores[winner] ||
            (r->local_scores[i]==r->local_scores[winner] && r->local_indices[i]<r->local_indices[winner])) winner=i;
    if (winner==6 && r->local_indices[6]>=0 && r->local_scores[6]>=AC_THRESHOLD) {
        ++r->counters.local_candidates;
        ac_admit(r,(uint64_t)r->local_indices[6]*48,r->local_scores[6]);
    }
}

static int acquisition_process(ac_receiver *r, unsigned count)
{
    unsigned n,j,k,remaining;
    for (n=0; n<count; ++n) {
        uint64_t current=r->windows, start;
        uint32_t score=0;
        if (ac_features(&r->workspace,r->acquisition+n*48)) return 2;
        for (j=0; j<8; ++j) {
            uint32_t projection=0;
            for (k=0; k<4; ++k) projection+=r->workspace.normalized[ac_glyphs[ac_preamble[j]][k]];
            r->projections[current%141][j]=projection;
        }
        ++r->windows;
        if (current<140) continue;
        start=current-140;
        for (j=0; j<8; ++j) score+=r->projections[(start+j*20)%141][j];
        if (score>r->maximum_riff_score) r->maximum_riff_score=score;
        ++r->scores; score_local(r,(int64_t)start,score);
    }
    remaining=r->acquisition_count-count*48;
    memmove(r->acquisition,r->acquisition+count*48,remaining*sizeof(int16_t));
    r->acquisition_count=(uint16_t)remaining;
    return 0;
}

static int advance(ac_receiver *r)
{
    struct ready_item { uint64_t group,onset; uint32_t margin; uint8_t symbol,tie; } ready[40];
    unsigned used=0,g,h,i,j;
    for (g=0; g<r->group_count; ++g) {
        ac_candidate *group=r->groups+g;
        for (h=0; h<5; ++h) {
            ac_hypothesis *hypothesis=group->hypotheses+h;
            uint64_t start,age;
            if (!hypothesis->active) continue;
            start=hypothesis->onset+(8u+hypothesis->count)*UINT64_C(960);
            if (start+960>r->samples) continue;
            age=r->samples-start;
            if (age>r->counters.max_oldest_window_age) r->counters.max_oldest_window_age=age;
            if (age>4096) {
                ++r->counters.ring_overruns; hypothesis->active=0; --group->count; continue;
            }
            for (i=0; i<960; ++i) r->window[i]=r->ring[(start+i)%4096];
            if (ac_features(&r->workspace,r->window)) return 2;
            ready[used].group=group->onset; ready[used].onset=hypothesis->onset;
            ready[used].symbol=ac_symbol(r->workspace.normalized,&ready[used].tie,&ready[used].margin);
            ++used;
        }
    }
    r->counters.demodulated_windows+=used;
    if (used>r->counters.max_demod_batch) r->counters.max_demod_batch=used;
    for (i=0; i<used; ++i) {
        ac_candidate *group=NULL;
        ac_hypothesis *hypothesis=NULL;
        for (g=0; g<r->group_count; ++g) if (r->groups[g].onset==ready[i].group) { group=r->groups+g; break; }
        if (!group) continue;
        for (h=0; h<5; ++h)
            if (group->hypotheses[h].active && group->hypotheses[h].onset==ready[i].onset) { hypothesis=group->hypotheses+h; break; }
        if (!hypothesis) continue;
        if (hypothesis->count>=196) return 2;
        hypothesis->values[hypothesis->count++]=ready[i].symbol;
        hypothesis->ties+=ready[i].tie;
        if (ready[i].margin<hypothesis->minimum_margin) hypothesis->minimum_margin=ready[i].margin;
        if (hypothesis->count>r->counters.max_retained_glyphs) r->counters.max_retained_glyphs=hypothesis->count;
        if (hypothesis->count==24) {
            uint16_t length,sender,target;
            int status=ac_header(hypothesis->values,&length,&sender,&target);
            if (status!=1) {
                if (status<0) ++r->counters.oversize_headers; else ++r->counters.invalid_headers;
                hypothesis->active=0; --group->count; continue;
            }
            hypothesis->target=target;
        }
        if (hypothesis->target && hypothesis->count==hypothesis->target) {
            ac_event event;
            unsigned crc_failed=0;
            memset(&event,0,sizeof(event));
            if (!frame_checked(hypothesis->values,hypothesis->count,&event,&crc_failed)) {
                r->counters.crc_failures+=crc_failed;
                ++r->counters.invalid_payloads; hypothesis->active=0; --group->count; continue;
            }
            event.onset=hypothesis->onset; event.data_end=event.onset+(8u+hypothesis->target)*UINT64_C(960);
            event.logical_sample=r->samples; event.delivered_sample=r->delivery_sample;
            event.riff_score=group->score; event.minimum_margin=hypothesis->minimum_margin;
            event.ties=hypothesis->ties; event.at_eof=r->finishing;
            if (event.data_end>r->accepted_through) r->accepted_through=event.data_end;
            for (j=0; j<r->group_count; ) {
                if (r->groups[j].onset<r->accepted_through) remove_group(r,j); else ++j;
            }
            ++r->counters.packets; r->counters.eof_packets+=r->finishing;
            if (r->callback && r->callback(r->callback_context,&event)) return 3;
        }
    }
    for (g=0; g<r->group_count; ) {
        if (!r->groups[g].count) remove_group(r,g); else ++g;
    }
    return 0;
}

static int consume(ac_receiver *r, const int16_t *input, unsigned count)
{
    unsigned i;
    int status;
    for (i=0; i<count; ++i) r->ring[(r->samples+i)%4096]=input[i];
    r->samples+=count;
    memcpy(r->acquisition+r->acquisition_count,input,count*sizeof(int16_t));
    r->acquisition_count=(uint16_t)(r->acquisition_count+count);
    if (r->acquisition_count==2448) {
        status=acquisition_process(r,32);
        if (status) return status;
    }
    return advance(r);
}

void ac_init(ac_receiver *r, ac_callback callback, void *context)
{
    unsigned i;
    memset(r,0,sizeof(*r)); r->callback=callback; r->callback_context=context;
    r->local_count=6;
    for (i=0; i<6; ++i) r->local_indices[i]=(int64_t)i-6;
}

static int fail(ac_receiver *r, int status)
{
    ++r->counters.operation_errors;
    if (status==2) ++r->counters.numeric_refusals;
    r->closed=1; r->busy=0; r->group_count=0;
    return status;
}

int ac_feed(ac_receiver *r, const int16_t *input, size_t count)
{
    size_t cursor=0;
    if (r->busy) { ++r->counters.reentrant_calls; return 1; }
    if (r->closed) return 1;
    r->busy=1;
    if ((!input && count) || count>AC_LIMIT-r->input_samples) return fail(r,1);
    r->delivery_sample=r->input_samples+(uint64_t)count;
    while (cursor<count) {
        size_t take=48u-r->quantum_count;
        int status;
        if (take>count-cursor) take=count-cursor;
        memcpy(r->quantum+r->quantum_count,input+cursor,take*sizeof(int16_t));
        r->quantum_count=(uint16_t)(r->quantum_count+take);
        r->input_samples+=(uint64_t)take; cursor+=take;
        if (r->quantum_count==48) {
            status=consume(r,r->quantum,48);
            if (status) return fail(r,status);
            r->quantum_count=0;
        }
    }
    r->busy=0;
    return 0;
}

int ac_finish(ac_receiver *r)
{
    unsigned i;
    int status;
    if (r->busy) { ++r->counters.reentrant_calls; return 1; }
    if (r->closed) return 1;
    r->busy=1; r->finishing=1; r->delivery_sample=r->input_samples;
    if (r->quantum_count) {
        status=consume(r,r->quantum,r->quantum_count);
        if (status) return fail(r,status);
        r->quantum_count=0;
    }
    if (r->acquisition_count>=960) {
        status=acquisition_process(r,(r->acquisition_count-960)/48+1);
        if (status) return fail(r,status);
    }
    status=advance(r);
    if (status) return fail(r,status);
    r->counters.groups_at_eof=r->group_count;
    for (i=0; i<r->group_count; ++i) r->counters.pending_at_eof+=r->groups[i].count;
    r->group_count=0; r->closed=1; r->busy=0;
    return 0;
}
