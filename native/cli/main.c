/* Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0 */
#include "audio.h"
#include "transfer.h"
#include <openssl/crypto.h>
#include <errno.h>
#include <fcntl.h>
#include <getopt.h>
#include <math.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t stop_signal;
static void stopped(int signal_number) { stop_signal=signal_number; }
enum { FILE_NONE, FILE_TO_WAV, FILE_FROM_WAV, FILE_TO_TL, FILE_FROM_TL };
typedef struct {
    const char *command,*input,*output; int json,single,send,profile,crypto,verify,mode,input_device,output_device,packets,control_stdin;
    unsigned timeout,rate,duration; int file;
} options;
typedef struct {
    options options; ts_transfer *transfer;
    int output_fd,output_created,output_written,io_error;
    uint8_t secret[96]; size_t secret_len; double secret_expiry;
    ts_packet packets[8]; size_t packet_head,packet_count;
    unsigned received;
} context;

static void quote(FILE *f, const uint8_t *p, size_t n) {
    size_t i; fputc('"',f);
    for (i=0;i<n;++i) {
        unsigned c=p[i];
        if (c=='"' || c=='\\') { fputc('\\',f); fputc((int)c,f); }
        else if (c<32 || c==127) fprintf(f,"\\u%04x",c);
        else fputc((int)c,f);
    }
    fputc('"',f);
}
static void terminal(FILE *f, const uint8_t *p, size_t n) {
    size_t i;
    for (i=0;i<n;++i) { if (p[i]<32 || p[i]==127) fprintf(f,"\\x%02x",p[i]); else fputc(p[i],f); }
}
static int write_bytes(int fd, const uint8_t *p, size_t n) {
    double deadline=ts_clock_ms()+2000;
    while (n && !stop_signal) {
        struct pollfd pollfd={fd,POLLOUT,0}; ssize_t wrote;
        if (ts_clock_ms()>deadline) return 0;
        if (poll(&pollfd,1,100)<=0) continue;
        wrote=write(fd,p,n);
        if (wrote<0 && (errno==EINTR || errno==EAGAIN)) continue;
        if (wrote<=0) return 0;
        p+=wrote; n-=(size_t)wrote;
    }
    return !n;
}
static const char *profile_id(int profile) {
    return profile==TS_AUDIO_ULTRASONIC?"ultrasonic":profile==TS_AUDIO_TELEPHONE?"telephone":"nearby";
}
static void help(void) {
    puts("ToneSeal 0.1.0 experimental beta — native C audio client\n"
         "\nUsage: toneseal COMMAND [options]\n"
         "  send          Send one item, obtain its receipt, then close\n"
         "  receive       Receive one item; repair its receipt/close\n"
         "  chat          Bidirectional Message chat; add --send to initiate\n"
         "  text          ToneSeal text conversions: to-tl/from-tl/to-wav/from-wav\n"
         "  encode        Encode cleartext DATA into a verified synth WAV\n"
         "  decode        Decode a cleartext WAV, or inspect opaque packets\n"
         "  devices       List PortAudio input/output device IDs\n"
         "  audio-probe   Check capture levels without saving audio\n"
         "  capabilities  Print the machine-readable command/limit manifest\n"
         "\nOptions:\n"
         "  --mode message|password|clear  (default message)\n"
         "  --profile nearby|telephone|ultrasonic  (default nearby; others experimental)\n"
         "  --crypto p256|x25519          (default p256; no fallback)\n"
         "  --verify                     Compare every fingerprint group, then /confirm\n"
         "  --single                     One-shot Message, matching web chat disabled\n"
         "  --input FILE|-               Text from file/stdin; encode/send default stdin\n"
         "  --output FILE|-              Explicit raw export; files must be new (0600)\n"
         "  --input-device ID --output-device ID\n"
         "  --timeout SECONDS            Peer-idle deadline, 1-120 (default 60)\n"
         "  --rate 44100|48000           WAV output rate (default 48000)\n"
         "  --duration SECONDS           Audio probe length, 1-30 (default 2)\n"
         "  --json                       Structured status and message events on stdout\n"
         "  --control-stdin              Explicit local command pipe (e.g. /confirm)\n"
         "  --packets                    Decode diagnostic: opaque packet hex as JSON\n"
         "  --help --version\n"
         "\nMessage defaults to the web app's persistent-chat protocol. send/receive\n"
         "close that chat after one item; chat keeps it open. Password/Clear text\n"
         "are one-shot. Match mode, profile, crypto and Message continuation on peers.\n"
         "\nLocal terminal commands: /confirm, /quit (drain/end chat), /stop, /reveal.\n"
         "Ordinary chat lines send text; /send TEXT sends a literal slash command.\n"
         "Ctrl+C stops immediately. Received text never executes terminal commands.\n"
         "\nPassword receive stays masked unless you explicitly select --output or\n"
         "type /reveal. No clipboard is read/written. Input is never a --text argument.\n"
         "Files/piped input preserve exact UTF-8 bytes, including trailing newlines.\n"
         "Password mode prompts with terminal echo disabled. Maximum: 96 UTF-8 bytes.\n"
         "Simple mode encrypts but does not authenticate the initial peer.\n"
         "--verify requires an independent trusted fingerprint comparison on both sides.");
}
static void text_help(void) {
    puts("Usage: toneseal text ACTION [options]\n"
         "  to-tl     Encode UTF-8 text as a portable ToneSeal sound timeline\n"
         "  from-tl   Render a ToneSeal timeline and recover its text from sound\n"
         "  to-wav    Encode UTF-8 text as a ToneSeal sound WAV\n"
         "  from-wav  Recover ToneSeal text from a WAV recording\n"
         "\n--input FILE|-    Text defaults to stdin; from-tl/from-wav need --input.\n"
         "--output FILE|-   New 0600 output file; to-wav requires a file.\n"
         "                  TL/text default to stdout; redirected text is byte-exact.\n"
         "--json            Metadata/events; to-tl needs an output file in JSON mode.\n"
         "--profile nearby|telephone|ultrasonic  Applies to all four actions.\n"
         "  nearby      Nearby / standard: 600-3750 Hz, faster (default).\n"
         "  telephone   Telephone / phone: 450-2812.5 Hz, slow, experimental.\n"
         "  ultrasonic  Near-ultrasonic: 18.4-19.975 kHz, very slow, experimental.\n"
         "Use the same --profile for encoding and decoding; no automatic detection.\n"
         "--rate 44100|48000  to-wav only (default 48000). TL always uses 48000.\n"
         "Every exported TL starts with # jottune-tl 1 1 (TL / engine requirements).\n"
         "Those versions are the same for all three audio profiles. Legacy TL is read too.\n"
         "\nThese are ToneSeal text-over-sound conversions, 1-96 UTF-8 bytes.\n"
         "They do not interpret arbitrary synth music as text or provide encryption.\n"
         "Files/pipes preserve spaces, newlines and NUL bytes; nothing is trimmed.\n"
         "TTY text is escaped for display; use --output for an exact raw export.");
}
static int number(const char *arg, unsigned min, unsigned max, unsigned *out) {
    char *end; unsigned long n;
    errno=0; n=strtoul(arg,&end,10);
    if (errno || !arg[0] || *end || n<min || n>max) return 0;
    *out=(unsigned)n; return 1;
}
static int parse(int argc, char **argv, options *o) {
    enum { MODE=1000,PROFILE,CRYPTO,VERIFY,SINGLE,INPUT,OUTPUT,INPUT_DEVICE,OUTPUT_DEVICE,TIMEOUT,RATE,DURATION,JSON,PACKETS,SEND,VERSION,CONTROL };
    static const struct option flags[]={
        {"mode",required_argument,NULL,MODE},{"profile",required_argument,NULL,PROFILE},{"crypto",required_argument,NULL,CRYPTO},
        {"verify",no_argument,NULL,VERIFY},{"single",no_argument,NULL,SINGLE},{"input",required_argument,NULL,INPUT},{"output",required_argument,NULL,OUTPUT},
        {"input-device",required_argument,NULL,INPUT_DEVICE},{"output-device",required_argument,NULL,OUTPUT_DEVICE},{"timeout",required_argument,NULL,TIMEOUT},
        {"rate",required_argument,NULL,RATE},{"duration",required_argument,NULL,DURATION},{"json",no_argument,NULL,JSON},
        {"packets",no_argument,NULL,PACKETS},{"send",no_argument,NULL,SEND},{"control-stdin",no_argument,NULL,CONTROL},{"help",no_argument,NULL,'h'},{"version",no_argument,NULL,VERSION},{NULL,0,NULL,0}};
    int flag; unsigned n; uint32_t seen=0,allowed=0;
    memset(o,0,sizeof(*o)); o->input_device=o->output_device=-1; o->timeout=60; o->rate=48000; o->duration=2;
    if (argc<2 || !strcmp(argv[1],"--help") || !strcmp(argv[1],"help")) { help(); return -1; }
    if (!strcmp(argv[1],"--version")) { puts("ToneSeal 0.1.0 experimental beta"); return -1; }
    o->command=argv[1]; optind=2;
    if (!strcmp(o->command,"text")) {
        if (argc<3 || !strcmp(argv[2],"--help") || !strcmp(argv[2],"help")) { text_help(); return -1; }
        if (!strcmp(argv[2],"to-tl")) o->file=FILE_TO_TL;
        else if (!strcmp(argv[2],"from-tl")) o->file=FILE_FROM_TL;
        else if (!strcmp(argv[2],"to-wav")) o->file=FILE_TO_WAV;
        else if (!strcmp(argv[2],"from-wav")) o->file=FILE_FROM_WAV;
        else return 0;
        optind=3;
    } else if (!strcmp(o->command,"encode")) o->file=FILE_TO_WAV;
    else if (!strcmp(o->command,"decode")) o->file=FILE_FROM_WAV;
    if (!o->file && strcmp(o->command,"send") && strcmp(o->command,"receive") && strcmp(o->command,"chat") && strcmp(o->command,"devices") && strcmp(o->command,"audio-probe") && strcmp(o->command,"capabilities")) return 0;
    if (o->file) o->mode=TS_MODE_CLEAR;
    while ((flag=getopt_long(argc,argv,"h",flags,NULL))!=-1) {
        if (flag>=MODE && flag<=CONTROL) seen|=UINT32_C(1)<<(flag-MODE);
        switch (flag) {
        case MODE:
            if (!strcmp(optarg,"message")) o->mode=TS_MODE_MESSAGE;
            else if (!strcmp(optarg,"password")) o->mode=TS_MODE_PASSWORD;
            else if (!strcmp(optarg,"clear")) o->mode=TS_MODE_CLEAR;
            else return 0;
            break;
        case PROFILE: if (!strcmp(optarg,"nearby")) o->profile=TS_AUDIO_NEARBY; else if (!strcmp(optarg,"telephone")) o->profile=TS_AUDIO_TELEPHONE; else if (!strcmp(optarg,"ultrasonic")) o->profile=TS_AUDIO_ULTRASONIC; else return 0; break;
        case CRYPTO: if (!strcmp(optarg,"p256")) o->crypto=TS_P256; else if (!strcmp(optarg,"x25519")) o->crypto=TS_X25519; else return 0; break;
        case VERIFY: o->verify=1; break;
        case SINGLE: o->single=1; break;
        case INPUT: o->input=optarg; break;
        case OUTPUT: o->output=optarg; break;
        case INPUT_DEVICE: if (!number(optarg,0,4096,&n)) return 0; o->input_device=(int)n; break;
        case OUTPUT_DEVICE: if (!number(optarg,0,4096,&n)) return 0; o->output_device=(int)n; break;
        case TIMEOUT: if (!number(optarg,1,120,&o->timeout)) return 0; break;
        case RATE: if (!number(optarg,44100,48000,&o->rate) || (o->rate!=44100 && o->rate!=48000)) return 0; break;
        case DURATION: if (!number(optarg,1,30,&o->duration)) return 0; break;
        case JSON: o->json=1; break;
        case PACKETS: o->packets=1; break;
        case SEND: o->send=1; break;
        case CONTROL: o->control_stdin=1; break;
        case 'h': if (!strcmp(o->command,"text")) text_help(); else help(); return -1;
        case VERSION: puts("ToneSeal 0.1.0 experimental beta"); return -1;
        default: return 0;
        }
    }
    #define BIT(name) (UINT32_C(1)<<((name)-MODE))
    if (o->file==FILE_TO_WAV) allowed=BIT(MODE)|BIT(INPUT)|BIT(OUTPUT)|BIT(PROFILE)|BIT(RATE)|BIT(JSON);
    else if (o->file==FILE_FROM_WAV) allowed=BIT(MODE)|BIT(INPUT)|BIT(OUTPUT)|BIT(PROFILE)|BIT(JSON)|BIT(PACKETS);
    else if (o->file==FILE_TO_TL || o->file==FILE_FROM_TL) allowed=BIT(MODE)|BIT(INPUT)|BIT(OUTPUT)|BIT(JSON)|BIT(PROFILE);
    else if (!strcmp(o->command,"devices") || !strcmp(o->command,"capabilities")) allowed=BIT(JSON);
    else if (!strcmp(o->command,"audio-probe")) allowed=BIT(INPUT_DEVICE)|BIT(OUTPUT_DEVICE)|BIT(DURATION)|BIT(JSON);
    else allowed=BIT(MODE)|BIT(PROFILE)|BIT(CRYPTO)|BIT(VERIFY)|BIT(SINGLE)|BIT(INPUT)|BIT(OUTPUT)|BIT(INPUT_DEVICE)|BIT(OUTPUT_DEVICE)|BIT(TIMEOUT)|BIT(JSON)|BIT(SEND)|BIT(CONTROL);
    if (seen&~allowed) return 0;
    #undef BIT
    if (optind!=argc || (o->json && o->output && !strcmp(o->output,"-")) || (!strcmp(o->command,"chat") && (o->mode!=TS_MODE_MESSAGE || o->single)) ||
        (o->file && o->mode!=TS_MODE_CLEAR) ||
        (o->file==FILE_TO_WAV && (!o->output || !strcmp(o->output,"-"))) ||
        ((o->file==FILE_FROM_WAV || o->file==FILE_FROM_TL) && !o->input) ||
        (o->file==FILE_TO_TL && o->json && !o->output) ||
        (o->send && strcmp(o->command,"chat")) || (o->packets && o->file!=FILE_FROM_WAV) ||
        (o->verify && o->mode==TS_MODE_CLEAR) || (!strcmp(o->command,"receive") && o->input) ||
        (!strcmp(o->command,"chat") && !o->send && o->input) ||
        (o->single && o->mode!=TS_MODE_MESSAGE) ||
        (!strcmp(o->command,"send") && o->control_stdin && (!o->input || !strcmp(o->input,"-")))) return 0;
    return 1;
}
static int read_input(const options *o, uint8_t text[97], size_t *len, int first_line) {
    int fd=STDIN_FILENO,own=0,tty; struct termios before,hidden; int changed=0,ok=0; size_t n=0;
    if (o->input && strcmp(o->input,"-")) { fd=open(o->input,O_RDONLY); if (fd<0) { perror("Input"); return 0; } own=1; }
    tty=isatty(fd);
    if (tty) {
        fprintf(stderr,"Enter %s (maximum 96 UTF-8 bytes): ",o->mode==TS_MODE_PASSWORD?"password":"message");
        if (o->mode==TS_MODE_PASSWORD) {
            if (tcgetattr(fd,&before)==0) { hidden=before; hidden.c_lflag&=(tcflag_t)~(ECHO|ECHONL); changed=tcsetattr(fd,TCSANOW,&hidden)==0; }
            if (!changed) { fputs("Cannot disable terminal echo; use an explicit input file/pipe instead.\n",stderr); if (own) close(fd); return 0; }
        }
    }
    while (!stop_signal && n<97) {
        uint8_t byte; ssize_t got=read(fd,&byte,1);
        if (got<0 && errno==EINTR) continue;
        if (got<0) break;
        if (!got) { ok=1; break; }
        if ((tty || first_line) && byte=='\n') { ok=1; break; }
        text[n++]=byte;
    }
    if (tty && n==97) {
        uint8_t byte;
        while (!stop_signal && read(fd,&byte,1)==1) if (byte=='\n') break;
    }
    if (changed) { tcsetattr(fd,TCSANOW,&before); fputc('\n',stderr); }
    if (own) close(fd);
    if (stop_signal) { OPENSSL_cleanse(text,97); return 0; }
    if (!ok || !n || n>96 || !ts_utf8_valid(text,n)) { fputs("Use 1-96 valid UTF-8 bytes. Input is not trimmed or normalized.\n",stderr); OPENSSL_cleanse(text,97); return 0; }
    *len=n; return 1;
}
static int output_open(context *ctx) {
    const char *path=ctx->options.output; ctx->output_fd=-1;
    if (!path) return 1;
    if (!strcmp(path,"-")) { ctx->output_fd=STDOUT_FILENO; return 1; }
    ctx->output_fd=open(path,O_WRONLY|O_CREAT|O_EXCL,0600);
    if (ctx->output_fd<0) { perror("Create new output"); return 0; }
    ctx->output_created=1; return 1;
}
static void message(void *data, int mode, const uint8_t *text, size_t len, uint32_t counter) {
    context *ctx=data; int exported=0;
    ctx->received++;
    if (ctx->output_fd>=0) {
        if (!write_bytes(ctx->output_fd,text,len) || (ctx->output_created && fsync(ctx->output_fd))) ctx->io_error=1;
        else { ctx->output_written=1; exported=1; }
    }
    if (mode==TS_MODE_PASSWORD && !exported) {
        memcpy(ctx->secret,text,len); ctx->secret_len=len; ctx->secret_expiry=ts_clock_ms()+60000;
    }
    if (ctx->options.json) {
        printf("{\"schemaVersion\":1,\"type\":\"%s\",\"counter\":%u,\"bytes\":%zu,\"exported\":%s",mode==TS_MODE_PASSWORD?"password":"message",counter,len,exported?"true":"false");
        if (mode!=TS_MODE_PASSWORD && !exported) { fputs(",\"text\":",stdout); quote(stdout,text,len); }
        else if (mode==TS_MODE_PASSWORD) fputs(",\"masked\":true",stdout);
        fputs("}\n",stdout);
    } else if (mode==TS_MODE_PASSWORD) {
        fprintf(stderr,"Password received (%zu bytes). %s\n",len,exported?"Written to your explicit output destination.":"Masked; type /reveal locally to display it, or receive with --output.");
    } else if (!exported) {
        if (isatty(STDOUT_FILENO)) { fputs("Peer: ",stdout); terminal(stdout,text,len); fputc('\n',stdout); }
        else if (!write_bytes(STDOUT_FILENO,text,len)) ctx->io_error=1;
    }
    if (fflush(stdout)==EOF || ferror(stdout)) ctx->io_error=1;
}
static void delivery(void *data, uint32_t counter) {
    context *ctx=data;
    if (ctx->options.json) printf("{\"schemaVersion\":1,\"type\":\"delivered\",\"counter\":%u}\n",counter);
    else fprintf(stderr,"Delivered (message %u).\n",counter);
    if (fflush(stdout)==EOF || ferror(stdout)) ctx->io_error=1;
}
static int decoded(void *data, const ac_event *event) {
    context *ctx=data; ts_packet *p;
    if (ctx->packet_count==8) return 1;
    p=&ctx->packets[(ctx->packet_head+ctx->packet_count++)%8]; p->len=event->payload_bytes; memcpy(p->bytes,event->payload,p->len); return 0;
}
static int timeline_output(options *o, const ts_packet *packet, char *error, size_t cap) {
    context ctx={0}; char *timeline=NULL; size_t len=0; int ok=0;
    if (!ts_modem_record_profile(packet,o->profile,&timeline,&len,&stop_signal,error,cap)) return 0;
    ctx.options=*o; if (!ctx.options.output) ctx.options.output="-";
    if (output_open(&ctx) && write_bytes(ctx.output_fd,(const uint8_t *)timeline,len) &&
        (!ctx.output_created || fsync(ctx.output_fd)==0)) { ctx.output_written=1; ok=1; }
    if (ctx.output_created) { if (close(ctx.output_fd)) ok=0; if (!ok) unlink(o->output); }
    if (!ok) snprintf(error,cap,"Timeline output could not be written to its new file/stdout.");
    else if (o->json) printf("{\"schemaVersion\":1,\"type\":\"encoded\",\"format\":\"tl\",\"encrypted\":false,\"timelineBytes\":%zu,\"rate\":48000,\"audioProfile\":\"%s\",\"tlVersion\":%u,\"engineVersion\":%u}\n",len,profile_id(o->profile),TS_TL_VERSION,TS_TL_ENGINE_VERSION);
    else fputs("ToneSeal cleartext TL written; no pairing or receipt is implied.\n",stderr);
    OPENSSL_clear_free(timeline,len+1); return ok;
}
static int file_command(options *o) {
    uint8_t text[97]; size_t len; char error[512]={0}; ts_packet p; ts_pcm pcm={0},physical={0}; int result=2;
    if (o->file==FILE_TO_WAV || o->file==FILE_TO_TL) {
        if (!read_input(o,text,&len,0)) return stop_signal?128+stop_signal:2;
        if (!ts_clear_data(text,len,&p)) snprintf(error,sizeof(error),"Cannot prepare the ToneSeal cleartext packet.");
        else if (o->file==FILE_TO_TL) { if (timeline_output(o,&p,error,sizeof(error))) result=0; }
        else if (ts_modem_render_profile(&p,o->profile,&pcm,&stop_signal,error,sizeof(error)) &&
            ts_pcm_profile(&pcm,o->rate,o->profile,&physical) && ts_wav_write(o->output,&physical,error,sizeof(error))) {
            if (o->json) printf("{\"schemaVersion\":1,\"type\":\"encoded\",\"format\":\"wav\",\"encrypted\":false,\"frames\":%zu,\"rate\":%u,\"audioProfile\":\"%s\"}\n",physical.frames,physical.rate,profile_id(o->profile));
            else fprintf(stderr,"Cleartext WAV written; no pairing or receipt is implied.\n");
            result=0;
        }
        OPENSSL_cleanse(text,sizeof(text)); ts_pcm_free(&pcm); ts_pcm_free(&physical);
    } else {
        ac_receiver *receiver=malloc(sizeof(*receiver)); ts_resampler resampler; context ctx={0}; size_t i; int status=0;
        if (!receiver) return 2;
        ctx.options=*o;
        if (o->file==FILE_FROM_TL) { if (!ts_timeline_read(o->input,&pcm,&stop_signal,error,sizeof(error))) goto decode_done; }
        else if (!ts_wav_read(o->input,&pcm,error,sizeof(error))) goto decode_done;
        ac_init(receiver,decoded,&ctx); ts_resampler_init(&resampler,pcm.rate,o->profile);
        for (i=0;i<pcm.frames && !status;i+=997) { size_t n=pcm.frames-i; if (n>997) n=997; status=ts_resampler_feed(&resampler,receiver,pcm.samples+i,n); }
        if (!status) status=ts_resampler_finish(&resampler,receiver);
        if (status) { snprintf(error,sizeof(error),"ToneSeal sound could not be decoded within its bounds."); goto decode_done; }
        if (!ctx.packet_count) { result=1; snprintf(error,sizeof(error),"No packet was found. Use the same --profile as the sender/encoder; choose nearby, telephone or ultrasonic."); goto decode_done; }
        if (!output_open(&ctx)) goto decode_done;
        result=1;
        for (i=0;i<ctx.packet_count;++i) {
            ts_packet *packet=&ctx.packets[i]; int kind=0; size_t n=0;
            if (o->packets) {
                size_t j; fputs("{\"schemaVersion\":1,\"type\":\"packet\",\"hex\":\"",stdout); for (j=0;j<packet->len;++j) printf("%02x",packet->bytes[j]); fputs("\"}\n",stdout); result=0; continue;
            }
            if (ts_clear_parse(packet->bytes,packet->len,&kind,text,&n) && kind==1) { message(&ctx,TS_MODE_CLEAR,text,n,0); result=0; }
            else if (packet->len>1 && packet->bytes[0]==0 && ts_utf8_valid(packet->bytes+1,packet->len-1)) { message(&ctx,TS_MODE_CLEAR,packet->bytes+1,packet->len-1,0); result=0; }
        }
        if (ctx.io_error) result=2;
        if (ctx.output_created) { close(ctx.output_fd); if (!ctx.output_written) unlink(o->output); }
        if (result==1) snprintf(error,sizeof(error),"%s",o->file==FILE_FROM_TL?
            "Only opaque/control records found; from-tl recovers cleartext ToneSeal data. Encrypted packets require the live session.":
            "Only opaque/control records found; encrypted packets require the live session. Use --packets to inspect bytes.");
decode_done:
        free(receiver); ts_pcm_free(&pcm); OPENSSL_cleanse(&ctx,sizeof(ctx)); OPENSSL_cleanse(text,sizeof(text));
    }
    if (result && error[0]) { terminal(stderr,(const uint8_t *)error,strlen(error)); fputc('\n',stderr); }
    if (fflush(stdout)==EOF || ferror(stdout)) result=2;
    return stop_signal?128+stop_signal:result;
}
static void status_line(context *ctx, const ts_status *s, const ts_audio_stats *audio, uint64_t crc) {
    if (ctx->options.json) {
        printf("{\"schemaVersion\":1,\"type\":\"status\",\"phase\":\"%s\",\"active\":%s,\"connected\":%s,\"verified\":%s,\"closeConfirmed\":%s,\"pending\":%zu,\"sent\":%u,\"received\":%u,\"retries\":%u,\"crcRejected\":%llu,\"audioDrops\":%llu,\"inputLevel\":%.4f,\"rate\":%u,\"idleRemainingMs\":%.0f,\"fingerprint\":",
               ts_phase_name(s->phase),s->active?"true":"false",s->connected?"true":"false",s->verified?"true":"false",s->close_confirmed?"true":"false",s->pending,s->sent,s->received,s->retries,(unsigned long long)crc,(unsigned long long)audio->dropped_samples,audio->input_peak,audio->rate,fmax(0,s->idle_deadline-s->now));
        quote(stdout,(const uint8_t *)s->fingerprint,strlen(s->fingerprint)); fputs(",\"reason\":",stdout); quote(stdout,(const uint8_t *)s->reason,strlen(s->reason)); fputs("}\n",stdout); fflush(stdout);
    } else {
        fprintf(stderr,"%s: %s\n",ts_phase_name(s->phase),s->reason);
        if (s->phase==TS_VERIFY) fprintf(stderr,"Fingerprint: %s\nCompare every group on both screens. Type /confirm only if they match.\n",s->fingerprint);
    }
    if (fflush(stdout)==EOF || ferror(stdout)) ctx->io_error=1;
}
static int local_line(context *ctx, uint8_t *line, size_t len, uint8_t pending[96], size_t *pending_len) {
    double now=ts_clock_ms();
    if (len==8 && !memcmp(line,"/confirm",8)) { if (!ts_transfer_confirm(ctx->transfer,now)) fputs("There is no pending fingerprint confirmation.\n",stderr); return 1; }
    if (len==5 && !memcmp(line,"/quit",5)) { ts_transfer_close(ctx->transfer,now); return 1; }
    if (len==5 && !memcmp(line,"/stop",5)) { ts_transfer_stop(ctx->transfer); return 1; }
    if (len==7 && !memcmp(line,"/reveal",7)) {
        if (ctx->secret_len && now<ctx->secret_expiry) { terminal(stderr,ctx->secret,ctx->secret_len); fputc('\n',stderr); OPENSSL_cleanse(ctx->secret,sizeof(ctx->secret)); ctx->secret_len=0; }
        else fputs("No unexpired masked password is retained.\n",stderr);
        return 1;
    }
    if (len>6 && !memcmp(line,"/send ",6)) { line+=6; len-=6; }
    else if (len && line[0]=='/') { fputs("Local commands: /confirm /quit /stop /reveal. Use /send TEXT for a literal slash command.\n",stderr); return 1; }
    if (!len) return 1;
    if (len>96 || !ts_utf8_valid(line,len)) { fputs("Use 1-96 valid UTF-8 bytes.\n",stderr); return 1; }
    if (strcmp(ctx->options.command,"chat")) { fputs("Use the chat command to send further messages.\n",stderr); return 1; }
    if (*pending_len) { fputs("A draft is already waiting; keep this line locally and retry after queue space is available.\n",stderr); return 1; }
    if (!ts_transfer_enqueue(ctx->transfer,line,len,now)) { memcpy(pending,line,len); *pending_len=len; fputs("Waiting for connection or queue space; this draft is retained and input is paused.\n",stderr); }
    return 1;
}
static int live(options *o) {
    context ctx={0}; ts_options settings={0}; ts_audio *audio=NULL; ac_receiver *receiver=NULL; ts_resampler resampler;
    ts_status status={0},previous={0}; ts_audio_stats metrics={0}; uint8_t input[97]={0},line[103]={0},draft[96]={0};
    int control_fd=-1,own_control=0,eof=0,discard_line=0,result=2; size_t input_len=0,line_len=0,draft_len=0;
    uint64_t old_drops=0,crc_total=0; double last_status=0; char error[512]={0};
    settings.sender=!strcmp(o->command,"send") || (!strcmp(o->command,"chat") && o->send);
    settings.mode=o->mode; settings.chat=o->mode==TS_MODE_MESSAGE && !o->single; settings.profile=o->crypto;
    settings.audio_profile=o->profile; settings.verify=o->verify; settings.auto_close=strcmp(o->command,"chat")!=0; settings.idle_ms=o->timeout*1000;
    if (settings.sender && !read_input(o,input,&input_len,!strcmp(o->command,"chat") && !o->input)) return stop_signal?128+stop_signal:2;
    if (o->control_stdin || isatty(STDIN_FILENO) || !strcmp(o->command,"chat")) control_fd=STDIN_FILENO;
    else { control_fd=open("/dev/tty",O_RDONLY|O_NONBLOCK); if (control_fd>=0) own_control=1; }
    if (o->verify && control_fd<0) { fputs("--verify needs an interactive controlling terminal for /confirm. No weaker mode was selected.\n",stderr); goto done; }
    if (o->mode==TS_MODE_PASSWORD && !settings.sender && !o->output && control_fd<0) { fputs("Password receive needs a terminal for /reveal or an explicit --output destination.\n",stderr); goto done; }
    ctx.options=*o;
    if (!output_open(&ctx)) goto done;
    audio=ts_audio_open(o->input_device,o->output_device,o->profile,error,sizeof(error)); if (!audio) goto done;
    ts_audio_metrics(audio,&metrics); receiver=malloc(sizeof(*receiver)); if (!receiver) goto done;
    ac_init(receiver,decoded,&ctx); ts_resampler_init(&resampler,metrics.rate,o->profile);
    ctx.transfer=ts_transfer_new(&settings,input,input_len,ts_clock_ms(),message,delivery,&ctx); OPENSSL_cleanse(input,sizeof(input));
    if (!ctx.transfer) { snprintf(error,sizeof(error),"Cannot initialize the transfer."); goto done; }
    if (!o->json) fprintf(stderr,"%s · %s · %s. Output gain 100%%; adjust your device volume. Ctrl+C stops.\n",settings.mode==TS_MODE_CLEAR?"Unencrypted":o->verify?"Encrypted, fingerprint comparison required":"Encrypted, initial peer unverified",o->profile==TS_AUDIO_ULTRASONIC?"Near-ultrasonic (experimental; keep devices still)":o->profile==TS_AUDIO_TELEPHONE?"Telephone (experimental)":"Nearby",o->crypto==TS_X25519?"X25519":"P-256");
    for (;;) {
        int16_t block[2048]; size_t n,budget=0; ts_packet packet; double now=ts_clock_ms();
        ts_transfer_tick(ctx.transfer,now); ts_transfer_status(ctx.transfer,&status);
        if (!status.active || stop_signal) break;
        if (!ts_audio_active(audio)) { ts_transfer_fail(ctx.transfer,"Audio device was interrupted or disconnected."); continue; }
        ts_audio_metrics(audio,&metrics);
        if (metrics.dropped_samples!=old_drops) {
            old_drops=metrics.dropped_samples; crc_total+=receiver->counters.crc_failures; ac_init(receiver,decoded,&ctx); ts_resampler_init(&resampler,metrics.rate,o->profile); ts_audio_discard(audio);
        }
        while (budget++<8 && (n=ts_audio_read(audio,block,2048))>0) {
            if (ts_resampler_feed(&resampler,receiver,block,n)) { ts_transfer_fail(ctx.transfer,"Audio decoder exceeded its support/input bound."); break; }
        }
        while (ctx.packet_count) {
            packet=ctx.packets[ctx.packet_head]; ctx.packet_head=(ctx.packet_head+1)%8; ctx.packet_count--;
            ts_transfer_receive(ctx.transfer,packet.bytes,packet.len,ts_clock_ms());
        }
        if (ctx.io_error) { ts_transfer_fail(ctx.transfer,"The explicit output destination failed."); continue; }
        if (ctx.secret_len && now>=ctx.secret_expiry) { OPENSSL_cleanse(ctx.secret,sizeof(ctx.secret)); ctx.secret_len=0; }
        ts_transfer_status(ctx.transfer,&status);
        if (!status.active) break;
        if (draft_len && status.connected && !status.closing && ts_transfer_enqueue(ctx.transfer,draft,draft_len,now)) { OPENSSL_cleanse(draft,sizeof(draft)); draft_len=0; }
        if (status.closing && draft_len) { fputs("Unadmitted draft discarded as chat closes.\n",stderr); OPENSSL_cleanse(draft,sizeof(draft)); draft_len=0; }
        for (budget=0;budget<256 && control_fd>=0 && !eof && (!draft_len || status.phase==TS_VERIFY);++budget) {
            struct pollfd pfd={control_fd,POLLIN,0};
            if (poll(&pfd,1,0)>0 && (pfd.revents&(POLLIN|POLLHUP))) {
                uint8_t byte; ssize_t got=read(control_fd,&byte,1);
                if (got==0) eof=1;
                else if (got==1) {
                    if (byte=='\n') { if (!discard_line) local_line(&ctx,line,line_len,draft,&draft_len); OPENSSL_cleanse(line,sizeof(line)); line_len=0; discard_line=0; }
                    else if (line_len<sizeof(line)) line[line_len++]=byte;
                    else { discard_line=1; fputs("Input line exceeds its bound; press Enter and retry.\n",stderr); }
                }
            } else break;
        }
        if (eof && line_len && !draft_len) { if (!discard_line) local_line(&ctx,line,line_len,draft,&draft_len); OPENSSL_cleanse(line,sizeof(line)); line_len=0; }
        if (eof && !draft_len && status.connected && (ctx.received || status.last_queued) && !strcmp(o->command,"chat")) ts_transfer_close(ctx.transfer,now);
        if (ts_transfer_next(ctx.transfer,ts_clock_ms(),&packet)) {
            if (!ts_audio_send(audio,&packet,&stop_signal,error,sizeof(error))) { ts_transfer_fail(ctx.transfer,error); break; }
            crc_total+=receiver->counters.crc_failures; ac_init(receiver,decoded,&ctx); ts_resampler_init(&resampler,metrics.rate,o->profile);
            ts_transfer_sent(ctx.transfer,ts_clock_ms());
        }
        ts_transfer_status(ctx.transfer,&status); ts_audio_metrics(audio,&metrics);
        if (status.phase!=previous.phase || status.pending!=previous.pending || (o->json && ts_clock_ms()-last_status>=1000)) { status_line(&ctx,&status,&metrics,crc_total+receiver->counters.crc_failures); last_status=ts_clock_ms(); }
        previous=status;
        { struct timespec pause={0,10000000}; nanosleep(&pause,NULL); }
    }
    if (stop_signal) ts_transfer_stop(ctx.transfer);
    ts_transfer_status(ctx.transfer,&status); status_line(&ctx,&status,&metrics,crc_total+receiver->counters.crc_failures);
    result=stop_signal?128+stop_signal:ctx.io_error?2:status.phase==TS_DELIVERED || status.phase==TS_RECEIVED?0:status.phase==TS_CLOSED?(status.close_confirmed?0:3):1;
done:
    if (error[0] && result==2) fprintf(stderr,"%s\n",error);
    ts_audio_close(audio); ts_transfer_free(ctx.transfer); free(receiver);
    if (ctx.output_created) { close(ctx.output_fd); if (!ctx.output_written) unlink(o->output); }
    if (own_control) close(control_fd);
    OPENSSL_cleanse(&ctx,sizeof(ctx)); OPENSSL_cleanse(input,sizeof(input)); OPENSSL_cleanse(line,sizeof(line)); OPENSSL_cleanse(draft,sizeof(draft));
    return result;
}
static int probe(options *o) {
    char error[512]={0}; ts_audio *audio=ts_audio_open(o->input_device,o->output_device,o->profile,error,sizeof(error)); double end=ts_clock_ms()+o->duration*1000;
    if (!audio) { fprintf(stderr,"%s\n",error); return 2; }
    while (!stop_signal && ts_clock_ms()<end && ts_audio_active(audio)) {
        int16_t samples[2048]; ts_audio_stats metrics;
        while (ts_audio_read(audio,samples,2048)) {}
        ts_audio_metrics(audio,&metrics);
        if (o->json) printf("{\"schemaVersion\":1,\"type\":\"audio-level\",\"rate\":%u,\"peak\":%.4f,\"drops\":%llu}\n",metrics.rate,metrics.input_peak,(unsigned long long)metrics.dropped_samples);
        else fprintf(stderr,"Input %.3f at %u Hz\n",metrics.input_peak,metrics.rate);
        { struct timespec pause={0,100000000}; nanosleep(&pause,NULL); }
    }
    { int result=!ts_audio_active(audio) || fflush(stdout)==EOF || ferror(stdout)?2:0;
      ts_audio_close(audio); return stop_signal?128+stop_signal:result; }
}
int main(int argc, char **argv) {
    options o; int parsed; struct sigaction action;
    memset(&action,0,sizeof(action)); action.sa_handler=stopped; sigemptyset(&action.sa_mask);
    sigaction(SIGINT,&action,NULL); sigaction(SIGTERM,&action,NULL); sigaction(SIGHUP,&action,NULL); sigaction(SIGTSTP,&action,NULL); signal(SIGPIPE,SIG_IGN);
    parsed=parse(argc,argv,&o);
    if (parsed<0) return 0;
    if (!parsed) { fprintf(stderr,"Invalid command/options; use toneseal %s--help.\n",argc>1&&!strcmp(argv[1],"text")?"text ":""); return 2; }
    if (!strcmp(o.command,"capabilities")) {
        printf("{\"schemaVersion\":1,\"type\":\"capabilities\",\"version\":\"0.1.0\",\"experimental\":true,"
             "\"commands\":[\"send\",\"receive\",\"chat\",\"text\",\"encode\",\"decode\",\"devices\",\"audio-probe\",\"capabilities\"],"
             "\"textConversions\":{\"actions\":[\"to-tl\",\"from-tl\",\"to-wav\",\"from-wav\"],\"encoding\":\"toneseal-text-over-sound\",\"maxTextBytes\":96,\"timelineMaxBytes\":200000,\"timelineRate\":48000,\"tlVersion\":%u,\"engineVersion\":%u,\"timelineProfiles\":[\"nearby\",\"telephone\",\"ultrasonic\"],\"wavProfiles\":[\"nearby\",\"telephone\",\"ultrasonic\"],\"profileDetection\":\"explicit\"},"
             "\"modes\":[\"message\",\"password\",\"clear\"],\"profiles\":[\"nearby\",\"telephone\",\"ultrasonic\"],\"crypto\":[\"p256\",\"x25519\"],\"maxTextBytes\":96,\"maxPending\":8,"
             "\"peerIdleSeconds\":{\"default\":60,\"min\":1,\"max\":120},\"localCommands\":[\"/confirm\",\"/quit\",\"/stop\",\"/reveal\",\"/send TEXT\"],"
             "\"events\":[\"status\",\"message\",\"password\",\"delivered\",\"encoded\",\"packet\",\"audio-level\"],\"passwordMasked\":true,\"automaticClipboard\":false,\"automaticPeerAuthentication\":false}\n",TS_TL_VERSION,TS_TL_ENGINE_VERSION);
        return fflush(stdout)==EOF || ferror(stdout)?2:0;
    }
    if (!strcmp(o.command,"devices")) return ts_audio_devices(stdout,o.json)?0:2;
    if (o.file) return file_command(&o);
    if (!strcmp(o.command,"audio-probe")) return probe(&o);
    return live(&o);
}
