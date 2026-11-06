/* SPDX-License-Identifier: MIT */
/* The reader: geometry, base rebuild, colour likelihoods, decoding. See colorqr/api.py and demod.py. */
#include "cq_internal.h"
#include "cq_tables.h"

#ifdef CQ_PROFILE
void cq_stage(int stage);
#define STAGE(n) cq_stage(n)
#else
#define STAGE(n) ((void) 0)
#endif

#define NF 15                 /* colour-correction features */
#define PILOT_PERCENT 6u
#define PRNG_SEED 0xC010C010u
#define MAGIC 0xBu
#define LLR_SCALE 0.3f
#define LLR_CLIP 8.0f
#define DEMOD_ITERS 4
#define TAP 0.18f
#define MAX_REFINE_PASSES 200u
#define BLUR_PASSES 1           /* measured: more passes decode no more codes */
#define STOP_FIRST 0.25f        /* corner step, in pixels, at which each refinement ends */
#define STOP_POLISH 0.1f
#define PLAIN_CHROMA 0.18f      /* measured: plain codes reach 0.12, coloured ones start at 0.26 */

/* ---- math without libm ---- */

float cq_sqrt(float x)
{
	if (!(x > 0))
		return 0;
	union { float f; uint32_t u; } v = {x};
	v.u = (v.u >> 1) + 0x1FC00000u;
	float y = v.f;
	for (int i = 0; i < 4; i++)
		y = 0.5f * (y + x / y);
	return y;
}

float cq_ln(float x)
{
	if (!(x > 0))
		return -100.0f;
	union { float f; uint32_t u; } v = {x};
	int e = (int) (v.u >> 23) - 127;
	v.u = (v.u & 0x7FFFFFu) | 0x3F800000u;
	float t = (v.f - 1) / (v.f + 1), t2 = t * t;    /* ln m = 2 atanh t */
	return (float) e * 0.6931472f + 2 * t * (1 + t2 * (0.33333334f + t2 * (0.2f + t2 * 0.14285715f)));
}

/* ---- format ---- */

unsigned cq_crc4(unsigned v12)
{
	unsigned r = v12 << 4;
	for (int i = 15; i > 3; i--)
		if ((r >> i) & 1)
			r ^= 0x13u << (i - 4);
	return r & 0xF;
}

int cq_parse_header(unsigned word, int *profile, int *rate_index)
{
	unsigned top = word >> 4;
	if ((top >> 8) != MAGIC || cq_crc4(top) != (word & 0xF))
		return -1;
	unsigned p = (top >> 4) & 0xF, r = top & 0xF;
	if (p > 1 || r > 7)
		return -1;
	*profile = (int) p;
	*rate_index = (int) r;
	return 0;
}

static long shuffled(unsigned version, const uint8_t *fn, uint16_t *order)
{
	unsigned n = cq_qr_size(version);
	uint32_t k = 0;
	for (unsigned y = 0; y < n; y++) {
		for (unsigned x = 0; x < n; x++) {
			if (!fn[y * n + x]) {
				order[k * 2] = (uint16_t) y;
				order[k * 2 + 1] = (uint16_t) x;
				k++;
			}
		}
	}
	uint32_t s = PRNG_SEED ^ version;
	for (uint32_t i = k; i-- > 1;) {
		s = cq_xorshift32(s);
		uint32_t j = s % (i + 1);
		uint16_t ty = order[i * 2], tx = order[i * 2 + 1];
		order[i * 2] = order[j * 2];
		order[i * 2 + 1] = order[j * 2 + 1];
		order[j * 2] = ty;
		order[j * 2 + 1] = tx;
	}
	return (long) k;
}

long cq_shuffled_modules(unsigned version, uint16_t *order, size_t max, void *work, size_t work_size)
{
	if (version < 1 || version > 40)
		return -1;
	unsigned n = cq_qr_size(version);
	if (work_size < (size_t) n * n)
		return -1;
	cq_qr_function_mask(version, work);
	if ((size_t) cq_qr_data_modules(version, work) > max)
		return -1;
	return shuffled(version, work, order);
}

/* ---- geometry ---- */

typedef struct { float a, b, c, d, e, f, g, h, scale; } homog;

static int homography(const float c[4][2], unsigned n, homog *H)
{
	double x0 = c[0][0], y0 = c[0][1], x1 = c[1][0], y1 = c[1][1];
	double x2 = c[2][0], y2 = c[2][1], x3 = c[3][0], y3 = c[3][1];
	double dx1 = x1 - x2, dx2 = x3 - x2, sx = x0 - x1 + x2 - x3;
	double dy1 = y1 - y2, dy2 = y3 - y2, sy = y0 - y1 + y2 - y3;
	double den = dx1 * dy2 - dx2 * dy1;
	if (den > -1e-9 && den < 1e-9)
		return -1;
	double g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den;
	H->g = (float) g;
	H->h = (float) h;
	H->a = (float) (x1 - x0 + g * x1);
	H->b = (float) (x3 - x0 + h * x3);
	H->c = (float) x0;
	H->d = (float) (y1 - y0 + g * y1);
	H->e = (float) (y3 - y0 + h * y3);
	H->f = (float) y0;
	H->scale = 1.0f / (float) n;
	return 0;
}

static inline void project(const homog *H, float mx, float my, float *px, float *py)
{
	float u = H->scale * mx, v = H->scale * my;
	float w = H->g * u + H->h * v + 1;
	if (w < 1e-6f && w > -1e-6f)   /* a degenerate grid: any finite answer will fail later */
		w = 1e-6f;
	w = 1 / w;
	*px = (H->a * u + H->b * v + H->c) * w;
	*py = (H->d * u + H->e * v + H->f) * w;
}

static inline float bilinear(const float *img, unsigned w, unsigned h, float x, float y)
{
	x -= 0.5f;
	y -= 0.5f;
	float mx = (float) w - 1.001f, my = (float) h - 1.001f;
	if (!(x > 0)) x = 0;       /* written so a NaN lands on 0 */
	if (!(y > 0)) y = 0;
	if (x > mx) x = mx;
	if (y > my) y = my;
	unsigned xi = (unsigned) x, yi = (unsigned) y;
	float fx = x - (float) xi, fy = y - (float) yi;
	const float *p = img + (size_t) yi * w + xi;
	float top = p[0] * (1 - fx) + p[1] * fx;
	float bot = p[w] * (1 - fx) + p[w + 1] * fx;
	return top * (1 - fy) + bot * fy;
}

/* Box blur with edges clamped, in integers. */
static void box_blur(uint16_t *img, unsigned w, unsigned h, int r, uint16_t *line)
{
	const uint32_t scale = 65536u / (uint32_t) (2 * r + 1);
	for (int pass = 0; pass < BLUR_PASSES; pass++) {
		for (int axis = 0; axis < 2; axis++) {
			unsigned count = axis ? w : h, len = axis ? h : w;
			size_t stride = axis ? w : 1, next = axis ? 1 : w;
			for (unsigned l = 0; l < count; l++) {
				uint16_t *p = img + l * next;
				uint32_t sum = 0;
				for (int i = -r; i <= r; i++) {
					int at = i < 0 ? 0 : (i >= (int) len ? (int) len - 1 : i);
					sum += p[at * stride];
				}
				for (unsigned i = 0; i < len; i++) {
					line[i] = (uint16_t) (((uint64_t) sum * scale) >> 16);
					int out = (int) i - r, in = (int) i + r + 1;
					out = out < 0 ? 0 : out;
					in = in >= (int) len ? (int) len - 1 : in;
					sum += (uint32_t) p[in * stride] - p[out * stride];
				}
				for (unsigned i = 0; i < len; i++)
					p[i * stride] = line[i];
			}
		}
	}
}

/* Refinement samples the blurred image in integers: this CPU has no integer divide, and its float
 * divides and conversions are slow. Positions are 16.16 fixed point, in pixels from the first
 * pixel's centre. */
typedef struct {
	const uint16_t *soft;
	unsigned w, h, n, count;
	const uint32_t *mods;     /* module index, for a partial set */
	const float *mx, *my;     /* its centre, in modules */
	const int8_t *sign;       /* per module of n*n: +1 light, -1 dark, for the full set */
	int64_t wsum;             /* sum of the signs in use */
	int full;                 /* every module, in row order */
} score_ctx;

static inline uint32_t sample_fixed(const score_ctx *c, int32_t x, int32_t y)
{
	int32_t mx = (int32_t) ((c->w - 1) << 16) - 1, my = (int32_t) ((c->h - 1) << 16) - 1;
	x = x < 0 ? 0 : (x > mx ? mx : x);
	y = y < 0 ? 0 : (y > my ? my : y);
	uint32_t fx = ((uint32_t) x >> 8) & 255, fy = ((uint32_t) y >> 8) & 255;
	const uint16_t *p = c->soft + (size_t) ((uint32_t) y >> 16) * c->w + ((uint32_t) x >> 16);
	uint32_t top = p[0] * (256 - fx) + p[1] * fx;
	uint32_t bot = p[c->w] * (256 - fx) + p[c->w + 1] * fx;
	return (top * (256 - fy) + bot * fy) >> 16;
}

static inline int32_t to_fixed(float v)
{
	v -= 0.5f;                 /* pixel centres */
	if (!(v > -16383.0f))      /* also catches NaN. This range keeps differences within 32 bits. */
		v = -16383.0f;
	if (v > 16383.0f)
		v = 16383.0f;
	return (int32_t) (v * 65536.0f);
}

#define LOCAL_FROM 97            /* symbol side from which the local correction runs: version 20 */
#define LOCAL_TILE 24            /* modules */
#define LOCAL_MAX 8              /* largest shift, in quarter pixels */
#define SPAN 4                 /* modules between exact projections: 8 lost codes */

/* Large symbols: a lens is not quite a homography, and the shift reaches a good part of a module at
 * the corners. Each tile of about LOCAL_TILE modules finds its own small shift against the known
 * symbol, and shifts are interpolated between tile centres. */
static int local_field(const score_ctx *c, const homog *H, float *ox, float *oy, cq_arena *a)
{
	unsigned n = c->n, nt = n / LOCAL_TILE, ts = n / nt;
	int32_t *px = cq_alloc(a, (size_t) n * n, sizeof *px), *py = cq_alloc(a, (size_t) n * n, sizeof *py);
	float *tx = cq_alloc(a, (size_t) nt * nt, sizeof *tx), *ty = cq_alloc(a, (size_t) nt * nt, sizeof *ty);
	if (!px || !py || !tx || !ty)
		return CQ_ERR_NOMEM;
	for (unsigned y = 0; y < n; y++) {
		for (unsigned x = 0; x < n; x++) {
			float fx, fy;
			project(H, (float) x + 0.5f, (float) y + 0.5f, &fx, &fy);
			px[y * n + x] = to_fixed(fx);
			py[y * n + x] = to_fixed(fy);
		}
	}
	for (unsigned ti = 0; ti < nt; ti++) {
		for (unsigned tj = 0; tj < nt; tj++) {
			unsigned y0 = ti * ts, x0 = tj * ts;
			unsigned y1 = ti + 1 == nt ? n : y0 + ts, x1 = tj + 1 == nt ? n : x0 + ts;
			int64_t wsum = 0;
			for (unsigned y = y0; y < y1; y++)
				for (unsigned x = x0; x < x1; x++)
					wsum += c->sign[y * n + x];
			uint32_t count = (y1 - y0) * (x1 - x0);
			int cx = 0, cy = 0;          /* in quarter pixels */
			double best = -1e30;
			/* half-pixel steps until it settles, then one round of quarter-pixel steps */
			for (int round = 0; round < 4; round++) {
				int step = round < 3 ? 2 : 1, moved = 0, bx = cx, by = cy;
				for (int dy = -step; dy <= step; dy += step) {
					for (int dx = -step; dx <= step; dx += step) {
						int sx = cx + dx, sy = cy + dy;
						if (sx < -LOCAL_MAX || sx > LOCAL_MAX || sy < -LOCAL_MAX || sy > LOCAL_MAX)
							continue;
						int64_t total = 0, dot = 0;
						int32_t ax = sx * (1 << 14), ay = sy * (1 << 14);
						for (unsigned y = y0; y < y1; y++) {
							for (unsigned x = x0; x < x1; x++) {
								int32_t v = (int32_t) sample_fixed(c, px[y * n + x] + ax, py[y * n + x] + ay);
								total += v;
								dot += v * c->sign[y * n + x];
							}
						}
						double v = (double) dot - (double) total / count * (double) wsum;
						if (v > best) {
							best = v;
							bx = sx;
							by = sy;
							moved = 1;
						}
					}
				}
				cx = bx;
				cy = by;
				if (!moved && round < 2)
					round = 2;
			}
			tx[ti * nt + tj] = (float) cx * 0.25f;
			ty[ti * nt + tj] = (float) cy * 0.25f;
		}
	}
	/* bilinear between tile centres, flat beyond the outermost ones */
	float scale = 1.0f / (float) ts;
	for (unsigned y = 0; y < n; y++) {
		float gy = ((float) y + 0.5f) * scale - 0.5f;
		gy = gy < 0 ? 0 : (gy > (float) (nt - 1) ? (float) (nt - 1) : gy);
		unsigned i0 = (unsigned) gy, i1 = i0 + 1 < nt ? i0 + 1 : i0;
		float ry = gy - (float) i0;
		for (unsigned x = 0; x < n; x++) {
			float gx = ((float) x + 0.5f) * scale - 0.5f;
			gx = gx < 0 ? 0 : (gx > (float) (nt - 1) ? (float) (nt - 1) : gx);
			unsigned j0 = (unsigned) gx, j1 = j0 + 1 < nt ? j0 + 1 : j0;
			float rx = gx - (float) j0;
			float a0 = tx[i0 * nt + j0] * (1 - rx) + tx[i0 * nt + j1] * rx;
			float a1 = tx[i1 * nt + j0] * (1 - rx) + tx[i1 * nt + j1] * rx;
			float b0 = ty[i0 * nt + j0] * (1 - rx) + ty[i0 * nt + j1] * rx;
			float b1 = ty[i1 * nt + j0] * (1 - rx) + ty[i1 * nt + j1] * rx;
			ox[y * n + x] = a0 * (1 - ry) + a1 * ry;
			oy[y * n + x] = b0 * (1 - ry) + b1 * ry;
		}
	}
	return 0;
}

static double score(const score_ctx *c, const float corners[4][2])
{
	homog H;
	if (homography(corners, c->n, &H))
		return -1e30;
	int64_t total = 0, dot = 0;
	unsigned n = c->n;
	if (c->full) {
		/* along a row a homography is nearly linear: exact every SPAN modules, stepped in between */
		const int8_t *sign = c->sign;
		for (unsigned y = 0; y < n; y++) {
			float yc = (float) y + 0.5f, px, py;
			project(&H, 0.5f, yc, &px, &py);
			int32_t x0 = to_fixed(px), y0 = to_fixed(py);
			for (unsigned xs = 0; xs < n; xs += SPAN) {
				project(&H, (float) (xs + SPAN) + 0.5f, yc, &px, &py);
				int32_t x1 = to_fixed(px), y1 = to_fixed(py);
				int32_t dx = (x1 - x0) / SPAN, dy = (y1 - y0) / SPAN, fx = x0, fy = y0;
				unsigned stop = xs + SPAN < n ? xs + SPAN : n;
				for (unsigned x = xs; x < stop; x++) {
					int32_t v = (int32_t) sample_fixed(c, fx, fy);
					total += v;
					dot += v * sign[y * n + x];
					fx += dx;
					fy += dy;
				}
				x0 = x1;
				y0 = y1;
			}
		}
	} else {
		for (unsigned i = 0; i < c->count; i++) {
			float px, py;
			project(&H, c->mx[i], c->my[i], &px, &py);
			int32_t v = (int32_t) sample_fixed(c, to_fixed(px), to_fixed(py));
			total += v;
			dot += v * c->sign[c->mods[i]];
		}
	}
	return (double) dot - (double) total / c->count * (double) c->wsum;
}

/* Coordinate descent on the corners. The image must be blurred: see colorqr/geometry.py. */
static void refine(const score_ctx *ctx, float c[4][2], float first_step, float stop)
{
	double best = score(ctx, c);
	float dx = c[1][0] - c[0][0], dy = c[1][1] - c[0][1];
	float step = cq_sqrt(dx * dx + dy * dy) / (float) ctx->n * first_step;
	unsigned passes = 0;
	while (step > stop && passes++ < MAX_REFINE_PASSES) {
		int moved = 0;
		for (int i = 0; i < 8; i++) {
			for (int sign = 1; sign >= -1; sign -= 2) {
				float keep = c[i / 2][i % 2];
				c[i / 2][i % 2] = keep + (float) sign * step;
				double v = score(ctx, c);
				if (v > best) {
					best = v;
					moved = 1;
				} else {
					c[i / 2][i % 2] = keep;
				}
			}
		}
		if (!moved)
			step *= 0.5f;
	}
}

static const float tap_x[5] = {0, TAP, -TAP, TAP, -TAP}, tap_y[5] = {0, TAP, TAP, -TAP, -TAP};

/* Average of five taps around each module centre. */
static void sample_gray(const float *img, unsigned w, unsigned h, const homog *H, unsigned n, float *out)
{
	for (unsigned y = 0; y < n; y++) {
		for (unsigned x = 0; x < n; x++) {
			float acc = 0;
			for (int t = 0; t < 5; t++) {
				float px, py;
				project(H, (float) x + 0.5f + tap_x[t], (float) y + 0.5f + tap_y[t], &px, &py);
				acc += bilinear(img, w, h, px, py);
			}
			out[y * n + x] = acc / 5;
		}
	}
}

static inline void rgb_at(const uint8_t *p, unsigned stride, const float *lut, unsigned w, unsigned h,
                          float px, float py, float *out)
{
	float mx = (float) w - 1.001f, my = (float) h - 1.001f;
	px -= 0.5f;
	py -= 0.5f;
	if (!(px > 0)) px = 0;
	if (!(py > 0)) py = 0;
	if (px > mx) px = mx;
	if (py > my) py = my;
	unsigned xi = (unsigned) px, yi = (unsigned) py;
	float fx = px - (float) xi, fy = py - (float) yi;
	const uint8_t *a = p + (size_t) yi * stride + (size_t) xi * 3, *b = a + stride;
	for (int c = 0; c < 3; c++) {
		float top = lut[a[c]] * (1 - fx) + lut[a[c + 3]] * fx;
		float bot = lut[b[c]] * (1 - fx) + lut[b[c + 3]] * fx;
		out[c] += top * (1 - fy) + bot * fy;
	}
}

/* Same, from the 8-bit input through the lookup table. p points at the crop's first pixel. */
static void sample_rgb(const uint8_t *p, unsigned stride, const float *lut, unsigned w, unsigned h,
                       const homog *H, unsigned n, const float *ox, const float *oy, float *out)
{
	for (unsigned y = 0; y < n; y++) {
		for (unsigned x = 0; x < n; x++) {
			float acc[3] = {0, 0, 0};
			for (int t = 0; t < 5; t++) {
				float px, py;
				project(H, (float) x + 0.5f + tap_x[t], (float) y + 0.5f + tap_y[t], &px, &py);
				if (ox) {
					px += ox[y * n + x];
					py += oy[y * n + x];
				}
				rgb_at(p, stride, lut, w, h, px, py, acc);
			}
			for (int c = 0; c < 3; c++)
				out[(size_t) (y * n + x) * 3 + c] = acc[c] / 5;
		}
	}
}

/* How coloured the header modules are: mean |R - B| after balancing on the white modules. Header
 * colours differ strongly in R - B, and a plain QR code has none, so this needs no refinement. */
static float header_chroma(const uint8_t *p, unsigned stride, const float *lut, unsigned w, unsigned h,
                           const homog *H, unsigned n, const uint8_t *known, const uint8_t *kdark,
                           const uint16_t *order)
{
	float white[3] = {0, 0, 0}, black[3] = {0, 0, 0};
	unsigned nw = 0, nd = 0;
	for (unsigned y = 0; y < n; y++) {
		for (unsigned x = 0; x < n; x++) {
			if (!known[y * n + x])
				continue;
			float px, py;
			project(H, (float) x + 0.5f, (float) y + 0.5f, &px, &py);
			if (kdark[y * n + x]) {
				rgb_at(p, stride, lut, w, h, px, py, black);
				nd++;
			} else {
				rgb_at(p, stride, lut, w, h, px, py, white);
				nw++;
			}
		}
	}
	float br = black[0] / (float) nd, bb = black[2] / (float) nd;
	float sr = white[0] / (float) nw - br, sb = white[2] / (float) nw - bb;
	sr = sr < 1e-3f ? 1e-3f : sr;
	sb = sb < 1e-3f ? 1e-3f : sb;
	float sum = 0;
	for (unsigned i = 0; i < CQ_HEADER_MODULES; i++) {
		float px, py, v[3] = {0, 0, 0};
		project(H, (float) order[i * 2 + 1] + 0.5f, (float) order[i * 2] + 0.5f, &px, &py);
		rgb_at(p, stride, lut, w, h, px, py, v);
		float d = (v[0] - br) / sr - (v[2] - bb) / sb;
		sum += d < 0 ? -d : d;
	}
	return sum / CQ_HEADER_MODULES;
}

/* ---- small linear algebra, in double because normal equations are ill conditioned ---- */

/* Solves A X = B for symmetric positive definite A (size NF), B has 3 columns, in place. */
static int cholesky_solve(double A[NF][NF], double B[NF][3])
{
	for (int i = 0; i < NF; i++) {
		for (int j = 0; j <= i; j++) {
			double s = A[i][j];
			for (int k = 0; k < j; k++)
				s -= A[i][k] * A[j][k];
			if (i == j) {
				if (s <= 0)
					return -1;
				/* double sqrt by Newton, seeded in single precision */
				double r = cq_sqrt((float) s);
				r = 0.5 * (r + s / r);
				r = 0.5 * (r + s / r);
				A[i][i] = r;
			} else {
				A[i][j] = s / A[j][j];
			}
		}
	}
	for (int c = 0; c < 3; c++) {
		for (int i = 0; i < NF; i++) {
			double s = B[i][c];
			for (int k = 0; k < i; k++)
				s -= A[i][k] * B[k][c];
			B[i][c] = s / A[i][i];
		}
		for (int i = NF - 1; i >= 0; i--) {
			double s = B[i][c];
			for (int k = i + 1; k < NF; k++)
				s -= A[k][i] * B[k][c];
			B[i][c] = s / A[i][i];
		}
	}
	return 0;
}

static inline void features(const float *c, const float *nb, float x, float y, float *f)
{
	f[0] = c[0]; f[1] = c[1]; f[2] = c[2];
	f[3] = nb[0]; f[4] = nb[1]; f[5] = nb[2];
	f[6] = 1; f[7] = x; f[8] = y;
	f[9] = x * c[0]; f[10] = x * c[1]; f[11] = x * c[2];
	f[12] = y * c[0]; f[13] = y * c[1]; f[14] = y * c[2];
}

static inline void accumulate(double A[NF][NF], double B[NF][3], const float *f, const float *t)
{
	double v[NF], u[3] = {t[0], t[1], t[2]};
	for (int i = 0; i < NF; i++)
		v[i] = f[i];
	for (int i = 0; i < NF; i++) {
		double vi = v[i], *row = A[i];
		for (int j = 0; j <= i; j++)
			row[j] += vi * v[j];
		B[i][0] += vi * u[0];
		B[i][1] += vi * u[1];
		B[i][2] += vi * u[2];
	}
}

/* ---- colour likelihoods ---- */

typedef struct {
	unsigned count;           /* modules listed */
	const uint16_t *order;    /* row, col pairs */
	const uint8_t *dark;      /* n*n */
	const float *samples;     /* n*n*3 */
	const float *nb;          /* n*n*3: mean of the 4 neighbours */
	unsigned n, colours, npilot;
	const uint8_t *pal[2];    /* [0] light, [1] dark: colours*3 */
} demod_ctx;

/* Log-likelihood of each colour for each module, `count` * `colours` floats. */
static int demodulate(const demod_ctx *d, const uint8_t *anchors, float *ll, cq_arena *a)
{
	unsigned K = d->count, n = d->colours, N = d->n;
	uint8_t *labels = cq_alloc(a, K, 1);
	float *o = cq_alloc(a, (size_t) K * 3, sizeof *o);
	float *dist = cq_alloc(a, (size_t) K * n, sizeof *dist);
	double (*Aa)[NF][NF] = cq_alloc(a, 2, sizeof *Aa);
	double (*Ba)[NF][3] = cq_alloc(a, 2, sizeof *Ba);
	double (*A)[NF] = cq_alloc(a, NF, sizeof *A);
	double (*B)[3] = cq_alloc(a, NF, sizeof *B);
	float (*pal)[8][3] = cq_alloc(a, 2, sizeof *pal);
	uint8_t *pilot = cq_alloc(a, d->npilot + 1u, 1);
	uint32_t *list = cq_alloc(a, K, sizeof *list);
	if (!list || !labels || !o || !dist || !Aa || !Ba || !A || !B || !pal || !pilot)
		return CQ_ERR_NOMEM;

	for (int k = 0; k < 2; k++)
		for (unsigned c = 0; c < n; c++)
			for (int v = 0; v < 3; v++)
				pal[k][c][v] = (float) d->pal[k][c * 3 + v] / 255.0f;

	unsigned counter[2] = {0, 0};
	for (unsigned i = 0; i < d->npilot; i++) {
		int cls = d->dark[d->order[i * 2] * N + d->order[i * 2 + 1]] != 0;
		pilot[i] = (uint8_t) (counter[cls]++ % n);
		labels[i] = pilot[i];
	}
	memset(labels + d->npilot, 0, K - d->npilot);

	/* Black and white function modules anchor the fit; they never change, so sum them once. */
	memset(Aa, 0, 2 * sizeof *Aa);
	memset(Ba, 0, 2 * sizeof *Ba);
	for (unsigned y = 0; y < N; y++) {
		for (unsigned x = 0; x < N; x++) {
			if (!anchors[y * N + x])
				continue;
			int cls = d->dark[y * N + x] != 0;
			float f[NF], t[3] = {cls ? 0.0f : 1.0f, cls ? 0.0f : 1.0f, cls ? 0.0f : 1.0f};
			features(d->samples + (size_t) (y * N + x) * 3, d->nb + (size_t) (y * N + x) * 3,
			         (float) x / (float) N - 0.5f, (float) y / (float) N - 0.5f, f);
			accumulate(Aa[cls], Ba[cls], f, t);
		}
	}

	for (int it = 0; it < DEMOD_ITERS; it++) {
		for (int cls = 0; cls < 2; cls++) {
			memcpy(A, Aa[cls], NF * sizeof *A);
			memcpy(B, Ba[cls], NF * sizeof *B);
			unsigned train = it == 0 ? d->npilot : K;
			for (unsigned i = 0; i < train; i++) {
				unsigned y = d->order[i * 2], x = d->order[i * 2 + 1];
				if ((d->dark[y * N + x] != 0) != cls)
					continue;
				float f[NF];
				features(d->samples + (size_t) (y * N + x) * 3, d->nb + (size_t) (y * N + x) * 3,
				         (float) x / (float) N - 0.5f, (float) y / (float) N - 0.5f, f);
				accumulate(A, B, f, pal[cls][labels[i]]);
			}
			for (int i = 0; i < NF; i++)
				A[i][i] += 1e-3;
			if (cholesky_solve(A, B))
				return CQ_ERR_PAYLOAD;

			float X[NF][3];
			for (int i = 0; i < NF; i++)
				for (int c = 0; c < 3; c++)
					X[i][c] = (float) B[i][c];

			/* corrected colours, and distance to each palette colour */
			unsigned members = 0;
			for (unsigned i = 0; i < K; i++) {
				unsigned y = d->order[i * 2], x = d->order[i * 2 + 1];
				if ((d->dark[y * N + x] != 0) != cls)
					continue;
				list[members++] = i;
				float f[NF], *oi = o + (size_t) i * 3;
				features(d->samples + (size_t) (y * N + x) * 3, d->nb + (size_t) (y * N + x) * 3,
				         (float) x / (float) N - 0.5f, (float) y / (float) N - 0.5f, f);
				float best = 1e30f;
				for (int c = 0; c < 3; c++) {
					float s = 0;
					for (int j = 0; j < NF; j++)
						s += f[j] * X[j][c];
					oi[c] = s;
				}
				float *di = dist + (size_t) i * n;
				for (unsigned k = 0; k < n; k++) {
					float e0 = oi[0] - pal[cls][k][0], e1 = oi[1] - pal[cls][k][1], e2 = oi[2] - pal[cls][k][2];
					di[k] = e0 * e0 + e1 * e1 + e2 * e2;
					if (di[k] < best) {
						best = di[k];
						labels[i] = (uint8_t) k;
					}
				}
			}
			if (it == 0)
				continue;

			/* one Gaussian per colour, seeded by the nearest palette colour */
			double m[8][3], C[8][6];
			unsigned count[8];
			memset(m, 0, sizeof m);
			memset(C, 0, sizeof C);
			memset(count, 0, sizeof count);
			for (unsigned q = 0; q < members; q++) {
				unsigned i = list[q], k = labels[i];
				const float *oi = o + (size_t) i * 3;
				count[k]++;
				m[k][0] += oi[0];
				m[k][1] += oi[1];
				m[k][2] += oi[2];
			}
			for (unsigned k = 0; k < n; k++)
				if (count[k])
					for (int c = 0; c < 3; c++)
						m[k][c] /= count[k];
			for (unsigned q = 0; q < members; q++) {
				unsigned i = list[q], k = labels[i];
				const float *oi = o + (size_t) i * 3;
				double e0 = oi[0] - m[k][0], e1 = oi[1] - m[k][1], e2 = oi[2] - m[k][2], *c = C[k];
				c[0] += e0 * e0; c[1] += e0 * e1; c[2] += e0 * e2;
				c[3] += e1 * e1; c[4] += e1 * e2; c[5] += e2 * e2;
			}
			float I[8][6], norm[8], mf[8][3];
			int usable[8];
			for (unsigned k = 0; k < n; k++) {
				usable[k] = count[k] >= 8;
				if (!usable[k])
					continue;
				double *c = C[k];
				for (int v = 0; v < 6; v++)
					c[v] /= count[k] - 1;
				c[0] += 2e-4; c[3] += 2e-4; c[5] += 2e-4;
				double c00 = c[3] * c[5] - c[4] * c[4];
				double c01 = c[2] * c[4] - c[1] * c[5];
				double c02 = c[1] * c[4] - c[2] * c[3];
				double det = c[0] * c00 + c[1] * c01 + c[2] * c02;
				if (det <= 0) {
					usable[k] = 0;
					continue;
				}
				I[k][0] = (float) (c00 / det); I[k][1] = (float) (c01 / det); I[k][2] = (float) (c02 / det);
				I[k][3] = (float) ((c[0] * c[5] - c[2] * c[2]) / det);
				I[k][4] = (float) ((c[1] * c[2] - c[0] * c[4]) / det);
				I[k][5] = (float) ((c[0] * c[3] - c[1] * c[1]) / det);
				norm[k] = -0.5f * cq_ln((float) det) + cq_ln((float) count[k] / (float) members + 1e-6f);
				for (int v = 0; v < 3; v++)
					mf[k][v] = (float) m[k][v];
			}
			for (unsigned q = 0; q < members; q++) {
				unsigned i = list[q];
				const float *oi = o + (size_t) i * 3;
				float *l = ll + (size_t) i * n;
				for (unsigned k = 0; k < n; k++) {
					if (!usable[k]) {
						l[k] = -dist[(size_t) i * n + k] * 50;
						continue;
					}
					const float *J = I[k];
					float e0 = oi[0] - mf[k][0], e1 = oi[1] - mf[k][1], e2 = oi[2] - mf[k][2];
					float qf = J[0] * e0 * e0 + J[3] * e1 * e1 + J[5] * e2 * e2
					         + 2 * (J[1] * e0 * e1 + J[2] * e0 * e2 + J[4] * e1 * e2);
					l[k] = -0.5f * qf + norm[k];
				}
			}
		}
		/* new labels from the likelihoods, pilots back to their known values */
		if (it >= 1) {
			for (unsigned i = 0; i < K; i++) {
				const float *l = ll + (size_t) i * n;
				unsigned b = 0;
				for (unsigned k = 1; k < n; k++)
					if (l[k] > l[b])
						b = k;
				labels[i] = (uint8_t) b;
			}
		}
		memcpy(labels, pilot, d->npilot);
	}
	return 0;
}

static inline float logsum(float a, float b)
{
	float hi = a > b ? a : b, d = a > b ? a - b : b - a;
	if (d >= 6)        /* also keeps the cast below in range */
		return hi;
	return hi + cq_logsum_corr[(unsigned) (d * 4 + 0.5f)];
}

static void bit_llrs(const float *ll, unsigned count, unsigned bits, float *out)
{
	unsigned n = 1u << bits;
	for (unsigned i = 0; i < count; i++) {
		const float *l = ll + (size_t) i * n;
		float top = l[0];
		for (unsigned k = 1; k < n; k++)
			if (l[k] > top)
				top = l[k];
		for (unsigned b = 0; b < bits; b++) {
			float s0 = -1e30f, s1 = -1e30f;
			for (unsigned k = 0; k < n; k++) {
				float v = (l[k] - top) * LLR_SCALE;
				if ((k >> (bits - 1 - b)) & 1)
					s1 = logsum(s1, v);
				else
					s0 = logsum(s0, v);
			}
			float r = s0 - s1;
			out[(size_t) i * bits + b] = r > LLR_CLIP ? LLR_CLIP : (r < -LLR_CLIP ? -LLR_CLIP : r);
		}
	}
}

static uint32_t crc32_bytes(const uint8_t *p, size_t len)
{
	uint32_t c = 0xFFFFFFFFu;
	for (size_t i = 0; i < len; i++) {
		c ^= p[i];
		for (int b = 0; b < 8; b++)
			c = (c >> 1) ^ (0xEDB88320u & (0u - (c & 1u)));
	}
	return ~c;
}

#ifdef CQ_TESTING
float *cq_test_llr, *cq_test_ll;
float cq_test_chroma;
int cq_test_ra(const float *llr, uint32_t n, uint32_t k, uint8_t *info, unsigned *it, void *work, size_t size)
{
	cq_arena a = {work, size, 0, 0};
	return cq_ra_decode(llr, n, k, info, it, &a);
}
#endif

/* ---- the reader ---- */

static int rebuild_base(const float *g, const uint8_t *known, const uint8_t *kdark, unsigned version,
                        uint8_t *matrix, cq_arena *a)
{
	unsigned n = cq_qr_size(version);
	/* mid-level between black and white function modules, as a plane */
	double planes[2][3];
	for (int cls = 0; cls < 2; cls++) {
		double M[3][4] = {{0}};
		for (unsigned y = 0; y < n; y++) {
			for (unsigned x = 0; x < n; x++) {
				if (!known[y * n + x] || (kdark[y * n + x] != 0) != cls)
					continue;
				double r[3] = {(double) x / n - 0.5, (double) y / n - 0.5, 1};
				for (int i = 0; i < 3; i++) {
					for (int j = 0; j < 3; j++)
						M[i][j] += r[i] * r[j];
					M[i][3] += r[i] * g[y * n + x];
				}
			}
		}
		for (int i = 0; i < 3; i++) {
			int p = i;
			for (int r = i + 1; r < 3; r++)
				if ((M[r][i] < 0 ? -M[r][i] : M[r][i]) > (M[p][i] < 0 ? -M[p][i] : M[p][i]))
					p = r;
			if (M[p][i] == 0)
				return CQ_ERR_BASE;
			for (int c = 0; c < 4; c++) {
				double t = M[i][c];
				M[i][c] = M[p][c];
				M[p][c] = t;
			}
			for (int r = 0; r < 3; r++) {
				if (r == i)
					continue;
				double f = M[r][i] / M[i][i];
				for (int c = i; c < 4; c++)
					M[r][c] -= f * M[i][c];
			}
		}
		for (int i = 0; i < 3; i++)
			planes[cls][i] = M[i][3] / M[i][i];
	}
	float contrast = (float) (planes[0][2] - planes[1][2]);   /* light minus dark */
	uint8_t *bits = cq_alloc(a, (size_t) n * n, 1);
	if (!bits)
		return CQ_ERR_NOMEM;
	static const float shifts[5] = {0, 0.06f, -0.06f, 0.12f, -0.12f};
	for (int s = 0; s < 5; s++) {
		for (unsigned y = 0; y < n; y++) {
			for (unsigned x = 0; x < n; x++) {
				float X = (float) x / (float) n - 0.5f, Y = (float) y / (float) n - 0.5f;
				float mid = 0.5f * (float) (planes[0][0] + planes[1][0]) * X
				          + 0.5f * (float) (planes[0][1] + planes[1][1]) * Y
				          + 0.5f * (float) (planes[0][2] + planes[1][2]);
				bits[y * n + x] = g[y * n + x] < mid + shifts[s] * contrast;
			}
		}
		size_t mark = a->used;
		int r = cq_qr_recover(bits, version, matrix, a);
		a->used = mark;
		if (r != CQ_ERR_BASE)
			return r;
	}
	return CQ_ERR_BASE;
}

/* All turns the same way. Mirrored symbols wind backwards, and are fine. */
static int convex(const float c[4][2])
{
	int pos = 0, neg = 0;
	for (int i = 0; i < 4; i++) {
		const float *a = c[i], *b = c[(i + 1) & 3], *d = c[(i + 2) & 3];
		float t = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0]);
		pos += t > 0;
		neg += t < 0;
	}
	return pos == 4 || neg == 4;
}

/* A supplied base must agree with the frame: dark modules darker than average, light ones lighter. */
static int matches_frame(const float *g, const uint8_t *dark, unsigned n)
{
	double mean = 0;
	for (unsigned i = 0; i < n * n; i++)
		mean += g[i];
	mean /= n * n;
	unsigned wrong = 0;
	for (unsigned i = 0; i < n * n; i++)
		wrong += (g[i] < mean) != (dark[i] != 0);
	return wrong < n * n / 4;
}

static cq_status decode(const uint8_t *rgb, unsigned width, unsigned height, unsigned stride,
                        const float corners[4][2], unsigned version, const cq_base *base, unsigned flags,
                        void *work, size_t work_size, cq_result *r)
{
	if (!rgb || !corners || !work || !r || version < 1 || version > 40
	    || width < 8 || height < 8 || width > 16384 || height > 16384 || stride < width * 3)
		return CQ_ERR_ARGS;
	r->payload_len = 0;
	r->work_used = 0;
	r->iterations = 0;
	cq_arena arena = {work, work_size, 0, 0}, *a = &arena;
	cq_status status = CQ_ERR_NOMEM;
	unsigned n = cq_qr_size(version);

	float c[4][2];
	float minx = 1e30f, miny = 1e30f, maxx = -1e30f, maxy = -1e30f;
	for (int i = 0; i < 4; i++) {
		float x = corners[i][0], y = corners[i][1];
		if (!(x > -1e6f && x < 1e6f && y > -1e6f && y < 1e6f))   /* also rejects NaN */
			return CQ_ERR_ARGS;
		minx = x < minx ? x : minx; maxx = x > maxx ? x : maxx;
		miny = y < miny ? y : miny; maxy = y > maxy ? y : maxy;
	}
	if (!convex(corners))
		return CQ_ERR_ARGS;
	float ex = corners[1][0] - corners[0][0], ey = corners[1][1] - corners[0][1];
	float modpx = cq_sqrt(ex * ex + ey * ey) / (float) n;
	if (modpx < 0.5f || modpx > 1000)
		return CQ_ERR_ARGS;

	/* the symbol's bounding box, three modules wider */
	int margin = (int) (modpx * 3);
	int x0 = (int) minx - margin, y0 = (int) miny - margin;
	int x1 = (int) maxx + margin, y1 = (int) maxy + margin;
	x0 = x0 < 0 ? 0 : x0;
	y0 = y0 < 0 ? 0 : y0;
	x1 = x1 > (int) width ? (int) width : x1;
	y1 = y1 > (int) height ? (int) height : y1;
	if (x1 - x0 < 4 || y1 - y0 < 4)
		return CQ_ERR_ARGS;
	unsigned cw = (unsigned) (x1 - x0), ch = (unsigned) (y1 - y0);
	size_t pixels = (size_t) cw * ch;
	for (int i = 0; i < 4; i++) {
		c[i][0] = corners[i][0] - (float) x0;
		c[i][1] = corners[i][1] - (float) y0;
	}

	float *lut = cq_alloc(a, 256, sizeof *lut);
	float *gray = cq_alloc(a, pixels, sizeof *gray);
	uint16_t *soft = cq_alloc(a, pixels, sizeof *soft);
	uint16_t *line = cq_alloc(a, cw > ch ? cw : ch, sizeof *line);
	uint8_t *known = cq_alloc(a, (size_t) n * n, 1), *kdark = cq_alloc(a, (size_t) n * n, 1);
	uint8_t *dark = cq_alloc(a, (size_t) n * n, 1), *fn = cq_alloc(a, (size_t) n * n, 1);
	uint32_t *mods = cq_alloc(a, (size_t) n * n, sizeof *mods);
	float *mx = cq_alloc(a, (size_t) n * n, sizeof *mx), *my = cq_alloc(a, (size_t) n * n, sizeof *my);
	int8_t *sign = cq_alloc(a, (size_t) n * n, 1);
	float *g = cq_alloc(a, (size_t) n * n, sizeof *g);
	float *s = cq_alloc(a, (size_t) n * n * 3, sizeof *s);
	float *nb = cq_alloc(a, (size_t) n * n * 3, sizeof *nb);
	uint16_t *order = cq_alloc(a, (size_t) n * n * 2, sizeof *order);
	if (!lut || !gray || !soft || !line || !known || !kdark || !dark || !fn
	    || !mods || !mx || !my || !sign || !g || !s || !nb || !order)
		goto done;

	STAGE(0);
	for (int i = 0; i < 256; i++) {
		float v = (float) i / 255.0f;
		lut[i] = (flags & CQ_FLAG_LINEAR) ? cq_sqrt(v) : v;
	}
	const uint8_t *crop = rgb + (size_t) y0 * stride + (size_t) x0 * 3;

	/* the common case, a plain QR code, is settled here for very little */
	cq_qr_template(version, known, kdark);
	cq_qr_function_mask(version, fn);
	long K = shuffled(version, fn, order);
	homog H;
	if (K <= CQ_HEADER_MODULES || homography(c, n, &H))
		goto no_colour;
	{
		float chroma = header_chroma(crop, stride, lut, cw, ch, &H, n, known, kdark, order);
#ifdef CQ_TESTING
		cq_test_chroma = chroma;
#endif
		if (chroma < PLAIN_CHROMA && !(flags & CQ_FLAG_NO_FAST_PATH))
			goto no_colour;
	}

	for (unsigned y = 0; y < ch; y++) {
		const uint8_t *p = crop + (size_t) y * stride;
		for (unsigned x = 0; x < cw; x++, p += 3) {
			size_t at = (size_t) y * cw + x;
			gray[at] = 0.25f * lut[p[0]] + 0.5f * lut[p[1]] + 0.25f * lut[p[2]];
			soft[at] = (uint16_t) (gray[at] * 65535.0f);
		}
	}
	STAGE(1);
	int blur = (int) (0.35f * modpx / 1.7f + 0.5f);
	box_blur(soft, cw, ch, blur < 1 ? 1 : blur, line);
	STAGE(2);

	/* corners from the function modules, then the exact symbol, then corners from all of it */
	unsigned count = 0;
	int64_t wsum = 0;
	for (unsigned y = 0; y < n; y++) {
		for (unsigned x = 0; x < n; x++) {
			unsigned i = y * n + x;
			sign[i] = kdark[i] ? -1 : 1;
			if (known[i]) {
				mods[count] = i;
				mx[count] = (float) x + 0.5f;
				my[count++] = (float) y + 0.5f;
				wsum += sign[i];
			}
		}
	}
	score_ctx sc = {soft, cw, ch, n, count, mods, mx, my, sign, wsum, 0};
	refine(&sc, c, 0.5f, STOP_FIRST);
	STAGE(3);

	if (homography(c, n, &H)) {
		status = CQ_ERR_BASE;
		goto done;
	}
	sample_gray(gray, cw, ch, &H, n, g);
	int e = CQ_ERR_BASE;
	if (base) {
		size_t mark = a->used;
		e = cq_qr_from_data(version, base->ecl, (unsigned) base->mask, base->data, base->data_len, dark, a);
		a->used = mark;
		if (!e && !matches_frame(g, dark, n))
			e = CQ_ERR_BASE;
	}
	if (e == CQ_ERR_BASE)
		e = rebuild_base(g, known, kdark, version, dark, a);
	if (e) {
		status = (cq_status) e;
		goto done;
	}
	STAGE(4);

	sc.wsum = 0;
	for (unsigned i = 0; i < n * n; i++) {
		sign[i] = dark[i] ? -1 : 1;
		sc.wsum += sign[i];
	}
	sc.count = n * n;
	sc.full = 1;
	refine(&sc, c, 0.125f, STOP_POLISH);   /* the grid is already found: this only polishes it */
	STAGE(5);
	if (homography(c, n, &H)) {
		status = CQ_ERR_BASE;
		goto done;
	}
	float *ox = NULL, *oy = NULL;
	if (n >= LOCAL_FROM && !(flags & CQ_FLAG_NO_LOCAL_GRID)) {
		ox = cq_alloc(a, (size_t) n * n, sizeof *ox);
		oy = cq_alloc(a, (size_t) n * n, sizeof *oy);
		if (!ox || !oy)
			goto done;
		size_t mark = a->used;
		e = local_field(&sc, &H, ox, oy, a);
		a->used = mark;
		if (e) {
			status = (cq_status) e;
			goto done;
		}
	}
	sample_rgb(crop, stride, lut, cw, ch, &H, n, ox, oy, s);
	STAGE(6);

	/* header: majority over its repeats of (R - B), normalised by black and white */
	{
		double black[3] = {0, 0, 0}, white[3] = {0, 0, 0};
		unsigned nb0 = 0, nw = 0;
		for (unsigned i = 0; i < n * n; i++) {
			if (!known[i])
				continue;
			double *m = kdark[i] ? black : white;
			if (kdark[i]) nb0++; else nw++;
			for (int v = 0; v < 3; v++)
				m[v] += s[(size_t) i * 3 + v];
		}
		float sr, sb, br, bb;
		br = (float) (black[0] / nb0);
		bb = (float) (black[2] / nb0);
		sr = (float) (white[0] / nw) - br;
		sb = (float) (white[2] / nw) - bb;
		sr = sr < 1e-3f ? 1e-3f : sr;
		sb = sb < 1e-3f ? 1e-3f : sb;
		float sums[CQ_HEADER_BITS] = {0};
		for (unsigned i = 0; i < CQ_HEADER_MODULES; i++) {
			const float *m = s + (size_t) (order[i * 2] * n + order[i * 2 + 1]) * 3;
			sums[i % CQ_HEADER_BITS] += (m[0] - br) / sr - (m[2] - bb) / sb;
		}
		unsigned word = 0;
		for (int i = 0; i < CQ_HEADER_BITS; i++)
			word |= (unsigned) (sums[i] > 0) << (CQ_HEADER_BITS - 1 - i);
		int profile, rate;
		if (cq_parse_header(word, &profile, &rate))
			goto no_colour;
		r->profile = profile;
		r->rate_num = cq_rate_num[rate];
		r->rate_den = cq_rate_den[rate];
	}

	unsigned bits = r->profile == 0 ? 2 : 3, colours = 1u << bits;
	unsigned npilot = ((unsigned) K * PILOT_PERCENT + 50) / 100;
	if ((unsigned) K <= CQ_HEADER_MODULES + npilot) {
		status = CQ_ERR_PAYLOAD;
		goto done;
	}
	unsigned data = (unsigned) K - CQ_HEADER_MODULES - npilot;
	uint32_t nbits = data * bits;
	uint32_t kbits = nbits * (uint32_t) r->rate_num / (uint32_t) r->rate_den / 8 * 8;
	if (kbits / 8 <= CQ_MSG_HEADER) {
		status = CQ_ERR_PAYLOAD;
		goto done;
	}

	/* neighbour means, with white outside the symbol */
	for (unsigned y = 0; y < n; y++) {
		for (unsigned x = 0; x < n; x++) {
			for (int v = 0; v < 3; v++) {
				float t = 0;
				t += y ? s[(size_t) ((y - 1) * n + x) * 3 + v] : 1.0f;
				t += y + 1 < n ? s[(size_t) ((y + 1) * n + x) * 3 + v] : 1.0f;
				t += x ? s[(size_t) (y * n + x - 1) * 3 + v] : 1.0f;
				t += x + 1 < n ? s[(size_t) (y * n + x + 1) * 3 + v] : 1.0f;
				nb[(size_t) (y * n + x) * 3 + v] = t * 0.25f;
			}
		}
	}

	unsigned listed = (unsigned) K - CQ_HEADER_MODULES;
	float *ll = cq_alloc(a, (size_t) listed * colours, sizeof *ll);
	float *llr = cq_alloc(a, nbits, sizeof *llr);
	uint8_t *info = cq_alloc(a, kbits, 1);
	if (!ll || !llr || !info)
		goto done;
	demod_ctx dc = {listed, order + 2 * CQ_HEADER_MODULES, dark, s, nb, n, colours, npilot,
	                {bits == 2 ? &cq_pal4_light[0][0] : &cq_pal8_light[0][0],
	                 bits == 2 ? &cq_pal4_dark[0][0] : &cq_pal8_dark[0][0]}};
	memset(ll, 0, (size_t) listed * colours * sizeof *ll);
	STAGE(7);
	e = demodulate(&dc, fn, ll, a);
	if (e) {
		status = (cq_status) e;
		goto done;
	}
	STAGE(8);
	bit_llrs(ll + (size_t) npilot * colours, data, bits, llr);
#ifdef CQ_TESTING
	if (cq_test_llr)
		memcpy(cq_test_llr, llr, nbits * sizeof *llr);
	if (cq_test_ll)
		memcpy(cq_test_ll, ll + (size_t) npilot * colours, (size_t) data * colours * sizeof *ll);
#endif
	STAGE(9);
	e = cq_ra_decode(llr, nbits, kbits, info, &r->iterations, a);
	if (e) {
		status = (cq_status) e;
		goto done;
	}
	STAGE(10);

	/* message: u16 length, u32 CRC-32, payload */
	{
		size_t bytes = kbits / 8;
		uint8_t *msg = cq_alloc(a, bytes, 1);
		if (!msg)
			goto done;
		memset(msg, 0, bytes);
		for (uint32_t i = 0; i < kbits; i++)
			msg[i >> 3] |= (uint8_t) (info[i] << (7 - (i & 7)));
		size_t len = (size_t) msg[0] << 8 | msg[1];
		uint32_t crc = (uint32_t) msg[2] << 24 | (uint32_t) msg[3] << 16 | (uint32_t) msg[4] << 8 | msg[5];
		if (len > bytes - CQ_MSG_HEADER || crc32_bytes(msg + CQ_MSG_HEADER, len) != crc) {
			status = CQ_ERR_PAYLOAD;
			goto done;
		}
		if (!r->payload || len > r->payload_cap) {
			r->payload_len = len;
			status = CQ_ERR_TOO_BIG;
			goto done;
		}
		memcpy(r->payload, msg + CQ_MSG_HEADER, len);
		r->payload_len = len;
		status = CQ_OK;
	}
	goto done;

no_colour:
	status = CQ_ERR_NO_COLOUR;
done:
	r->work_used = arena.peak;
	return status;
}

cq_status cq_decode(const uint8_t *rgb, unsigned width, unsigned height, unsigned stride,
                    const float corners[4][2], unsigned version, unsigned flags,
                    void *work, size_t work_size, cq_result *result)
{
	return decode(rgb, width, height, stride, corners, version, NULL, flags, work, work_size, result);
}

cq_status cq_decode_base(const uint8_t *rgb, unsigned width, unsigned height, unsigned stride,
                         const float corners[4][2], unsigned version, const cq_base *base,
                         unsigned flags, void *work, size_t work_size, cq_result *result)
{
	return decode(rgb, width, height, stride, corners, version, base, flags, work, work_size, result);
}

size_t cq_work_size(unsigned width, unsigned height, unsigned max_version)
{
	if (width == 0 || height == 0 || width > 16384 || height > 16384 || max_version < 1 || max_version > 40)
		return 0;
	size_t n = cq_qr_size(max_version);
	size_t side = width > height ? width : height;
	/* per pixel: gray, soft. Per module, at 3 bits: symbol, demodulator and code tables. */
	return (size_t) width * height * 8 + side * 4 + n * n * 480 + (64u << 10);
}
