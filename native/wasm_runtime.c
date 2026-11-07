/* Copyright (c) 2026 Nenad Micic */
/* SPDX-License-Identifier: Apache-2.0 */
#include <stddef.h>
#include <stdint.h>
void *memcpy(void *destination, const void *source, size_t count)
{ unsigned char *d=destination; const unsigned char *s=source; size_t i; for(i=0;i<count;++i)d[i]=s[i];return destination; }
void *memmove(void *destination, const void *source, size_t count)
{ unsigned char *d=destination; const unsigned char *s=source; size_t i; if((uintptr_t)d<(uintptr_t)s){for(i=0;i<count;++i)d[i]=s[i];}else{for(i=count;i>0;--i)d[i-1]=s[i-1];}return destination; }
void *memset(void *destination, int value, size_t count)
{ unsigned char *d=destination;size_t i;for(i=0;i<count;++i)d[i]=(unsigned char)value;return destination; }
int memcmp(const void *left,const void *right,size_t count)
{ const unsigned char *a=left,*b=right;size_t i;for(i=0;i<count;++i)if(a[i]!=b[i])return a[i]<b[i]?-1:1;return 0; }
