/* SPDX-License-Identifier: MIT */
/* The repeat-accumulate code: structure from xorshift32, layered min-sum decoding. See FORMAT.md. */
#include "cq_internal.h"

#define CQ_REPEAT 4u
#define CQ_SEED 0xC0DEC0DEu
#define CQ_NORM 0.8f
#define CQ_MAX_ITERS 100u

uint32_t cq_xorshift32(uint32_t x)
{
	x ^= x << 13;
	x ^= x >> 17;
	x ^= x << 5;
	return x;
}

static uint32_t shuffle(uint32_t *a, uint32_t len, uint32_t s)
{
	for (uint32_t i = len; i-- > 1;) {
		s = cq_xorshift32(s);
		uint32_t j = s % (i + 1), t = a[i];
		a[i] = a[j];
		a[j] = t;
	}
	return s;
}

typedef struct {
	uint32_t m, cap;
	uint32_t *rows;    /* m rows of cap entries */
	uint32_t *len;
	uint32_t *perm;
} code_t;

static int build(code_t *c, uint32_t n, uint32_t k, cq_arena *a)
{
	if (k == 0 || k >= n)
		return CQ_ERR_ARGS;
	uint32_t m = n - k, ns = k * CQ_REPEAT;
	uint32_t *sockets = cq_alloc(a, ns, sizeof *sockets);
	c->m = m;
	c->cap = ns / m + 1;
	c->rows = cq_alloc(a, (size_t) m * c->cap, sizeof *c->rows);
	c->len = cq_alloc(a, m, sizeof *c->len);
	c->perm = cq_alloc(a, n, sizeof *c->perm);
	if (!sockets || !c->rows || !c->len || !c->perm)
		return CQ_ERR_NOMEM;

	for (uint32_t i = 0; i < ns; i++)
		sockets[i] = i / CQ_REPEAT;
	uint32_t s = shuffle(sockets, ns, CQ_SEED ^ n ^ (k << 16));
	memset(c->len, 0, m * sizeof *c->len);
	for (uint32_t i = 0; i < ns; i++) {
		uint32_t b = sockets[i], r = i % m;
		for (uint32_t tries = 0; tries < m; tries++) {
			uint32_t *row = c->rows + (size_t) r * c->cap, l = c->len[r];
			int free = l < c->cap;
			for (uint32_t j = 0; free && j < l; j++)
				free = row[j] != b;
			if (free)
				break;
			r = (r + 1) % m;
		}
		if (c->len[r] >= c->cap)   /* cannot happen with these sizes; never write out of bounds */
			return CQ_ERR_ARGS;
		c->rows[(size_t) r * c->cap + c->len[r]++] = b;
	}
	for (uint32_t i = 0; i < n; i++)
		c->perm[i] = i;
	shuffle(c->perm, n, s);
	return 0;
}

int cq_ra_encode(const uint8_t *info, uint32_t k, uint8_t *stream, uint32_t n, void *work, size_t work_size)
{
	cq_arena a = {work, work_size, 0, 0};
	code_t c;
	int err = build(&c, n, k, &a);
	if (err)
		return err;
	for (uint32_t i = 0; i < k; i++)
		stream[c.perm[i]] = info[i];
	unsigned p = 0;
	for (uint32_t i = 0; i < c.m; i++) {
		const uint32_t *row = c.rows + (size_t) i * c.cap;
		for (uint32_t j = 0; j < c.len[i]; j++)
			p ^= info[row[j]];
		stream[c.perm[k + i]] = (uint8_t) p;
	}
	return 0;
}

int cq_ra_decode(const float *llr, uint32_t n, uint32_t k, uint8_t *info, unsigned *iterations, cq_arena *a)
{
	code_t c;
	int err = build(&c, n, k, a);
	if (err)
		return err;
	uint32_t m = c.m;
	size_t edges = (size_t) k * CQ_REPEAT + 2u * m;
	uint32_t *off = cq_alloc(a, (size_t) m + 1, sizeof *off);
	uint32_t *var = cq_alloc(a, edges, sizeof *var);
	float *msg = cq_alloc(a, edges, sizeof *msg);
	float *L = cq_alloc(a, n, sizeof *L);
	if (!off || !var || !msg || !L)
		return CQ_ERR_NOMEM;

	uint32_t e = 0;
	for (uint32_t i = 0; i < m; i++) {
		off[i] = e;
		var[e++] = c.perm[k + i];
		if (i)
			var[e++] = c.perm[k + i - 1];
		const uint32_t *row = c.rows + (size_t) i * c.cap;
		for (uint32_t j = 0; j < c.len[i]; j++)
			var[e++] = c.perm[row[j]];
	}
	off[m] = e;
	memset(msg, 0, e * sizeof *msg);
	memcpy(L, llr, n * sizeof *L);

	unsigned it;
	for (it = 1; it <= CQ_MAX_ITERS; it++) {
		for (uint32_t i = 0; i < m; i++) {
			float min1 = 1e30f, min2 = 1e30f;
			uint32_t at = off[i];
			unsigned neg = 0;
			for (uint32_t d = off[i]; d < off[i + 1]; d++) {
				float t = L[var[d]] - msg[d];
				L[var[d]] = t;
				float abs = t < 0 ? -t : t;
				neg ^= t < 0;
				if (abs < min1) {
					min2 = min1;
					min1 = abs;
					at = d;
				} else if (abs < min2) {
					min2 = abs;
				}
			}
			for (uint32_t d = off[i]; d < off[i + 1]; d++) {
				float t = L[var[d]];
				float v = CQ_NORM * (d == at ? min2 : min1);
				if (neg ^ (t < 0))
					v = -v;
				msg[d] = v;
				L[var[d]] = t + v;
			}
		}
		int done = 1;
		for (uint32_t i = 0; done && i < m; i++) {
			unsigned p = 0;
			for (uint32_t d = off[i]; d < off[i + 1]; d++)
				p ^= L[var[d]] < 0;
			done = !p;
		}
		if (done) {
			for (uint32_t b = 0; b < k; b++)
				info[b] = L[c.perm[b]] < 0;
			*iterations = it;
			return 0;
		}
	}
	*iterations = CQ_MAX_ITERS;
	return CQ_ERR_PAYLOAD;
}
