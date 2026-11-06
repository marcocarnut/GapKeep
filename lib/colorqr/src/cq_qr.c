/* SPDX-License-Identifier: MIT */
/* QR structure, and rebuilding a symbol's exact modules from noisy samples. See colorqr/qr.py. */
#include "cq_internal.h"
#include "cq_tables.h"

unsigned cq_qr_size(unsigned version) { return version * 4 + 17; }

static unsigned alignment_positions(unsigned version, unsigned *pos)
{
	if (version == 1)
		return 0;
	unsigned num = version / 7 + 2, n = cq_qr_size(version);
	unsigned step = version == 32 ? 26 : (version * 4 + num * 2 + 1) / (num * 2 - 2) * 2;
	pos[0] = 6;
	for (unsigned i = 0; i + 1 < num; i++)
		pos[num - 1 - i] = n - 7 - i * step;
	return num;
}

void cq_qr_template(unsigned version, uint8_t *known, uint8_t *dark)
{
	unsigned n = cq_qr_size(version);
	memset(known, 0, n * n);
	memset(dark, 0, n * n);
	for (unsigned i = 0; i < n; i++) {
		known[6 * n + i] = known[i * n + 6] = 1;
		dark[6 * n + i] = dark[i * n + 6] = i % 2 == 0;
	}
	const int centres[3][2] = {{3, 3}, {3, (int) n - 4}, {(int) n - 4, 3}};
	for (int f = 0; f < 3; f++) {
		for (int y = centres[f][0] - 4; y <= centres[f][0] + 4; y++) {
			for (int x = centres[f][1] - 4; x <= centres[f][1] + 4; x++) {
				if (y < 0 || x < 0 || y >= (int) n || x >= (int) n)
					continue;
				int dy = y - centres[f][0], dx = x - centres[f][1];
				int d = (dy < 0 ? -dy : dy) > (dx < 0 ? -dx : dx) ? (dy < 0 ? -dy : dy) : (dx < 0 ? -dx : dx);
				known[y * n + x] = 1;
				dark[y * n + x] = d != 2 && d != 4;
			}
		}
	}
	unsigned pos[8];
	unsigned count = alignment_positions(version, pos);
	for (unsigned a = 0; a < count; a++) {
		for (unsigned b = 0; b < count; b++) {
			unsigned y0 = pos[a], x0 = pos[b];
			if ((y0 == 6 && x0 == 6) || (y0 == 6 && x0 == n - 7) || (y0 == n - 7 && x0 == 6))
				continue;
			for (int y = (int) y0 - 2; y <= (int) y0 + 2; y++) {
				for (int x = (int) x0 - 2; x <= (int) x0 + 2; x++) {
					int dy = y - (int) y0, dx = x - (int) x0;
					int d = (dy < 0 ? -dy : dy) > (dx < 0 ? -dx : dx) ? (dy < 0 ? -dy : dy) : (dx < 0 ? -dx : dx);
					known[y * n + x] = 1;
					dark[y * n + x] = d != 1;
				}
			}
		}
	}
}

/* copy 0 or 1, bit 0..14 */
static void format_pos(unsigned n, int copy, int i, unsigned *r, unsigned *c)
{
	if (copy == 0) {
		if (i < 6) { *r = i; *c = 8; }
		else if (i == 6) { *r = 7; *c = 8; }
		else if (i == 7) { *r = 8; *c = 8; }
		else if (i == 8) { *r = 8; *c = 7; }
		else { *r = 8; *c = 14 - i; }
	} else if (i < 8) {
		*r = 8; *c = n - 1 - i;
	} else {
		*r = n - 15 + i; *c = 8;
	}
}

void cq_qr_function_mask(unsigned version, uint8_t *mask)
{
	unsigned n = cq_qr_size(version);
	memset(mask, 0, n * n);
	for (unsigned i = 0; i < n; i++)
		mask[6 * n + i] = mask[i * n + 6] = 1;
	for (unsigned y = 0; y < n; y++) {
		for (unsigned x = 0; x < n; x++) {
			if ((y < 9 && x < 9) || (y < 9 && x + 8 >= n) || (y + 8 >= n && x < 9))
				mask[y * n + x] = 1;
		}
	}
	unsigned pos[8];
	unsigned count = alignment_positions(version, pos);
	for (unsigned a = 0; a < count; a++) {
		for (unsigned b = 0; b < count; b++) {
			unsigned y0 = pos[a], x0 = pos[b];
			if ((y0 == 6 && x0 == 6) || (y0 == 6 && x0 == n - 7) || (y0 == n - 7 && x0 == 6))
				continue;
			for (unsigned y = y0 - 2; y <= y0 + 2; y++)
				for (unsigned x = x0 - 2; x <= x0 + 2; x++)
					mask[y * n + x] = 1;
		}
	}
	for (int copy = 0; copy < 2; copy++) {
		for (int i = 0; i < 15; i++) {
			unsigned r, c;
			format_pos(n, copy, i, &r, &c);
			mask[r * n + c] = 1;
		}
	}
	mask[(n - 8) * n + 8] = 1;
	if (version >= 7) {
		for (int i = 0; i < 18; i++) {
			unsigned a = i / 3, b = n - 11 + i % 3;
			mask[a * n + b] = mask[b * n + a] = 1;
		}
	}
}

long cq_qr_data_modules(unsigned version, const uint8_t *fn)
{
	unsigned n = cq_qr_size(version);
	long count = 0;
	for (unsigned i = 0; i < n * n; i++)
		count += !fn[i];
	return count;
}

static unsigned format_word(unsigned ecl_bits, unsigned mask)
{
	unsigned data = ecl_bits << 3 | mask, rem = data;
	for (int i = 0; i < 10; i++)
		rem = (rem << 1) ^ ((rem >> 9) * 0x537);
	return ((data << 10) | (rem & 0x3FF)) ^ 0x5412;
}

static unsigned version_word(unsigned version)
{
	unsigned rem = version;
	for (int i = 0; i < 12; i++)
		rem = (rem << 1) ^ ((rem >> 11) * 0x1F25);
	return version << 12 | (rem & 0xFFF);
}

static int mask_bit(unsigned m, unsigned i, unsigned j)
{
	switch (m) {
	case 0: return (i + j) % 2 == 0;
	case 1: return i % 2 == 0;
	case 2: return j % 3 == 0;
	case 3: return (i + j) % 3 == 0;
	case 4: return (i / 2 + j / 3) % 2 == 0;
	case 5: return i * j % 2 + i * j % 3 == 0;
	case 6: return (i * j % 2 + i * j % 3) % 2 == 0;
	default: return ((i + j) % 2 + i * j % 3) % 2 == 0;
	}
}

/* Visits the data region in codeword order. Fills order with row, col pairs. */
static unsigned zigzag(unsigned version, const uint8_t *fn, uint16_t *order)
{
	int n = (int) cq_qr_size(version);
	unsigned count = 0;
	for (int right = n - 1; right >= 1; right -= 2) {
		if (right == 6)
			right = 5;
		for (int vert = 0; vert < n; vert++) {
			for (int j = 0; j < 2; j++) {
				int x = right - j;
				int up = ((right + 1) & 2) == 0;
				int y = up ? n - 1 - vert : vert;
				if (!fn[y * n + x]) {
					order[count * 2] = (uint16_t) y;
					order[count * 2 + 1] = (uint16_t) x;
					count++;
				}
			}
		}
	}
	return count;
}

/* Reed-Solomon, errors only: GF(256), 0x11D, generator 2, first root 2^0. */
typedef struct { uint8_t exp[512], log[256]; } gf_t;

static void gf_init(gf_t *g)
{
	unsigned x = 1;
	for (int i = 0; i < 255; i++) {
		g->exp[i] = (uint8_t) x;
		g->log[x] = (uint8_t) i;
		x <<= 1;
		if (x & 0x100)
			x ^= 0x11D;
	}
	for (int i = 255; i < 512; i++)
		g->exp[i] = g->exp[i - 255];
}

static uint8_t gf_mul(const gf_t *g, uint8_t a, uint8_t b)
{
	return a && b ? g->exp[g->log[a] + g->log[b]] : 0;
}

#define RS_MAX 68

static void syndromes(const gf_t *g, const uint8_t *cw, unsigned len, unsigned nsym, uint8_t *s)
{
	for (unsigned j = 0; j < nsym; j++) {
		uint8_t v = 0;
		for (unsigned i = 0; i < len; i++)
			v = gf_mul(g, v, g->exp[j]) ^ cw[i];
		s[j] = v;
	}
}

/* Returns 0 on success (cw corrected), -1 if uncorrectable. */
static int rs_correct(const gf_t *g, uint8_t *cw, unsigned len, unsigned nsym)
{
	uint8_t s[RS_MAX], sigma[RS_MAX], prev[RS_MAX], tmp[RS_MAX], omega[RS_MAX];
	if (nsym >= RS_MAX || len > 255 || len <= nsym)
		return -1;
	syndromes(g, cw, len, nsym, s);
	int clean = 1;
	for (unsigned j = 0; j < nsym; j++)
		clean &= s[j] == 0;
	if (clean)
		return 0;

	/* Berlekamp-Massey */
	memset(sigma, 0, sizeof sigma);
	memset(prev, 0, sizeof prev);
	sigma[0] = prev[0] = 1;
	unsigned L = 0, m = 1;
	uint8_t b = 1;
	for (unsigned r = 0; r < nsym; r++) {
		uint8_t d = s[r];
		for (unsigned i = 1; i <= L; i++)
			d ^= gf_mul(g, sigma[i], s[r - i]);
		if (d == 0) {
			m++;
			continue;
		}
		uint8_t coef = gf_mul(g, d, g->exp[255 - g->log[b]]);
		memcpy(tmp, sigma, sizeof tmp);
		for (unsigned i = 0; i + m < RS_MAX; i++)
			sigma[i + m] ^= gf_mul(g, coef, prev[i]);
		if (2 * L <= r) {
			L = r + 1 - L;
			memcpy(prev, tmp, sizeof prev);
			b = d;
			m = 1;
		} else {
			m++;
		}
	}
	if (2 * L > nsym)
		return -1;

	/* error evaluator: omega = S * sigma mod x^nsym */
	memset(omega, 0, sizeof omega);
	for (unsigned i = 0; i < nsym; i++)
		for (unsigned j = 0; j <= L && i + j < nsym; j++)
			omega[i + j] ^= gf_mul(g, s[i], sigma[j]);

	/* Chien search and Forney. cw[len-1-i] has locator X = 2^i. */
	unsigned found = 0;
	for (unsigned i = 0; i < len; i++) {
		uint8_t xinv = i ? g->exp[255 - i] : 1;
		uint8_t sum = 0, pow = 1;
		for (unsigned k = 0; k <= L; k++) {
			sum ^= gf_mul(g, sigma[k], pow);
			pow = gf_mul(g, pow, xinv);
		}
		if (sum != 0)
			continue;
		uint8_t num = 0, p2 = 1;
		for (unsigned k = 0; k < nsym; k++) {
			num ^= gf_mul(g, omega[k], p2);
			p2 = gf_mul(g, p2, xinv);
		}
		/* with first root 2^0: e = X * omega(1/X) / sigma'(1/X) */
		uint8_t der = 0, p3 = 1;
		for (unsigned k = 1; k <= L; k += 2) {
			der ^= gf_mul(g, sigma[k], p3);
			p3 = gf_mul(g, p3, gf_mul(g, xinv, xinv));
		}
		if (der == 0)
			return -1;
		uint8_t e = gf_mul(g, gf_mul(g, g->exp[i], num), g->exp[255 - g->log[der]]);
		cw[len - 1 - i] ^= e;
		found++;
	}
	if (found != L)
		return -1;
	syndromes(g, cw, len, nsym, s);
	for (unsigned j = 0; j < nsym; j++)
		if (s[j])
			return -1;
	return 0;
}

/* Writes the full symbol from all interleaved codewords. */
static int place(unsigned version, int ecl, unsigned mask, const uint8_t *out, unsigned raw,
                 const uint16_t *order, unsigned modules, uint8_t *matrix, cq_arena *a)
{
	static const uint8_t ecl_bits[4] = {1, 0, 3, 2};   /* L M Q H */
	unsigned n = cq_qr_size(version);
	uint8_t *known = cq_alloc(a, n * n, 1);
	if (!known)
		return CQ_ERR_NOMEM;
	cq_qr_template(version, known, matrix);
	for (unsigned i = 0; i < modules; i++) {
		unsigned y = order[i * 2], x = order[i * 2 + 1];
		unsigned b = (i >> 3) < raw ? (unsigned) (out[i >> 3] >> (7 - (i & 7))) & 1u : 0u;
		matrix[y * n + x] = (uint8_t) (b ^ (unsigned) mask_bit(mask, y, x));
	}
	unsigned fw = format_word(ecl_bits[ecl], mask);
	for (int copy = 0; copy < 2; copy++) {
		for (int i = 0; i < 15; i++) {
			unsigned r, c;
			format_pos(n, copy, i, &r, &c);
			matrix[r * n + c] = (fw >> i) & 1;
		}
	}
	matrix[(n - 8) * n + 8] = 1;
	if (version >= 7) {
		unsigned vw = version_word(version);
		for (int i = 0; i < 18; i++) {
			unsigned ra = i / 3, rb = n - 11 + i % 3;
			matrix[ra * n + rb] = matrix[rb * n + ra] = (vw >> i) & 1;
		}
	}
	return 0;
}

int cq_qr_recover(const uint8_t *bits, unsigned version, uint8_t *matrix, cq_arena *a)
{
	unsigned n = cq_qr_size(version);

	/* format: best of both copies */
	static const uint8_t ecl_bits[4] = {1, 0, 3, 2};   /* L M Q H */
	int best = 16, ecl = 0;
	unsigned mask = 0;
	for (int copy = 0; copy < 2; copy++) {
		unsigned word = 0;
		for (int i = 0; i < 15; i++) {
			unsigned r, c;
			format_pos(n, copy, i, &r, &c);
			word |= (unsigned) (bits[r * n + c] != 0) << i;
		}
		for (int l = 0; l < 4; l++) {
			for (unsigned m = 0; m < 8; m++) {
				unsigned d = word ^ format_word(ecl_bits[l], m);
				int w = 0;
				for (; d; d &= d - 1)
					w++;
				if (w < best) {
					best = w;
					ecl = l;
					mask = m;
				}
			}
		}
	}
	if (best > 3)
		return CQ_ERR_BASE;

	uint8_t *fn = cq_alloc(a, n * n, 1);
	uint16_t *order = cq_alloc(a, 2u * n * n, sizeof *order);
	gf_t *g = cq_alloc(a, 1, sizeof *g);
	if (!fn || !order || !g)
		return CQ_ERR_NOMEM;
	cq_qr_function_mask(version, fn);
	unsigned modules = zigzag(version, fn, order);
	unsigned raw = modules / 8;
	uint8_t *words = cq_alloc(a, raw, 1), *out = cq_alloc(a, raw, 1);
	uint8_t *blocks = cq_alloc(a, raw, 1);
	if (!words || !out || !blocks)
		return CQ_ERR_NOMEM;
	memset(words, 0, raw);
	for (unsigned i = 0; i < raw * 8; i++) {
		unsigned y = order[i * 2], x = order[i * 2 + 1];
		unsigned b = (bits[y * n + x] != 0) ^ (unsigned) mask_bit(mask, y, x);
		words[i >> 3] |= (uint8_t) (b << (7 - (i & 7)));
	}

	unsigned ecc = cq_ecc_per_block[ecl][version], nb = cq_num_blocks[ecl][version];
	unsigned shortb = nb - raw % nb, datalen = raw / nb - ecc;
#define BLOCK_DATA(j) (datalen + ((j) < shortb ? 0u : 1u))

	/* de-interleave: blocks are stored one after another */
	unsigned *offs = cq_alloc(a, nb + 1u, sizeof *offs);
	if (!offs)
		return CQ_ERR_NOMEM;
	offs[0] = 0;
	for (unsigned j = 0; j < nb; j++)
		offs[j + 1] = offs[j] + BLOCK_DATA(j) + ecc;
	unsigned p = 0;
	for (unsigned i = 0; i < datalen + 1; i++)
		for (unsigned j = 0; j < nb; j++)
			if (i < BLOCK_DATA(j))
				blocks[offs[j] + i] = words[p++];
	for (unsigned i = 0; i < ecc; i++)
		for (unsigned j = 0; j < nb; j++)
			blocks[offs[j] + BLOCK_DATA(j) + i] = words[p++];

	gf_init(g);
	for (unsigned j = 0; j < nb; j++)
		if (rs_correct(g, blocks + offs[j], offs[j + 1] - offs[j], ecc))
			return CQ_ERR_BASE;

	p = 0;
	for (unsigned i = 0; i < datalen + 1; i++)
		for (unsigned j = 0; j < nb; j++)
			if (i < BLOCK_DATA(j))
				out[p++] = blocks[offs[j] + i];
	for (unsigned i = 0; i < ecc; i++)
		for (unsigned j = 0; j < nb; j++)
			out[p++] = blocks[offs[j] + BLOCK_DATA(j) + i];

	return place(version, ecl, mask, out, raw, order, modules, matrix, a);
}

/* Parity of one block: remainder of data * x^nsym by the generator with roots 2^0 .. 2^(nsym-1). */
static void rs_parity(const gf_t *g, const uint8_t *data, unsigned len, unsigned nsym, uint8_t *parity)
{
	uint8_t gen[RS_MAX + 1];
	memset(gen, 0, sizeof gen);
	gen[0] = 1;
	for (unsigned i = 0; i < nsym; i++) {     /* gen[k] is the coefficient of x^k */
		for (unsigned k = i + 1; k > 0; k--)
			gen[k] = gen[k - 1] ^ gf_mul(g, gen[k], g->exp[i]);
		gen[0] = gf_mul(g, gen[0], g->exp[i]);
	}
	memset(parity, 0, nsym);
	for (unsigned i = 0; i < len; i++) {
		uint8_t f = data[i] ^ parity[0];
		memmove(parity, parity + 1, nsym - 1);
		parity[nsym - 1] = 0;
		for (unsigned k = 0; k < nsym; k++)
			parity[k] ^= gf_mul(g, f, gen[nsym - 1 - k]);
	}
}

int cq_qr_from_data(unsigned version, int ecl, unsigned mask, const uint8_t *data, size_t len,
                    uint8_t *matrix, cq_arena *a)
{
	if (ecl < 0 || ecl > 3 || mask > 7 || !data)
		return CQ_ERR_BASE;
	unsigned n = cq_qr_size(version);
	uint8_t *fn = cq_alloc(a, (size_t) n * n, 1);
	uint16_t *order = cq_alloc(a, 2u * (size_t) n * n, sizeof *order);
	gf_t *g = cq_alloc(a, 1, sizeof *g);
	if (!fn || !order || !g)
		return CQ_ERR_NOMEM;
	cq_qr_function_mask(version, fn);
	unsigned modules = zigzag(version, fn, order);
	unsigned raw = modules / 8;
	unsigned ecc = cq_ecc_per_block[ecl][version], nb = cq_num_blocks[ecl][version];
	unsigned shortb = nb - raw % nb, datalen = raw / nb - ecc;
	if (len != raw - nb * ecc || ecc >= RS_MAX)
		return CQ_ERR_BASE;
	uint8_t *blocks = cq_alloc(a, raw, 1), *out = cq_alloc(a, raw, 1);
	unsigned *offs = cq_alloc(a, nb + 1u, sizeof *offs);
	if (!blocks || !out || !offs)
		return CQ_ERR_NOMEM;
	gf_init(g);
	unsigned from = 0;
	offs[0] = 0;
	for (unsigned j = 0; j < nb; j++) {
		unsigned d = BLOCK_DATA(j);
		offs[j + 1] = offs[j] + d + ecc;
		memcpy(blocks + offs[j], data + from, d);
		rs_parity(g, blocks + offs[j], d, ecc, blocks + offs[j] + d);
		from += d;
	}
	unsigned p = 0;
	for (unsigned i = 0; i < datalen + 1; i++)
		for (unsigned j = 0; j < nb; j++)
			if (i < BLOCK_DATA(j))
				out[p++] = blocks[offs[j] + i];
	for (unsigned i = 0; i < ecc; i++)
		for (unsigned j = 0; j < nb; j++)
			out[p++] = blocks[offs[j] + BLOCK_DATA(j) + i];
	return place(version, ecl, mask, out, raw, order, modules, matrix, a);
}
