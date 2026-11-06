/* SPDX-License-Identifier: MIT */
#ifndef CQ_INTERNAL_H
#define CQ_INTERNAL_H

#include "colorqr.h"
#include <string.h>

#define CQ_HEADER_BITS 16
#define CQ_HEADER_REP 5
#define CQ_HEADER_MODULES (CQ_HEADER_BITS * CQ_HEADER_REP)
#define CQ_MSG_HEADER 6

/* Bump allocator over the caller's buffer. Everything is released when the call returns. */
typedef struct {
	uint8_t *base;
	size_t size, used, peak;
} cq_arena;

static inline void *cq_alloc(cq_arena *a, size_t count, size_t each)
{
	if (each != 0 && count > (SIZE_MAX - 8) / each) {
		return NULL;
	}
	size_t bytes = (count * each + 7u) & ~(size_t) 7u;
	if (bytes > a->size - a->used)
		return NULL;
	void *p = a->base + a->used;
	a->used += bytes;
	if (a->used > a->peak)
		a->peak = a->used;
	return p;
}

/* qr */
unsigned cq_qr_size(unsigned version);
void cq_qr_template(unsigned version, uint8_t *known, uint8_t *dark);
void cq_qr_function_mask(unsigned version, uint8_t *mask);
long cq_qr_data_modules(unsigned version, const uint8_t *fn);
/* bits: n*n, 1 = dark. On success fills matrix with the exact symbol. Returns 0 or a cq_status. */
int cq_qr_recover(const uint8_t *bits, unsigned version, uint8_t *matrix, cq_arena *a);

/* Same, from corrected data codewords, block after block. Parity is recomputed. */
int cq_qr_from_data(unsigned version, int ecl, unsigned mask, const uint8_t *data, size_t len,
                    uint8_t *matrix, cq_arena *a);

/* ra */
int cq_ra_decode(const float *llr, uint32_t n, uint32_t k, uint8_t *info, unsigned *iterations, cq_arena *a);

/* math, without libm */
float cq_ln(float x);
float cq_sqrt(float x);
#endif
