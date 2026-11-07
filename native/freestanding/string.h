/* Copyright (c) 2026 Nenad Micic */
/* SPDX-License-Identifier: Apache-2.0 */
/* Only the standard byte operations used by the standalone decoder. */
#ifndef ACOUSTIC_STRING_H
#define ACOUSTIC_STRING_H
#include <stddef.h>
void *memcpy(void *, const void *, size_t);
void *memmove(void *, const void *, size_t);
void *memset(void *, int, size_t);
int memcmp(const void *, const void *, size_t);
#endif
