/*
 * From EPDPages (sim/epaper.c, revision 241443b), by Marco Carnut, copied into
 * GapKeep (sim/src/epd/) under GPL-3.0-or-later with its author's
 * permission: the simulator's e-paper panels, under the real driver
 * (sim/src/epaper_sim.cpp, docs/EPAPER.md). Unchanged.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/*
 * epaper - an electrophoretic panel's pixels, physically, roughly.
 *
 * Each pixel is a capsule of black and white pigment; s is where the
 * pigment is, 0 the white at the surface .. 1 the black, and what shows,
 * x, is a smoothstep of it (the last of the pigment to arrive or leave
 * shows least). A waveform puts a voltage V across it (its source's level
 * minus VCOM's) for each frame; positive drives it black (the UC8176's
 * VDH, "01", is black, as src/epd.c says), negative white. The model, per
 * pixel and frame (dt):
 *
 *   V   = (1 - xt) V + xt Vn           the fringe field: some of the four
 *                                      neighbours' mean drive Vn
 *   Veff = V - q                       the drive less the polarization
 *   v    = k ((|Veff| - vth) / vref)^expo (1 - hold_c h)   if |Veff| > vth
 *   s   += v dt toward Veff's black or white, held in 0..1 (the pigment
 *          moves at a speed the field gives it, until it's all there)
 *
 * for most of the pigment, and the same with slow_k for the rest, slow_f
 * of it (what hangs back: near the walls, clumped), whose place shows in
 * proportion. The slow part is the ghost: it needs long drive to follow,
 * so a short waveform leaves some of the old picture in it, and it moves
 * only part of the way at each partial refresh, so it carries the last few
 * pictures, fading as it rejoins the rest between refreshes. And
 *   q   += (q_gain V - q / q_tau) dt   charge left by unbalanced drive
 *   h   *= exp(-|V| dt / unlock)       the drive frees a stiff pixel
 *
 * and, undriven (between refreshes, or outside a partial window),
 *
 *   h  -> 1 with hold_tau              a pixel held still stiffens
 *   q  -> 0 with q_tau                 (and pushes x while |q| > vth)
 *   s_slow -> s with relax_tau         the slow pigment rejoins the rest
 *
 * so: the response saturates (s stops at the rail), it's
 * voltage- and duration-dependent (with a threshold: the 1 V a ground
 * level gets against a VCOM of -1 V barely moves it), a pixel that sat
 * still for long answers slower (the ghost of an old picture after a short
 * waveform), and a waveform whose DC doesn't balance leaves charge that
 * keeps pushing the pigment afterwards, then fades; the fringe field
 * darkens the white next to what's driven black (+12 V there against -10
 * to white: VCOM DC at -1 V), a little at each refresh, which piles up
 * around a region that changes often.
 *
 * What makes a clock's digits leave the ghosts of the last two or three
 * (sim/ghost -d): the slow pigment, partly moved by each partial refresh
 * and relaxing over relax_tau; the fringe field adds to the smear around
 * them. The partial waveform's +DC (sim/ghost) does not: its charge
 * lowers the next drives a little, and with it the ghosts. A full
 * refresh's long drive clears all of it.
 *
 * All this is a phenomenological sketch, not a measured model: the
 * defaults are guesses of the right size (a full swing in ~0.2 s at 11
 * V; a quarter of the pigment ~6x slower, rejoining the rest in a minute;
 * a pixel held a minute ~2.5x slower until ~0.3 s of drive frees it; ~1 V
 * of polarization from a second of unbalanced 10 V; a fifth of the
 * neighbours' field), set so a clock's digit leaves n-1 clearly and n-2,
 * n-3 faintly, as the real panel does to the eye -- for calibration
 * against photos of it (README: "The panel's physics"). Not modelled:
 * temperature, blooming past the nearest neighbours, the red pigment,
 * grey levels in the capsule's depth, the border.
 */
#include <math.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "epaper.h"

void ep_params_default(ep_params_t* p)
{
	*p = (ep_params_t){
		.k = 5,                      /* swings/s at vref: a full one in ~0.2 s at 11 V */
		.vref = 10,
		.vth = 1.1,
		.expo = 1,
		.hold_tau = 60,              /* s */
		.hold_c = 0.6,
		.unlock = 3,                 /* V*s: 0.3 s at 10 V */
		.q_gain = 0.1,               /* 1 V from 1 s at 10 V */
		.q_tau = 10,                 /* s */
		.slow_f = 0.25,
		.slow_k = 0.8,               /* swings/s at vref: ~1.2 s for a full one at 11 V */
		.relax_tau = 60,             /* s */
		.xt = 0.2,
	};
}

static const struct { const char* name; size_t off; } names[] = {
	{ "k", offsetof(ep_params_t, k) }, { "vref", offsetof(ep_params_t, vref) },
	{ "vth", offsetof(ep_params_t, vth) }, { "expo", offsetof(ep_params_t, expo) },
	{ "hold_tau", offsetof(ep_params_t, hold_tau) }, { "hold_c", offsetof(ep_params_t, hold_c) },
	{ "unlock", offsetof(ep_params_t, unlock) }, { "q_gain", offsetof(ep_params_t, q_gain) },
	{ "q_tau", offsetof(ep_params_t, q_tau) }, { "slow_f", offsetof(ep_params_t, slow_f) },
	{ "slow_k", offsetof(ep_params_t, slow_k) }, { "relax_tau", offsetof(ep_params_t, relax_tau) },
	{ "xt", offsetof(ep_params_t, xt) },
};

int ep_params_parse(ep_params_t* p, const char* s, const char** bad)
{
	while (s && *s)
	{
		while (*s == ',' || *s == ' ')
		  s++;
		if (!*s)
		  break;
		const char* eq = strchr(s, '=');
		size_t n = eq ? (size_t)(eq - s) : strlen(s);
		size_t i;
		for (i = 0; i < sizeof names / sizeof names[0]; i++)
		  if (strlen(names[i].name) == n && !strncmp(names[i].name, s, n))
		    break;
		if (!eq || i == sizeof names / sizeof names[0])
		{
			if (bad)
			  *bad = s;
			return -1;
		}
		*(double*)((char*)p + names[i].off) = strtod(eq + 1, (char**)&s);
	}
	return 0;
}

void ep_params_print(const ep_params_t* p, char* buf, int n)
{
	int o = 0;
	for (size_t i = 0; i < sizeof names / sizeof names[0] && o < n; i++)
	  o += snprintf(buf + o, n - o, "%s%s=%g", i ? " " : "", names[i].name, *(const double*)((const char*)p + names[i].off));
}

double ep_wave_ms(const ep_wave_t* w)
{
	double f = 0;
	for (int i = 0; i < w->n; i++)
	  f += w->ph[i].frames;
	return f * w->frame_ms;
}

void ep_wave_dc(const ep_wave_t* w, double dc[4])
{
	for (int c = 0; c < 4; c++)
	{
		dc[c] = 0;
		for (int i = 0; i < w->n; i++)
		  dc[c] += w->ph[i].v[c] * w->ph[i].frames * w->frame_ms / 1000;
	}
}

struct epaper
{
	int       w, h;
	ep_params_t p;
	float*    x, *xs, *hold, *q;         /* x, xs: the fast and the slow pigment's place, s */
	float*    opt;
	uint16_t* nb;                        /* the neighbours' classes (counts, 3 bits each) */
	uint8_t*  cls;
	ep_wave_t wave;
	int       active;                    /* a refresh going on */
	double    t0;                        /* ms: its start */
	long      done, total;               /* frames */
	double    now;                       /* ms: the physics so far */
	double    idle_from;                 /* ms: undriven since (not yet applied) */
};

epaper_t* ep_new(int w, int h, const ep_params_t* p)
{
	epaper_t* e = calloc(1, sizeof *e);
	e->w = w;
	e->h = h;
	if (p)
	  e->p = *p;
	else
	  ep_params_default(&e->p);
	e->x = calloc(w * h, sizeof *e->x);
	e->xs = calloc(w * h, sizeof *e->xs);
	e->hold = malloc(w * h * sizeof *e->hold);
	e->q = calloc(w * h, sizeof *e->q);
	e->opt = calloc(w * h, sizeof *e->opt);
	e->nb = calloc(w * h, sizeof *e->nb);
	e->cls = malloc(w * h);
	for (int i = 0; i < w * h; i++)
	  e->hold[i] = 1;                    /* long settled */
	return e;
}

void ep_free(epaper_t* e)
{
	if (!e)
	  return;
	free(e->x);
	free(e->xs);
	free(e->hold);
	free(e->q);
	free(e->opt);
	free(e->nb);
	free(e->cls);
	free(e);
}

void ep_set_params(epaper_t* e, const ep_params_t* p)
{
	e->p = *p;
}

/* dt seconds of no drive for pixel i (factors precomputed) */
static void idle_px(epaper_t* e, int i, float fh, float fq, float fr, double dt)
{
	e->hold[i] = 1 - (1 - e->hold[i]) * fh;
	e->xs[i] = e->x[i] + (e->xs[i] - e->x[i]) * fr;   /* the slow pigment rejoining the rest */
	float q = e->q[i];
	if (fabsf(q) > e->p.vth)
	{
		/* the charge pushes the pigment while it's above the threshold:
		 * a few steps of it as it fades */
		double t = 0, step = e->p.q_tau / 8;
		float  x = e->x[i], xs = e->xs[i];   /* (the pigment's places) */
		while (t < dt && fabsf(q) > e->p.vth)
		{
			double s = step < dt - t ? step : dt - t;
			double a = fabsf(q) - e->p.vth, r = e->p.k * pow(a / e->p.vref, e->p.expo) * (1 - e->p.hold_c * e->hold[i]) * s;
			x += q < 0 ? r : -r;         /* Veff = -q */
			x = x < 0 ? 0 : x > 1 ? 1 : x;
			r *= e->p.slow_k / e->p.k;
			xs += q < 0 ? r : -r;
			xs = xs < 0 ? 0 : xs > 1 ? 1 : xs;
			q *= exp(-s / e->p.q_tau);
			t += s;
		}
		e->x[i] = x;
		e->xs[i] = xs;
		if (t < dt)
		  q *= exp(-(dt - t) / e->p.q_tau);
		e->q[i] = q;
	}
	else
	  e->q[i] = q * fq;
}

static void idle_all(epaper_t* e, double ms)
{
	double dt = (ms - e->idle_from) / 1000;
	e->idle_from = ms;
	if (dt <= 0)
	  return;
	float fh = exp(-dt / e->p.hold_tau), fq = exp(-dt / e->p.q_tau), fr = exp(-dt / e->p.relax_tau);
	for (int i = 0; i < e->w * e->h; i++)
	  idle_px(e, i, fh, fq, fr, dt);
}

/* frame f of the waveform, for every pixel */
static void frame(epaper_t* e, const float* v)
{
	const ep_params_t* p = &e->p;
	float dt = e->wave.frame_ms / 1000, kn = p->k / pow(p->vref, p->expo) * dt;
	float xt = p->xt, vth = p->vth, hc = p->hold_c, gain = p->q_gain * dt, leak = dt / p->q_tau, slow = p->slow_k / p->k;
	float fu[4];
	for (int c = 0; c < 4; c++)
	  fu[c] = exp(-fabsf(v[c]) * dt / p->unlock);
	int lin = p->expo == 1;
	for (int i = 0, n = e->w * e->h; i < n; i++)
	{
		int c = e->cls[i];
		if (c > 3)
		  continue;                      /* not driven (idle, applied at the end) */
		float V = v[c];
		if (xt > 0)
		{
			/* the fringe field: the neighbours' drive, some of it */
			unsigned m = e->nb[i];
			float vn = ((m & 7) * v[0] + (m >> 3 & 7) * v[1] + (m >> 6 & 7) * v[2] + (m >> 9 & 7) * v[3]) / 4;
			V = (1 - xt) * V + xt * vn;
		}
		float q = e->q[i], ve = V - q, a = fabsf(ve) - vth;
		if (a > 0)
		{
			float r = kn * (lin ? a : powf(a, p->expo)) * (1 - hc * e->hold[i]);
			float x = e->x[i] + (ve > 0 ? r : -r);
			e->x[i] = x < 0 ? 0 : x > 1 ? 1 : x;
			r *= slow;
			x = e->xs[i] + (ve > 0 ? r : -r);
			e->xs[i] = x < 0 ? 0 : x > 1 ? 1 : x;
		}
		e->q[i] = q + gain * V - leak * q;
		if (fabsf(v[c]) > vth)
		  e->hold[i] *= fu[c];
	}
}

int ep_advance(epaper_t* e, double ms)
{
	if (ms <= e->now)
	  return 0;
	int ended = 0;
	if (e->active)
	{
		long due = (long)((ms - e->t0) / e->wave.frame_ms);
		if (due > e->total)
		  due = e->total;
		/* which phase frame `done` is in */
		long f = 0;
		int  ph = 0;
		while (ph < e->wave.n && f + e->wave.ph[ph].frames <= e->done)
		  f += e->wave.ph[ph++].frames;
		for (; e->done < due; e->done++)
		{
			while (ph < e->wave.n && e->done >= f + e->wave.ph[ph].frames)
			  f += e->wave.ph[ph++].frames;
			frame(e, e->wave.ph[ph].v);
		}
		if (e->done >= e->total)
		{
			/* the undriven pixels' idle time, through the refresh */
			double end = e->t0 + e->total * e->wave.frame_ms;
			double dt = (end - e->idle_from) / 1000;
			float fh = exp(-dt / e->p.hold_tau), fq = exp(-dt / e->p.q_tau), fr = exp(-dt / e->p.relax_tau);
			for (int i = 0; i < e->w * e->h; i++)
			  if (e->cls[i] > 3)
			    idle_px(e, i, fh, fq, fr, dt);
			e->idle_from = end;
			e->active = 0;
			ended = 1;
		}
	}
	if (!e->active && ms - e->idle_from > 200)
	  idle_all(e, ms);
	e->now = ms;
	return ended;
}

void ep_refresh(epaper_t* e, double ms, const ep_wave_t* w, const uint8_t* cls)
{
	if (e->active)
	  ep_advance(e, e->t0 + e->total * e->wave.frame_ms);
	if (ms > e->now)
	  e->now = ms;
	idle_all(e, ms);
	e->wave = *w;
	if (e->wave.frame_ms <= 0)
	  e->wave.frame_ms = 20;
	memcpy(e->cls, cls, e->w * e->h);
	/* each pixel's four neighbours' classes, 3 bits a class's count (an
	 * edge's missing one: its own), for the fringe field */
	for (int y = 0; y < e->h; y++)
	  for (int x = 0; x < e->w; x++)
	  {
		  int i = y * e->w + x, c = cls[i];
		  int n[4] = { x ? cls[i - 1] : c, x < e->w - 1 ? cls[i + 1] : c, y ? cls[i - e->w] : c, y < e->h - 1 ? cls[i + e->w] : c };
		  uint16_t m = 0;
		  for (int k = 0; k < 4; k++)
		    m += 1 << 3 * (n[k] > 4 ? 4 : n[k]);
		  e->nb[i] = m;
	  }
	e->t0 = ms;
	e->done = 0;
	e->total = 0;
	for (int i = 0; i < w->n; i++)
	  e->total += w->ph[i].frames;
	e->active = e->total > 0;
}

double ep_progress(epaper_t* e, double ms)
{
	if (!e->active)
	  return -1;
	double p = (ms - e->t0) / (e->total * e->wave.frame_ms);
	return p < 0 ? 0 : p > 1 ? 1 : p;
}

/* what shows of the pigment at s */
static float shows(float s)
{
	return s * s * (3 - 2 * s);
}

/* a pixel: its fast pigment and its slow */
static float shows_px(epaper_t* e, int i)
{
	return (1 - e->p.slow_f) * shows(e->x[i]) + e->p.slow_f * shows(e->xs[i]);
}

const float* ep_state(epaper_t* e)
{
	for (int i = 0; i < e->w * e->h; i++)
	  e->opt[i] = shows_px(e, i);
	return e->opt;
}

void ep_grey(epaper_t* e, uint8_t* out)
{
	/* paper white to ink black, as the window's colours */
	for (int i = 0; i < e->w * e->h; i++)
	  out[i] = (uint8_t)(236 - 208 * shows_px(e, i) + 0.5f);
}

/* ---- the UC8176's waveform ---- */

/* The full refresh's waveform is the panel's own (OTP), which nobody
 * sends and we don't know. Assumed: Good Display's / Waveshare's register
 * waveform for this 4.2" (as GxEPD2_420.cpp has it, lut_20_vcomDC ..
 * lut_24_bb: a black/white flash, twice, then the image), at the PLL's
 * frame rate. It depends on the new data only (ww = bw, wb = bb) */
static const uint8_t otp_lut[5][44] = {
	{ 0x00, 0x08, 0x00, 0x00, 0x00, 0x02,  0x60, 0x28, 0x28, 0x00, 0x00, 0x01,
	  0x00, 0x14, 0x00, 0x00, 0x00, 0x01,  0x00, 0x12, 0x12, 0x00, 0x00, 0x01 },
	{ 0x40, 0x08, 0x00, 0x00, 0x00, 0x02,  0x90, 0x28, 0x28, 0x00, 0x00, 0x01,
	  0x40, 0x14, 0x00, 0x00, 0x00, 0x01,  0xA0, 0x12, 0x12, 0x00, 0x00, 0x01 },
	{ 0x40, 0x08, 0x00, 0x00, 0x00, 0x02,  0x90, 0x28, 0x28, 0x00, 0x00, 0x01,
	  0x40, 0x14, 0x00, 0x00, 0x00, 0x01,  0xA0, 0x12, 0x12, 0x00, 0x00, 0x01 },
	{ 0x80, 0x08, 0x00, 0x00, 0x00, 0x02,  0x90, 0x28, 0x28, 0x00, 0x00, 0x01,
	  0x80, 0x14, 0x00, 0x00, 0x00, 0x01,  0x50, 0x12, 0x12, 0x00, 0x00, 0x01 },
	{ 0x80, 0x08, 0x00, 0x00, 0x00, 0x02,  0x90, 0x28, 0x28, 0x00, 0x00, 0x01,
	  0x80, 0x14, 0x00, 0x00, 0x00, 0x01,  0x50, 0x12, 0x12, 0x00, 0x00, 0x01 },
};

/* frames a second from the PLL (0x30): 0x3C 50 Hz and 0x3A 100 Hz as
 * GxEPD2 has them; others by M (bits 5..3) and N (2..0) as 1400 / (M N),
 * which gives those two (an assumption past them) */
static double uc_hz(uint8_t pll)
{
	int m = pll >> 3 & 7, n = pll & 7;
	return m && n ? 1400.0 / (m * n) : 50;
}

/* the waveform the registers (or the OTP, assumed) give: each LUT is 7
 * groups of a level byte (four phases, 2 bits each, the first in bits
 * 7..6), the four phases' frames, and repeats. VCOM's levels: 00 VCOM DC,
 * 01 VDH + VCOM DC, 10 VDL + VCOM DC, 11 floating; a pixel's: 00 ground,
 * 01 VDH, 10 VDL, 11 floating (taken as no drive). The timing is VCOM's
 * (the firmware sends the same frames in all five) */
void ep_uc8176_wave(ep_wave_t* w, const uint8_t lut_[5][44], uint8_t pll, uint8_t vdc_, uint8_t vdh_, uint8_t vdl_)
{
	const uint8_t (*lut)[44] = lut_ ? lut_ : otp_lut;
	double vdc = -0.1 - 0.05 * vdc_, vdh = 2.4 + 0.2 * (vdh_ & 0x3F), vdl = -(2.4 + 0.2 * (vdl_ & 0x3F));
	w->n = 0;
	w->frame_ms = 1000 / uc_hz(pll);
	for (int g = 0; g < 7; g++)
	{
		const uint8_t* vc = lut[0] + 6 * g;
		for (int r = 0; r < vc[5]; r++)
		  for (int ph = 0; ph < 4; ph++)
		  {
			  int frames = vc[1 + ph], sh = 6 - 2 * ph;
			  if (!frames || w->n >= EP_PHASES)
			    continue;
			  int l = vc[0] >> sh & 3;
			  double com = l == 0 ? vdc : l == 1 ? vdh + vdc : l == 2 ? vdl + vdc : NAN;
			  w->ph[w->n].frames = frames;
			  for (int c = 0; c < 4; c++)
			  {
				  int s = lut[1 + c][6 * g] >> sh & 3;
				  double src = s == 0 ? 0 : s == 1 ? vdh : s == 2 ? vdl : NAN;
				  double v = src - com;
				  w->ph[w->n].v[c] = isnan(v) ? 0 : v;
			  }
			  w->n++;
		  }
	}
}

