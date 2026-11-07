/* Copyright (c) 2026 Nenad Micic; SPDX-License-Identifier: Apache-2.0 */
/* Frame-relative half-duplex orchestration compatible with AutoTransfer/ChatTransfer. */
#include "transfer.h"
#include <openssl/crypto.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { JOB_RESPONSE, JOB_FLIGHT, JOB_POLL, JOB_REPLY, JOB_FINAL, JOB_CLEAR_FIN };
enum { CLOSE_NONE, CLOSE_DRAINING, CLOSE_COMMITTING, CLOSE_ACKING, CLOSE_WAITING };
typedef struct { ts_packet packet; double due; int kind; unsigned generation; } job;
typedef struct { uint32_t number; ts_packet data,control; int close; unsigned attempts; } turn;
struct ts_transfer {
    ts_options options; ts_status status; ts_session *session;
    uint8_t initial[96]; size_t initial_len;
    ts_packet local_ready,peer_ready,answer,flight,clear_data,data_packet;
    ts_packet own[20]; size_t own_count;
    unsigned flight_generation,flight_attempts;
    int flight_active,rekey_started,rekey_complete,accepted,human_confirmed;
    double retry_due,linger_deadline,close_deadline,poll_deadline,next_poll;
    job jobs[8],sending; size_t job_count; int transmitting;
    turn poll,response; int poll_active,sending_turn,close_stage,peer_closing;
    uint32_t last_peer_turn; unsigned idle_rounds;
    ts_message_callback message; ts_delivery_callback delivery; void *context;
};
static int packet_equal(const ts_packet *a, const uint8_t *b, size_t n) {
    return a->len==n && CRYPTO_memcmp(a->bytes,b,n)==0;
}
static double scale(const ts_transfer *t) { return t->options.telephone?4.0/3:1; }
static size_t pending_count(const ts_transfer *t) { return t->session?ts_session_pending(t->session,NULL):0; }
static void phase(ts_transfer *t, int state, const char *reason) {
    t->status.phase=state;
    if (reason) snprintf(t->status.reason,sizeof(t->status.reason),"%s",reason);
}
static void finish(ts_transfer *t, int state, const char *reason) {
    t->status.pending=pending_count(t); t->status.active=0; t->status.connected=0;
    phase(t,state,reason); t->job_count=0; t->flight_active=0; t->poll_active=0;
    OPENSSL_cleanse(t->initial,sizeof(t->initial)); t->initial_len=0;
    ts_session_free(t->session); t->session=NULL;
    OPENSSL_cleanse(&t->flight,sizeof(t->flight)); OPENSSL_cleanse(&t->poll,sizeof(t->poll)); OPENSSL_cleanse(&t->response,sizeof(t->response));
    OPENSSL_cleanse(t->own,sizeof(t->own)); t->own_count=0;
    OPENSSL_cleanse(&t->clear_data,sizeof(t->clear_data)); OPENSSL_cleanse(&t->data_packet,sizeof(t->data_packet));
    OPENSSL_cleanse(t->jobs,sizeof(t->jobs)); OPENSSL_cleanse(&t->sending,sizeof(t->sending));
}
void ts_transfer_fail(ts_transfer *t, const char *why) { if (t->status.active) finish(t,TS_FAILED,why); }
static int session_ok(ts_transfer *t, int ok) {
    if (!ok) { char why[160]; snprintf(why,sizeof(why),"%s",ts_session_error(t->session)); ts_transfer_fail(t,why); }
    return ok;
}
static void progress(ts_transfer *t) { t->status.idle_deadline=t->status.now+t->options.idle_ms; }
static int queue(ts_transfer *t, const ts_packet *p, int kind, double delay, unsigned generation) {
    size_t i;
    if (!t->status.active) return 0;
    if (kind==JOB_RESPONSE) {
        if (t->transmitting && packet_equal(&t->sending.packet,p->bytes,p->len)) return 1;
        for (i=0;i<t->job_count;++i) if (packet_equal(&t->jobs[i].packet,p->bytes,p->len)) return 1;
    }
    if (t->job_count==8) { ts_transfer_fail(t,"Outgoing control queue exceeded its bound."); return 0; }
    t->jobs[t->job_count++]=(job){*p,t->status.now+delay,kind,generation}; return 1;
}
static void drop_flight(ts_transfer *t) {
    size_t i,j=0;
    t->flight_active=0; t->retry_due=0; t->flight_generation++;
    for (i=0;i<t->job_count;++i) if (t->jobs[i].kind!=JOB_FLIGHT) t->jobs[j++]=t->jobs[i];
    t->job_count=j;
}
static void send_flight(ts_transfer *t, double delay) {
    if (t->flight_attempts>=8) { ts_transfer_fail(t,"Peer did not respond within the retry bound."); return; }
    t->flight_attempts++;
    t->retry_due=0; queue(t,&t->flight,JOB_FLIGHT,delay,t->flight_generation);
}
static void flight(ts_transfer *t, const ts_packet *p, double delay) {
    drop_flight(t); t->flight=*p; t->flight_active=1; t->flight_attempts=0; send_flight(t,delay);
}
static void respond(ts_transfer *t, const ts_packet *p) { queue(t,p,JOB_RESPONSE,500,0); }
static void info(ts_transfer *t) {
    ts_info s;
    if (!t->session) return;
    ts_session_info(t->session,&s); memcpy(t->status.fingerprint,s.fingerprint,40);
    t->status.pending=s.pending_count;
}
static void connected(ts_transfer *t) {
    if (!t->status.connected && !session_ok(t,ts_session_lock_epoch(t->session))) return;
    t->status.connected=1;
    phase(t,t->close_stage?TS_CLOSING:TS_CONNECTED,t->close_stage?"Draining and closing chat.":"Encrypted chat connected.");
}
static void begin_close(ts_transfer *t) {
    if (t->close_stage) return;
    t->close_stage=CLOSE_DRAINING; t->status.closing=1;
    t->close_deadline=t->status.now+180000*scale(t);
    if (t->close_deadline>t->status.run_deadline) t->close_deadline=t->status.run_deadline;
    phase(t,TS_CLOSING,"Draining admitted messages before closing.");
}
void ts_transfer_close(ts_transfer *t, double now) {
    t->status.now=now;
    if (!t->status.active) return;
    if (!t->options.chat || !t->status.connected) { ts_transfer_stop(t); return; }
    begin_close(t);
    if (t->options.sender && t->next_poll) t->next_poll=now;
}
static void delivered(ts_transfer *t, const ts_result *r) {
    size_t i;
    for (i=0;i<r->acknowledged_count;++i) { t->status.delivered++; if (t->delivery) t->delivery(t->context,r->acknowledged[i]); }
    if (t->options.auto_close && t->options.sender && t->status.last_queued && !pending_count(t) && t->status.delivered) begin_close(t);
}
static int send_initial(ts_transfer *t) {
    if (!session_ok(t,ts_session_send(t->session,t->options.mode==TS_MODE_PASSWORD,t->initial,t->initial_len,&t->data_packet))) return 0;
    OPENSSL_cleanse(t->initial,sizeof(t->initial)); t->initial_len=0;
    t->status.last_queued=(uint32_t)t->data_packet.bytes[11]<<24 | (uint32_t)t->data_packet.bytes[12]<<16 | (uint32_t)t->data_packet.bytes[13]<<8 | t->data_packet.bytes[14];
    if (t->options.chat) { connected(t); t->next_poll=t->status.now; }
    else { phase(t,TS_SENDING,"Sending encrypted data; waiting for its receipt."); flight(t,&t->data_packet,500); }
    return 1;
}
static int confirm_local(ts_transfer *t) {
    ts_info s; ts_session_info(t->session,&s);
    if (!s.local_confirmed && !session_ok(t,ts_session_confirm(t->session,&t->local_ready))) return 0;
    phase(t,TS_CONFIRMING,"Confirming session keys with the peer.");
    if (t->options.sender) flight(t,&t->local_ready,500);
    else if (s.peer_confirmed) respond(t,&t->local_ready);
    return 1;
}
static void verification(ts_transfer *t) {
    info(t);
    if (t->options.verify && !t->human_confirmed) phase(t,TS_VERIFY,"Compare every fingerprint group on both devices, then confirm.");
    else confirm_local(t);
}
int ts_transfer_confirm(ts_transfer *t, double now) {
    ts_info s; t->status.now=now;
    if (!t->status.active || !t->session || t->status.phase!=TS_VERIFY) return 0;
    ts_session_info(t->session,&s); if (!s.fingerprint[0] || s.local_confirmed) return 0;
    t->human_confirmed=1; t->status.verified=1; progress(t); return confirm_local(t);
}
int ts_transfer_enqueue(ts_transfer *t, const uint8_t *text, size_t len, double now) {
    ts_packet p; t->status.now=now;
    if (!t->status.active || !t->options.chat || !t->status.connected || t->close_stage || !len || len>96 || !ts_utf8_valid(text,len)) return 0;
    if (!ts_session_send(t->session,0,text,len,&p)) return 0;
    t->status.last_queued=(uint32_t)p.bytes[11]<<24 | (uint32_t)p.bytes[12]<<16 | (uint32_t)p.bytes[13]<<8 | p.bytes[14];
    if (t->options.sender && t->next_poll) t->next_poll=now;
    info(t); return 1;
}
static void send_turn(ts_transfer *t, turn *r, int reply) {
    r->attempts++;
    t->sending_turn=1;
    if (r->data.len) queue(t,&r->data,JOB_RESPONSE,500,0);
    queue(t,&r->control,reply?JOB_REPLY:JOB_POLL,r->data.len?0:500,0);
}
static void new_poll(ts_transfer *t) {
    ts_info s; int close;
    if (t->poll_active || t->sending_turn || !t->status.connected) return;
    if (t->status.turn==TS_SEQUENCE_MAX) { ts_transfer_fail(t,"Chat turn counter exhausted."); return; }
    memset(&t->poll,0,sizeof(t->poll)); t->poll.number=++t->status.turn;
    close=t->close_stage==CLOSE_COMMITTING?TS_COMMIT:t->close_stage?TS_DRAIN:TS_OPEN; t->poll.close=close;
    if (close==TS_COMMIT && !session_ok(t,ts_session_lock_data(t->session))) return;
    ts_session_info(t->session,&s);
    if (close!=TS_COMMIT && s.pending_count && !session_ok(t,ts_session_retry_pending(t->session,&t->poll.data))) return;
    if (!session_ok(t,ts_session_turn(t->session,0,t->poll.number,s.pending_count>0,close,&t->poll.control))) return;
    t->poll_active=1; send_turn(t,&t->poll,0);
}
static void finish_close(ts_transfer *t, int confirmed, const char *why) {
    t->status.close_confirmed=confirmed; finish(t,TS_CLOSED,why);
}
static void receive_turn(ts_transfer *t, const ts_result *r) {
    ts_info s; int close;
    if (!t->rekey_complete) return;
    if (t->options.sender) {
        if (!r->reply || !t->poll_active || r->number!=t->poll.number || ((t->poll.close==TS_COMMIT)!=(r->close==TS_ACK_CLOSE))) { t->status.rejected++; return; }
        if (!r->duplicate) progress(t);
        t->poll_deadline=0; t->poll_active=0; delivered(t,r);
        if (r->close==TS_ACK_CLOSE) {
            ts_packet final;
            if (r->number==TS_SEQUENCE_MAX) { finish_close(t,0,"Close acknowledged, but no final turn remained."); return; }
            if (!session_ok(t,ts_session_turn(t->session,0,r->number+1,0,TS_FINAL,&final))) return;
            phase(t,TS_CLOSING,"Peer acknowledged close; sending final confirmation.");
            queue(t,&final,JOB_FINAL,500,0); return;
        }
        if (r->close==TS_DRAIN) { begin_close(t); t->peer_closing=1; }
        if (t->close_stage && t->peer_closing && r->close==TS_DRAIN && !r->pending && !pending_count(t)) t->close_stage=CLOSE_COMMITTING;
        connected(t);
        if (t->close_stage || r->pending || pending_count(t)) { t->idle_rounds=0; t->next_poll=t->status.now+500; }
        else { unsigned delay; if (t->idle_rounds<4) t->idle_rounds++; delay=1000u<<(t->idle_rounds-1); if (delay>5000) delay=5000; t->next_poll=t->status.now+delay; }
        return;
    }
    if (r->reply || r->number<t->last_peer_turn || r->number>t->last_peer_turn+1) { t->status.rejected++; return; }
    if (r->close==TS_FINAL) {
        if (r->number!=t->last_peer_turn+1 || t->response.close!=TS_ACK_CLOSE ||
            (t->close_stage!=CLOSE_ACKING && t->close_stage!=CLOSE_WAITING) || pending_count(t)) { t->status.rejected++; return; }
        finish_close(t,1,"Peer's authenticated final close was received."); return;
    }
    if ((t->close_stage==CLOSE_ACKING || t->close_stage==CLOSE_WAITING) && (r->number!=t->last_peer_turn || r->close!=TS_COMMIT)) { t->status.rejected++; return; }
    if (r->close==TS_COMMIT && (!t->close_stage || pending_count(t) || (r->number>t->last_peer_turn && t->response.close!=TS_DRAIN))) { t->status.rejected++; return; }
    delivered(t,r);
    if (r->number==t->last_peer_turn) {
        if (t->response.number==r->number && !t->sending_turn) send_turn(t,&t->response,1);
        return;
    }
    if (t->sending_turn) return;
    if (!r->duplicate) progress(t);
    t->last_peer_turn=r->number;
    if (r->close==TS_DRAIN) { begin_close(t); t->peer_closing=1; }
    if (r->close==TS_COMMIT) {
        if (!session_ok(t,ts_session_lock_data(t->session))) return;
        t->close_stage=CLOSE_ACKING; t->peer_closing=1;
    }
    connected(t); memset(&t->response,0,sizeof(t->response)); t->response.number=r->number;
    close=r->close==TS_COMMIT?TS_ACK_CLOSE:t->close_stage?TS_DRAIN:TS_OPEN; t->response.close=close;
    ts_session_info(t->session,&s);
    if (close!=TS_ACK_CLOSE && s.pending_count && !session_ok(t,ts_session_retry_pending(t->session,&t->response.data))) return;
    if (!session_ok(t,ts_session_turn(t->session,1,r->number,s.pending_count>0,close,&t->response.control))) return;
    send_turn(t,&t->response,1);
}
ts_transfer *ts_transfer_new(const ts_options *options, const uint8_t *text, size_t len, double now,
                            ts_message_callback message, ts_delivery_callback delivery, void *context) {
    ts_transfer *t; ts_packet p;
    if (!options || options->mode<TS_MODE_MESSAGE || options->mode>TS_MODE_CLEAR ||
        (options->chat && options->mode!=TS_MODE_MESSAGE) || options->idle_ms<1000 || options->idle_ms>120000 ||
        (options->sender?(!len || len>96 || !ts_utf8_valid(text,len)):len!=0)) return NULL;
    t=calloc(1,sizeof(*t)); if (!t) return NULL;
    t->options=*options; t->message=message; t->delivery=delivery; t->context=context;
    t->status.active=1; t->status.now=now; t->status.run_deadline=now+(options->chat?600000:180000); progress(t);
    if (len) memcpy(t->initial,text,len);
    t->initial_len=len;
    if (options->mode==TS_MODE_CLEAR) {
        if (options->sender) {
            if (!ts_clear_data(text,len,&p)) { free(t); return NULL; }
            t->clear_data=p; phase(t,TS_SENDING,"Sending cleartext; receipt is unauthenticated."); flight(t,&p,250);
            OPENSSL_cleanse(t->initial,sizeof(t->initial)); t->initial_len=0;
        } else phase(t,TS_RECEIVING,"Listening for cleartext DATA.");
        return t;
    }
    t->session=ts_session_new(options->profile,options->chat);
    if (!t->session) { ts_transfer_free(t); return NULL; }
    phase(t,TS_DISCOVERING,options->sender?"Finding the receiver.":"Listening for the sender.");
    if (options->sender && session_ok(t,ts_session_offer(t->session,&p))) flight(t,&p,250);
    return t;
}
void ts_transfer_free(ts_transfer *t) {
    if (!t) return;
    ts_session_free(t->session); OPENSSL_clear_free(t,sizeof(*t));
}
void ts_transfer_stop(ts_transfer *t) { if (t->status.active) finish(t,TS_STOPPED,"Stopped locally; pending delivery may be unconfirmed."); }
const char *ts_phase_name(int p) {
    static const char *names[]={"idle","discovering","verify","confirming","rekeying","receiving","sending","chat","closing","delivered","received","closed","stopped","error"};
    return p>=0 && p<=TS_FAILED?names[p]:"error";
}
void ts_transfer_status(const ts_transfer *t, ts_status *out) {
    double due=t->status.run_deadline;
    *out=t->status; out->pending=t->session?pending_count(t):t->status.pending;
    if (t->session) { ts_info s; ts_session_info(t->session,&s); memcpy(out->fingerprint,s.fingerprint,40); }
    if (t->status.idle_deadline<due) due=t->status.idle_deadline;
    /* Jobs are a FIFO: a control frame cannot overtake its DATA frame. */
    if (t->job_count && t->jobs[0].due<due) due=t->jobs[0].due;
    if (t->retry_due && t->retry_due<due) due=t->retry_due;
    if (t->poll_deadline && t->poll_deadline<due) due=t->poll_deadline;
    if (t->next_poll && t->next_poll<due) due=t->next_poll;
    if (t->linger_deadline && t->linger_deadline<due) due=t->linger_deadline;
    if (t->close_deadline && t->close_deadline<due) due=t->close_deadline;
    out->next_due=t->status.active?due:0;
}
void ts_transfer_tick(ts_transfer *t, double now) {
    t->status.now=now;
    if (!t->status.active) return;
    if (now>=t->status.run_deadline) { ts_transfer_fail(t,"Session lifetime expired; delivery without a receipt is unconfirmed."); return; }
    if (t->linger_deadline && now>=t->linger_deadline) { finish(t,TS_RECEIVED,"Received; bounded receipt-repair listening finished."); return; }
    if (t->close_deadline && now>=t->close_deadline) { finish_close(t,0,"Close was not fully confirmed before its deadline."); return; }
    if (now>=t->status.idle_deadline) {
        if (!t->options.chat && t->accepted) finish(t,TS_RECEIVED,"Received; idle timeout ended receipt-repair listening.");
        else ts_transfer_fail(t,"No new peer response before the idle timeout.");
        return;
    }
    if (t->transmitting) return;
    if (t->retry_due && now>=t->retry_due && t->flight_active) send_flight(t,0);
    if (t->poll_deadline && now>=t->poll_deadline && t->poll_active) {
        t->poll_deadline=0;
        if (t->poll.attempts>=(t->poll.close==TS_COMMIT?3u:8u)) {
            if (t->close_stage) finish_close(t,0,"Peer did not acknowledge closing; closure remains unconfirmed.");
            else ts_transfer_fail(t,"Peer did not acknowledge the retained chat turn.");
            return;
        }
        send_turn(t,&t->poll,0);
    }
    if (t->next_poll && now>=t->next_poll && t->options.sender && !t->poll_active && !t->sending_turn) { t->next_poll=0; new_poll(t); }
}
int ts_transfer_next(ts_transfer *t, double now, ts_packet *out) {
    size_t i;
    ts_transfer_tick(t,now);
    if (!t->status.active || t->transmitting || !t->job_count || t->jobs[0].due>now) return 0;
    t->sending=t->jobs[0]; memmove(t->jobs,t->jobs+1,(--t->job_count)*sizeof(job)); t->transmitting=1;
    for (i=0;i<t->own_count;++i) if (packet_equal(&t->own[i],t->sending.packet.bytes,t->sending.packet.len)) { t->status.retries++; break; }
    if (t->own_count==20) { memmove(t->own,t->own+1,19*sizeof(ts_packet)); t->own_count--; }
    t->own[t->own_count++]=t->sending.packet; *out=t->sending.packet; return 1;
}
void ts_transfer_sent(ts_transfer *t, double now) {
    job sent;
    if (!t->transmitting) return;
    sent=t->sending; t->status.now=now; t->transmitting=0;
    if (!t->status.active) return;
    t->status.sent++;
    if (sent.kind==JOB_FLIGHT && t->flight_active && sent.generation==t->flight_generation) t->retry_due=now+8000*scale(t);
    if (sent.kind==JOB_POLL) { t->sending_turn=0; if (t->poll_active) t->poll_deadline=now+18000*scale(t); }
    if (sent.kind==JOB_REPLY) {
        t->sending_turn=0;
        if (t->response.close==TS_ACK_CLOSE && t->close_stage!=CLOSE_WAITING) {
            double linger=now+46000*scale(t); t->close_stage=CLOSE_WAITING;
            if (linger<t->close_deadline) t->close_deadline=linger;
        }
    }
    if (sent.kind==JOB_FINAL) finish_close(t,1,"Peer acknowledged close; final confirmation was sent.");
    if (sent.kind==JOB_CLEAR_FIN) finish(t,TS_DELIVERED,"Matching cleartext checksum receipt received; FIN sent.");
}
void ts_transfer_receive(ts_transfer *t, const uint8_t *bytes, size_t len, double now) {
    ts_result event; ts_packet packet; ts_info s; size_t i; int before_rekey;
    t->status.now=now; if (!t->status.active || len>128) return;
    for (i=0;i<t->own_count;++i) if (packet_equal(&t->own[i],bytes,len)) return;
    memcpy(packet.bytes,bytes,len); packet.len=len;
    if (t->options.mode==TS_MODE_CLEAR) {
        uint8_t text[96]; size_t n; int kind;
        if (!ts_clear_parse(bytes,len,&kind,text,&n)) { t->status.rejected++; return; }
        if (t->options.sender) {
            if (kind==1 && t->flight_active) { ts_transfer_fail(t,"Both devices are sending; choose a receiver on one side."); return; }
            if (kind!=2 || !t->flight_active || !ts_clear_same(&packet,&t->clear_data)) return;
            progress(t); drop_flight(t);
            if (ts_clear_control(&packet,3,&packet)) queue(t,&packet,JOB_CLEAR_FIN,500,0);
        } else if (kind==1) {
            if (t->accepted && (!ts_clear_same(&packet,&t->clear_data) || !packet_equal(&t->clear_data,bytes,len))) return;
            if (!t->accepted) {
                progress(t); t->accepted=1; t->clear_data=packet; t->status.received++;
                t->linger_deadline=now+60000; phase(t,TS_RECEIVED,"Cleartext received; returning an unauthenticated receipt.");
                if (t->message) t->message(t->context,TS_MODE_CLEAR,text,n,0);
            }
            if (ts_clear_control(&packet,2,&packet)) respond(t,&packet);
        } else if (kind==3 && t->accepted && ts_clear_same(&packet,&t->clear_data)) finish(t,TS_RECEIVED,"Cleartext received; matching FIN received.");
        OPENSSL_cleanse(text,sizeof(text)); return;
    }
    if (len<3 || bytes[0]!=0xa7) return;
    if (t->options.sender && bytes[2]==1) {
        if (t->status.phase==TS_DISCOVERING) {
            ts_session *probe=ts_session_new(t->options.profile,t->options.chat);
            if (probe) { int ok=ts_session_receive(probe,bytes,len,&event); ts_session_free(probe); if (ok && event.type==TS_OFFER) ts_transfer_fail(t,"Both devices are sending; choose a receiver on one side."); }
        }
        return;
    }
    if (!t->rekey_started && t->peer_ready.len && packet_equal(&t->peer_ready,bytes,len)) { if (!t->options.sender && t->local_ready.len) respond(t,&t->local_ready); return; }
    if (t->answer.len && packet_equal(&t->answer,bytes,len)) { if (!t->rekey_started && t->options.sender && t->local_ready.len) respond(t,&t->local_ready); return; }
    before_rekey=t->rekey_started;
    if (!ts_session_receive(t->session,bytes,len,&event)) { t->status.rejected++; return; }
    info(t); ts_session_info(t->session,&s);
    if (event.type==TS_OFFER) { progress(t); respond(t,&event.outbound); verification(t); }
    else if (event.type==TS_ANSWER) { progress(t); t->answer=packet; drop_flight(t); verification(t); }
    else if (event.type==TS_READY && !t->rekey_started) {
        progress(t); t->peer_ready=packet;
        if (!t->options.sender) { if (t->local_ready.len) respond(t,&t->local_ready); }
        else if (s.ready) {
            drop_flight(t); t->rekey_started=1; phase(t,TS_REFRESHING,"Refreshing keys inside the encrypted session.");
            if (session_ok(t,ts_session_rekey(t->session,&packet))) flight(t,&packet,500);
        }
    } else if (event.type==TS_REKEY || (event.type==TS_READY && t->rekey_started)) {
        progress(t); t->rekey_started=1; phase(t,TS_REFRESHING,"Refreshing keys inside the encrypted session.");
        if (t->options.sender) drop_flight(t);
        if (s.ready) {
            t->rekey_complete=1;
            if (event.has_outbound) respond(t,&event.outbound);
            if (t->options.sender) send_initial(t); else phase(t,TS_RECEIVING,"Key refresh complete; listening for data.");
        } else if (event.has_outbound) { if (t->options.sender) flight(t,&event.outbound,500); else respond(t,&event.outbound); }
    } else if ((event.type==TS_MESSAGE || event.type==TS_PASSWORD) && t->rekey_complete) {
        int mode=event.type==TS_PASSWORD?TS_MODE_PASSWORD:TS_MODE_MESSAGE;
        if (mode==t->options.mode && (t->options.chat || !t->options.sender)) {
            progress(t);
            if (!t->accepted || t->options.chat) {
                t->accepted=1; t->status.received++;
                if (t->options.chat) connected(t); else { t->linger_deadline=now+60000; phase(t,TS_RECEIVED,"Data received; repairing a lost receipt if needed."); }
                if (t->message) t->message(t->context,mode,event.text,event.text_len,event.counter);
                if (t->options.chat && t->options.auto_close && !t->options.sender) begin_close(t);
            }
            if (event.has_outbound) respond(t,&event.outbound);
        }
    } else if (event.type==TS_ACK && !t->options.chat) {
        if (event.acknowledged_count) { progress(t); delivered(t,&event); }
        if (t->options.sender && t->data_packet.len && !pending_count(t)) { drop_flight(t); finish(t,TS_DELIVERED,"Delivery confirmed by an encrypted peer receipt."); }
    } else if (event.type==TS_TURN && t->options.chat) receive_turn(t,&event);
    else if (event.type==TS_DUPLICATE && event.has_outbound) {
        if (event.counter) { if (t->accepted && t->rekey_complete && !t->options.sender) respond(t,&event.outbound); }
        else if (bytes[2]==1) { if (!t->rekey_started && !t->options.sender) respond(t,&event.outbound); }
        else if (t->rekey_started && (before_rekey || t->rekey_complete)) respond(t,&event.outbound);
    }
    OPENSSL_cleanse(&event,sizeof(event)); info(t);
}
