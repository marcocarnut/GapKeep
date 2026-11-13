/*
 * From EPDPages (sim/epbwr.c, revision 241443b), by Marco Carnut, copied into
 * GapKeep (sim/src/epd/) under GPL-3.0-or-later with its author's
 * permission: the simulator's e-paper panels, under the real driver
 * (sim/src/epaper_sim.cpp, docs/EPAPER.md). Unchanged.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/*
 * epbwr - a black/white/red electrophoretic panel's pixels, physically,
 * roughly: the WeAct 2.9" module's (an SSD1680 with a three-pigment
 * panel, Good Display's GDEY029Z95 or its like).
 *
 * The mechanism, as E Ink's and SiPix's three-particle patents describe
 * it (E Ink US 9,245,718 / US 2014/0092466 "Color display device", Wang
 * et al.; SiPix's dual-mode and three-particle filings): each capsule (a
 * microcup) holds black and white pigment, strongly charged and of
 * opposite signs, and red, weakly charged with the sign of one of them --
 * here the black's, as the SSD1680's red waveforms imply (red is seated
 * with VSH2, a low positive level, the same sign as VSH1 which drives
 * black: src/epd.c, panel_ssd1680.c; the published custom 3-colour LUTs
 * drive red pixels VSL then a long VSH2). Black and white attract each
 * other (a strong+/strong- pairing): below a threshold field they don't
 * separate, so a low voltage held long moves only the red, which slips
 * through the white to the front; a high voltage moves black and white
 * fast (and red too, slowly), so high short pulses take black or white
 * past the red. A full refresh: shaking at high voltage (the flashing),
 * the picture in black and white, then the red pixels' long low-voltage
 * phases (the red coming up, slowly), then a black/white clean-up.
 *
 * The model, per pixel: each pigment p (black, white, red) has a depth
 * z, 0 at the front (the viewer's side, VCOM's) .. 1 at the back (the
 * TFT's), black and white no nearer than `front`; a part of it, slow_f,
 * hangs back (near the walls, clumped) with its own depth zs. A frame
 * puts V (source - VCOM) across it; positive draws black and red to the
 * front and white back:
 *
 *   V    = source - VCOM - kick         the TFT's kickback (what DCVCOM is
 *                                      set against: kick = -DCVCOM, none)
 *   V    = (1 - xt) V + xt Vn          the fringe field (four neighbours)
 *   Veff = V - q                       less the polarization
 *   black, white: dz = -+ k ((|Veff| - vth) / vref)^expo dt   if |Veff| > vth
 *   red:          dz = -  rk ((|Veff| - rvth) / vref)^rexpo dt  if |Veff| > rvth
 *   (the slow parts the same times slow_k), all times exp(tc (temp - 23))
 *   black driven forward takes the front: red near it or ahead of it
 *     is pushed sep behind it, as fast as black moves (they move the
 *     same way, the faster black packs at the front); white driven
 *     forward the same, wpush as fast; either only while it outruns the
 *     red (at VSH2 black barely moves, and red passes it)
 *   black and white driven are also stirred toward the middle: dz =
 *     (middle - z) mix |Veff| dt (nothing under steady drive, which
 *     outruns it, but a shake leaves them mixed, grey)
 *   black and white held still stiffen: their speed times 1 - hold_c h,
 *     h -> 1 undriven (hold_tau), h *= exp(-|V| dt / unlock) driven
 *   q   += (q_gain V - q / q_tau) dt
 *
 * and, undriven: the slow parts rejoin the rest (relax_tau), q fades
 * (q_tau) and pushes the red while it's past rvth.
 *
 * What it looks like: the six layers (three pigments, fast and slow
 * parts), each with its opacity (op_*, a part's from its share by
 * Beer-Lambert), each hiding another behind it, fully once d0 ahead,
 * half at the same depth (they mix), not at all d0 behind; their colours
 * (rgb_*) mixed by what shows of each, in linear light, what gets
 * through them all showing the back (dark). So: red pigment
 * not all the way to the front, or white just behind a thin red, gives a
 * pinkish or lighter red; black under it, a darker one; red left part way
 * back after red, pinkish white; black at the front with red sep behind
 * it, black with a tinge.
 *
 * Ghosts and memory: the slow parts (moved only partly by each refresh,
 * rejoining over relax_tau), the polarization from the waveform's DC
 * (red's long VSH2 phases are far from balanced, eb_wave_dc()), and the
 * fringe field.
 *
 * A phenomenological sketch, as epaper.c's is, fitted to a slow-motion
 * video of the panel (sim/RED-VIDEO.md, footage of 2026-10-24): black
 * and white swing fully in ~0.3 s at 15 V once freed, half as fast when
 * they've sat still, and a little at VSH2 (the pairing threshold 3.9 V);
 * red comes up from the back in ~1.1 s at VSH2, dark at first (black
 * creeping up behind it), purer after each VSL kick; the shakes leave
 * black and white mixed, grey. What the video shows that this doesn't:
 * the red pigment taking part in the shakes (the real flicker is tinged
 * red, up to R-G 40 in white pixels, the model's not), and the first
 * red build's darkest moment (the model's red is purer sooner, 90 % at
 * 13.4 s against 14.6). Not modelled: the border, the XON (all gates on)
 * phases, temperature's choice of waveform (the one measured at ~24.5 C
 * for all temperatures), the red pigment's diffusion when idle, blooming
 * past the neighbours.
 */
#include <math.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "epbwr.h"

/* ==== the tunable part: parameters and the assumed waveform ==== */

/* The panel's own waveform (OTP), as the firmware leaves it (it writes
 * no LUT: 0x22 is left at its reset value, 0xFF, which loads the OTP's,
 * picked by temperature). Not readable from here: built in the SSD1680's
 * own LUT format from public sources, then fitted to a video:
 *
 *   - the format: the SSD1680 datasheet (Solomon Systech, rev 1.4, 0x32)
 *     as Waveshare's epd2in9_V2.cpp lays it out and comments it: VS
 *     bytes for LUT0..LUT4 x 12 groups (2 bits a phase, A first: 00 VSS,
 *     01 VSH1, 10 VSL, 11 VSH2; VCOM's LUT4: 00 DCVCOM, 01 VSH1 + DCVCOM,
 *     10 VSL + DCVCOM, 11 VSH2 + DCVCOM), then a group's TP[A] TP[B]
 *     SR[AB] TP[C] TP[D] SR[CD] RP (a repeat count n runs n + 1 times),
 *     FR (two groups a byte, the even one high), XON, then 0x3F 0x03
 *     0x04 x3 0x2C's bytes;
 *   - the LUT a pixel gets, 2 RED + BW (LUT0 black, LUT1 white, LUT2 and
 *     LUT3 red): the ssd1680 Rust crate (codeberg Ranzbak/ssd1680,
 *     display.rs, "confirmed on hardware");
 *   - the voltages, 15 V, 5.8 V, -15 V, VCOM -1.0 V: Waveshare's and that
 *     crate's trailers (0x41 0xB0 0x32), VCOM as Waveshare's Gray4 (0x28);
 *   - the shape and every length: FITTED TO FOOTAGE 2026-10-24 (a 240
 *     fps video of the WeAct module going through sim/red-video.pages at
 *     ~25 C, sim/RED-VIDEO.md): eleven groups, every one at 75 Hz (the
 *     shakes' periods, 53 and 67 ms, are 4 and 5 frames of it), 1357
 *     frames, 18.09 s; the levels from which way each LUT's pixels went.
 *     Measured from the refresh's start (the first frame that changes):
 *
 *       0.00  all white                                  0.51 s
 *       0.51  white pixels black, the rest white: the     1.25 s
 *             new picture inverted
 *       1.76  the shake: VSH1, VSL, 2 frames each, 102    5.44 s
 *             times (18.75 Hz: grey, flickering)
 *       7.20  all black                                  0.12 s
 *       7.32  the second shake: VSL 4 frames, VSH1 1,     1.73 s
 *             26 times (light, flickering)
 *       9.05  all black                                  1.55 s
 *      10.59  white and red pixels white, black black    0.69 s
 *      11.29  red: VSH2 (red pixels; the rest VSS) with   5.99 s
 *             a 5-frame kick (VSL; black pixels VSH1)
 *             every 0.51 s 3 times, then every 0.89 s 5
 *             times: the red comes up dark in ~1.3 s, each
 *             kick a white flash after which it's purer
 *      17.28  red held (VSH2)                            0.73 s
 *      18.01  white pixels VSH1, VSL: a blip             0.08 s
 *
 *     The voltages and VCOM are as assumed above (not measurable here).
 */
const uint8_t eb_otp_lut[EB_LUT] = {
	/* VS: LUT0 black */
	0x80, 0x80, 0x60, 0x40, 0x90, 0x40, 0x40, 0x10, 0x10, 0x00, 0x00, 0,
	/* LUT1 white */
	0x80, 0x40, 0x60, 0x40, 0x90, 0x40, 0x80, 0x20, 0x20, 0x00, 0x60, 0,
	/* LUT2 red (BW 0) */
	0x80, 0x80, 0x60, 0x40, 0x90, 0x40, 0x80, 0xE0, 0xE0, 0xC0, 0x00, 0,
	/* LUT3 red (BW 1) */
	0x80, 0x80, 0x60, 0x40, 0x90, 0x40, 0x80, 0xE0, 0xE0, 0xC0, 0x00, 0,
	/* LUT4 VCOM: DCVCOM throughout */
	0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	/* TP A, TP B, SR AB, TP C, TP D, SR CD, RP */
	38, 0, 0, 0, 0, 0, 0,        /* G0 all white (VSL) */
	94, 0, 0, 0, 0, 0, 0,        /* G1 white pixels black (VSH1), the rest VSL: the new picture inverted */
	2, 2, 101, 0, 0, 0, 0,       /* G2 the shake: VSH1 2, VSL 2, 102 times */
	9, 0, 0, 0, 0, 0, 0,         /* G3 all black */
	4, 1, 25, 0, 0, 0, 0,        /* G4 the second shake: VSL 4, VSH1 1, 26 times */
	116, 0, 0, 0, 0, 0, 0,       /* G5 all black */
	52, 0, 0, 0, 0, 0, 0,        /* G6 white and red pixels white, black ones black */
	33, 5, 0, 0, 0, 0, 2,        /* G7 red: VSH2 33, a kick 5, 3 times */
	62, 5, 0, 0, 0, 0, 4,        /* G8 ...VSH2 62, a kick 5, 5 times */
	55, 0, 0, 0, 0, 0, 0,        /* G9 red held */
	2, 4, 0, 0, 0, 0, 0,         /* G10 white pixels VSH1, VSL: the blip */
	0, 0, 0, 0, 0, 0, 0,
	/* FR: 75 Hz throughout */
	0x33, 0x33, 0x33, 0x33, 0x33, 0x33,
	/* XON: none */
	0, 0, 0,
	/* EOPT, VGH, VSH1 15 V, VSH2 5.8 V, VSL -15 V, VCOM -1.0 V */
	0x22, 0x17, 0x41, 0xB0, 0x32, 0x28,
};

void eb_params_default(eb_params_t* p)
{
	/* FITTED TO FOOTAGE 2026-10-24 (the WeAct module at ~24.5 C, sim/RED-
	 * VIDEO.md): an evolution strategy on the first four steps' nine
	 * transitions, each colour channel's 0.2 s mean and flicker through
	 * the refresh against the video's (normalised by the board's white
	 * bezel), the settled colours weighted most; residual: settled cells
	 * ΔE76 2.1 mean, 4.0 worst (the video's own light unevenness ~1.5).
	 * Not seen in it (no ghost to speak of after an 18 s refresh): slow_*,
	 * relax_tau, q_*, hold_tau, tc -- guesses as before. The speeds are at
	 * 23 C; temp says the footage's */
	*p = (eb_params_t){
		.k = 2.7386,                 /* swings/s at vref past vth: free, ~0.3 s for a full one at 15 V; held, twice that */
		.vref = 10,
		.vth = 3.9391,               /* V: black and white paired below it (VSH2's 5.8 V parts them a little: red comes up dark) */
		.expo = 1,
		.rk = 1.9631,                /* red: ~1.1 s from the back at VSH2, ~0.35 s at 15 V */
		.rvth = 1.2028,
		.rexpo = 1,
		.front = 0.011562,
		.sep = 0.2102,
		.d0 = 0.25994,
		.op_k = 0.99643, .op_w = 0.999, .op_r = 0.91756,
		/* as the camera saw them, the bezel's white at 240; red then 10%
		 * darker, as the panel looks to the eye (fitted 0x8F1818: settled
		 * 138,26,27; now 124,24,25, web/render.js's ink against its white) */
		.rgb_k = 0x1A1924, .rgb_w = 0xBEBBBD, .rgb_r = 0x811616,
		.slow_f = 0.34489,
		.slow_k = 0.28961,
		.relax_tau = 60,             /* s (not fitted) */
		.q_gain = 0.02,              /* 0.2 V from 1 s at 10 V (not fitted) */
		.q_tau = 10,                 /* s (not fitted) */
		.xt = 0.11052,
		.temp = 24.5, .tc = 0.03,    /* the footage's room; the fluid's viscosity: ~3 % a degree (not fitted) */
		.hold_c = 0.48163, .hold_tau = 60, .unlock = 2.7292,   /* a still pixel half as fast until ~3 V*s free it */
		.wpush = 0.51749,            /* white overtakes red at half its speed: red under a VSL kick flashes white */
		.mix = 0.66636,              /* the shakes leave black and white grey */
		.kick = 1.0263,              /* V: DCVCOM's -1.0 V against it: VSS is next to no drive, the shake even */
	};
	memcpy(p->lut, eb_otp_lut, EB_LUT);
}

/* ==== the rest is the model ==== */

static const struct { const char* name; size_t off; } names[] = {
#define N(x) { #x, offsetof(eb_params_t, x) }
	N(k), N(vref), N(vth), N(expo), N(rk), N(rvth), N(rexpo), N(front), N(sep), N(d0),
	N(op_k), N(op_w), N(op_r), N(rgb_k), N(rgb_w), N(rgb_r), N(slow_f), N(slow_k),
	N(relax_tau), N(q_gain), N(q_tau), N(xt), N(temp), N(tc), N(hold_c), N(hold_tau), N(unlock), N(wpush), N(kick), N(mix),
#undef N
};

static int hex(int c)
{
	return c >= '0' && c <= '9' ? c - '0' : (c | 32) >= 'a' && (c | 32) <= 'f' ? (c | 32) - 'a' + 10 : -1;
}

int eb_params_parse(eb_params_t* p, const char* s, const char** bad)
{
	while (s && *s)
	{
		while (*s == ',' || *s == ' ')
		  s++;
		if (!*s)
		  break;
		const char* eq = strchr(s, '=');
		size_t n = eq ? (size_t)(eq - s) : strlen(s);
		if (eq && n == 3 && !strncmp(s, "lut", 3))
		{
			/* the waveform, 159 bytes in hex */
			const char* h = eq + 1;
			uint8_t l[EB_LUT];
			int i;
			for (i = 0; i < EB_LUT && hex(h[0]) >= 0 && hex(h[1]) >= 0; i++, h += 2)
			  l[i] = hex(h[0]) << 4 | hex(h[1]);
			if (i < EB_LUT)
			{
				if (bad)
				  *bad = s;
				return -1;
			}
			memcpy(p->lut, l, EB_LUT);
			s = h;
			continue;
		}
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

void eb_params_print(const eb_params_t* p, char* buf, int n)
{
	int o = 0;
	for (size_t i = 0; i < sizeof names / sizeof names[0] && o < n; i++)
	{
		double v = *(const double*)((const char*)p + names[i].off);
		o += !strncmp(names[i].name, "rgb", 3) ? snprintf(buf + o, n - o, "%s%s=0x%06X", i ? " " : "", names[i].name, (unsigned)v)
		                                      : snprintf(buf + o, n - o, "%s%s=%g", i ? " " : "", names[i].name, v);
	}
	if (o < n)
	  snprintf(buf + o, n - o, memcmp(p->lut, eb_otp_lut, EB_LUT) ? " lut=(set)" : " lut=(assumed)");
}

/* ---- the waveform ---- */

/* the voltages' registers (the datasheet's tables): 0x04's VSH1/VSH2,
 * 2.4..8.8 V in 0.1 V steps from 0x8E, or 9..17 V in 0.2 V from 0x23; VSL
 * -5..-17 V in 0.25 V from 0x0A; 0x2C, VCOM -0.025 V a step */
static double vsh(uint8_t a)
{
	double v = a & 0x80 ? 2.4 + 0.1 * ((a & 0x7F) - 0x0E) : 9 + 0.2 * (a - 0x23);
	return v < 0 ? 0 : v;
}

static double vsl(uint8_t a)
{
	double v = 5 + 0.25 * (a - 0x0A);
	return -(v < 0 ? 0 : v);
}

int eb_ssd1680_wave(eb_wave_t* w, const uint8_t* lut)
{
	if (!lut)
	  lut = eb_otp_lut;
	double vh1 = vsh(lut[155]), vh2 = vsh(lut[156]), vl = vsl(lut[157]), dc = -0.025 * lut[158];
	double lv[4] = { 0, vh1, vl, vh2 };   /* by the 2-bit level */
	int full = 0;
	w->n = 0;
	for (int g = 0; g < 12; g++)
	{
		const uint8_t* t = lut + 60 + 7 * g;
		int fr = lut[144 + g / 2] >> (g & 1 ? 0 : 4) & 15;
		float ms = 1000.0 / (25 * (fr ? fr : 1));     /* (0 taken as 25 Hz) */
		for (int r = 0; r <= t[6]; r++)
		  for (int half = 0; half < 2; half++)
		    for (int sr = 0; sr <= t[half ? 5 : 2]; sr++)
		      for (int k = 0; k < 2; k++)
		      {
			      int ph = 2 * half + k, frames = t[half ? 3 + k : k];
			      if (!frames)
			        continue;
			      int sh = 6 - 2 * ph;
			      float v[4];
			      double com = lv[lut[48 + g] >> sh & 3] + dc;
			      for (int c = 0; c < 4; c++)
			        v[c] = lv[lut[12 * c + g] >> sh & 3] - com;
			      /* the same as the last: one phase, longer */
			      if (w->n && w->group[w->n - 1] == g && w->ph[w->n - 1].ms == ms && !memcmp(w->ph[w->n - 1].v, v, sizeof v)
			          && w->ph[w->n - 1].frames + frames < 65536)
			      {
				      w->ph[w->n - 1].frames += frames;
				      continue;
			      }
			      if (w->n >= EB_PHASES)
			      {
				      full = 1;
				      continue;
			      }
			      w->group[w->n] = g;
			      w->ph[w->n].frames = frames;
			      w->ph[w->n].ms = ms;
			      memcpy(w->ph[w->n].v, v, sizeof v);
			      w->n++;
		      }
	}
	return full ? -1 : 0;
}

double eb_wave_ms(const eb_wave_t* w)
{
	double t = 0;
	for (int i = 0; i < w->n; i++)
	  t += w->ph[i].frames * (double)w->ph[i].ms;
	return t;
}

void eb_wave_dc(const eb_wave_t* w, double dc[4])
{
	for (int c = 0; c < 4; c++)
	{
		dc[c] = 0;
		for (int i = 0; i < w->n; i++)
		  dc[c] += w->ph[i].v[c] * w->ph[i].frames * w->ph[i].ms / 1000;
	}
}

/* ---- the pixels ---- */

enum { K, W, R, KS, WS, RS, NZ };        /* the depths: black, white, red, then their slow parts */

struct epbwr
{
	int       w, h;
	eb_params_t p;
	float*    z[NZ];
	float*    q;
	float*    hd;                        /* black and white held still: stiff (1) .. freed (0) */
	uint16_t* nb;                        /* the neighbours' classes (counts, 3 bits each) */
	uint8_t*  cls;
	eb_wave_t wave;
	int       active;
	double    t0, total;                 /* ms: the refresh's start, its length */
	int       ph, f;                     /* the next frame: its phase, its frame in it */
	double    t;                         /* ms: ...its start */
	double    now, idle_from;
	float     lin[3][3];                 /* the pigments' colours, linear */
	float     op[NZ];                    /* the layers' opacities */
};

static void setup(epbwr_t* e)
{
	const eb_params_t* p = &e->p;
	double rgb[3] = { p->rgb_k, p->rgb_w, p->rgb_r }, op[3] = { p->op_k, p->op_w, p->op_r };
	for (int k = 0; k < 3; k++)
	{
		unsigned c = (unsigned)rgb[k];
		for (int j = 0; j < 3; j++)
		  e->lin[k][j] = powf((c >> (16 - 8 * j) & 255) / 255.0f, 2.2f);
		/* a part's opacity by its share of the pigment (Beer-Lambert) */
		e->op[k] = 1 - pow(1 - op[k], 1 - p->slow_f);
		e->op[k + 3] = 1 - pow(1 - op[k], p->slow_f);
	}
}

epbwr_t* eb_new(int w, int h, const eb_params_t* p)
{
	epbwr_t* e = calloc(1, sizeof *e);
	e->w = w;
	e->h = h;
	if (p)
	  e->p = *p;
	else
	  eb_params_default(&e->p);
	setup(e);
	for (int k = 0; k < NZ; k++)
	{
		e->z[k] = malloc(w * h * sizeof(float));
		/* white: white at the front, black and red at the back */
		for (int i = 0; i < w * h; i++)
		  e->z[k][i] = k % 3 == W ? e->p.front : 1;
	}
	e->q = calloc(w * h, sizeof *e->q);
	e->hd = malloc(w * h * sizeof *e->hd);
	for (int i = 0; i < w * h; i++)
	  e->hd[i] = 1;                       /* long settled */
	e->nb = calloc(w * h, sizeof *e->nb);
	e->cls = malloc(w * h);
	return e;
}

void eb_free(epbwr_t* e)
{
	if (!e)
	  return;
	for (int k = 0; k < NZ; k++)
	  free(e->z[k]);
	free(e->q);
	free(e->hd);
	free(e->nb);
	free(e->cls);
	free(e);
}

static float clampf(float x, float a, float b)
{
	return x < a ? a : x > b ? b : x;
}

/* dt seconds undriven for pixel i: the slow parts rejoining the rest, the
 * polarization fading (pushing the red while it's past rvth) */
static void idle_px(epbwr_t* e, int i, float fr, double dt)
{
	const eb_params_t* p = &e->p;
	for (int k = 0; k < 3; k++)
	  e->z[k + 3][i] = e->z[k][i] + (e->z[k + 3][i] - e->z[k][i]) * fr;
	e->hd[i] = 1 - (1 - e->hd[i]) * exp(-dt / p->hold_tau);
	float q = e->q[i];
	double t = 0, step = p->q_tau / 8, m = exp(p->tc * (p->temp - 23));
	while (t < dt && fabsf(q) > p->rvth)
	{
		double s = step < dt - t ? step : dt - t;
		float r = p->rk * m * pow((fabsf(q) - p->rvth) / p->vref, p->rexpo) * s;
		r = q > 0 ? r : -r;              /* Veff = -q: q > 0 draws red back */
		e->z[R][i] = clampf(e->z[R][i] + r, 0, 1);
		e->z[RS][i] = clampf(e->z[RS][i] + r * p->slow_k, 0, 1);
		q *= exp(-s / p->q_tau);
		t += s;
	}
	if (t < dt)
	  q *= exp(-(dt - t) / p->q_tau);
	e->q[i] = q;
}

static void idle_all(epbwr_t* e, double ms, int undriven_only)
{
	double dt = (ms - e->idle_from) / 1000;
	e->idle_from = ms;
	if (dt <= 0)
	  return;
	float fr = exp(-dt / e->p.relax_tau);
	for (int i = 0; i < e->w * e->h; i++)
	  if (!undriven_only || e->cls[i] > 3)
	    idle_px(e, i, fr, dt);
}

/* a frame of dt seconds at the voltages v (by class), every driven pixel */
static void frame(epbwr_t* e, const float* v, float dt)
{
	const eb_params_t* p = &e->p;
	float m = exp(p->tc * (p->temp - 23));
	float kb = p->k * m / pow(p->vref, p->expo) * dt, kr = p->rk * m / pow(p->vref, p->rexpo) * dt;
	float vth = p->vth, rvth = p->rvth, xt = p->xt, slow = p->slow_k, front = p->front, sep = p->sep;
	float gain = p->q_gain * dt, leak = dt / p->q_tau, hc = p->hold_c, wpush = p->wpush, kick = p->kick;
	float mix = p->mix * dt, mid = (1 + front) / 2;
	float fu[4];
	for (int c = 0; c < 4; c++)
	  fu[c] = exp(-fabsf(v[c]) * dt / p->unlock);
	int lin = p->expo == 1 && p->rexpo == 1;
	float* z[NZ];
	for (int k = 0; k < NZ; k++)
	  z[k] = e->z[k];
	for (int i = 0, n = e->w * e->h; i < n; i++)
	{
		int c = e->cls[i];
		if (c > 3)
		  continue;
		float V = v[c] - kick;
		if (xt > 0)
		{
			unsigned nb = e->nb[i];
			float vn = ((nb & 7) * v[0] + (nb >> 3 & 7) * v[1] + (nb >> 6 & 7) * v[2] + (nb >> 9 & 7) * v[3]) / 4 - kick;
			V = (1 - xt) * V + xt * vn;
		}
		float q = e->q[i], ve = V - q, a = fabsf(ve) - vth, ar = fabsf(ve) - rvth;
		float s = ve > 0 ? -1 : 1;       /* black's and red's way: -1 to the front */
		if (a > 0)
		{
			float r = s * kb * (lin ? a : powf(a, p->expo)) * (1 - hc * e->hd[i]), mx = mix * fabsf(ve);
			/* (and stirred toward the middle, as fast as the drive) */
			z[K][i] = clampf(z[K][i] + r + (mid - z[K][i]) * mx, front, 1);
			z[W][i] = clampf(z[W][i] - r + (mid - z[W][i]) * mx, front, 1);
			z[KS][i] = clampf(z[KS][i] + r * slow + (mid - z[KS][i]) * mx * slow, front, 1);
			z[WS][i] = clampf(z[WS][i] - r * slow + (mid - z[WS][i]) * mx * slow, front, 1);
			if (ar > 0)
			{
				float rr = s * kr * (lin ? ar : powf(ar, p->rexpo));
				z[R][i] = clampf(z[R][i] + rr, 0, 1);
				z[RS][i] = clampf(z[RS][i] + rr * slow, 0, 1);
			}
			/* black driven forward takes the front: red near it or
			 * ahead goes sep behind it, as fast as black moves (the
			 * red that hangs back, as slowly as it does); white driven
			 * forward the same, wpush as fast */
			float lead = s < 0 ? z[K][i] : z[W][i], push = s < 0 ? -r : r * wpush;
			float lim = lead + sep > 1 ? 1 : lead + sep, rv = ar > 0 ? kr * (lin ? ar : powf(ar, p->rexpo)) : 0;
			if (push > rv)                 /* (only as it outruns the red) */
			{
				if (z[R][i] < lim)
				  z[R][i] = z[R][i] + push < lim ? z[R][i] + push : lim;
				if (z[RS][i] < lim)
				  z[RS][i] = z[RS][i] + push * slow < lim ? z[RS][i] + push * slow : lim;
			}
			e->hd[i] *= fu[c];
		}
		else if (ar > 0)
		{
			float rr = s * kr * (lin ? ar : powf(ar, p->rexpo));
			z[R][i] = clampf(z[R][i] + rr, 0, 1);
			z[RS][i] = clampf(z[RS][i] + rr * slow, 0, 1);
		}
		e->q[i] = q + gain * V - leak * q;
	}
}

int eb_advance(epbwr_t* e, double ms)
{
	if (ms <= e->now)
	  return 0;
	int ended = 0;
	if (e->active)
	{
		while (e->ph < e->wave.n && e->t + e->wave.ph[e->ph].ms <= ms)
		{
			frame(e, e->wave.ph[e->ph].v, e->wave.ph[e->ph].ms / 1000);
			e->t += e->wave.ph[e->ph].ms;
			if (++e->f >= e->wave.ph[e->ph].frames)
			  e->f = 0, e->ph++;
		}
		if (e->ph >= e->wave.n)
		{
			idle_all(e, e->t, 1);        /* the undriven pixels, through the refresh */
			e->active = 0;
			ended = 1;
		}
	}
	if (!e->active && ms - e->idle_from > 200)
	  idle_all(e, ms, 0);
	e->now = ms;
	return ended;
}

void eb_refresh(epbwr_t* e, double ms, const eb_wave_t* w, const uint8_t* cls)
{
	if (e->active)
	  eb_advance(e, e->t0 + e->total + 1);
	if (ms > e->now)
	  e->now = ms;
	idle_all(e, ms, 0);
	e->wave = *w;
	memcpy(e->cls, cls, e->w * e->h);
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
	e->t0 = e->t = ms;
	e->ph = e->f = 0;
	e->total = eb_wave_ms(w);
	e->active = w->n > 0;
}

double eb_progress(epbwr_t* e, double ms, int* phase)
{
	if (phase)
	  *phase = e->active && e->ph < e->wave.n ? e->wave.group[e->ph] : -1;
	if (!e->active)
	  return -1;
	double p = (ms - e->t0) / e->total;
	return p < 0 ? 0 : p > 1 ? 1 : p;
}

static float smooth(float x)
{
	x = clampf(x, 0, 1);
	return x * x * (3 - 2 * x);
}

void eb_pixel(epbwr_t* e, int i, uint8_t rgb[3], float zz[6])
{
	/* the six layers: each hides one behind it by its opacity, fully once
	 * d0 ahead, half at the same depth (they mix), not at all d0 behind;
	 * what shows of each, its colour */
	float z[NZ];
	for (int k = 0; k < NZ; k++)
	{
		z[k] = e->z[k][i];
		if (zz)
		  zz[k] = z[k];
	}
	float inv = 1 / (e->p.d0 > 1e-4 ? e->p.d0 : 1e-4), sum = 0, c[3] = { 0, 0, 0 };
	for (int k = 0; k < NZ; k++)
	{
		float t = 1;
		for (int j = 0; j < NZ; j++)
		  if (j != k)
		    t *= 1 - e->op[j] * smooth(((z[k] - z[j]) * inv + 1) / 2);
		float wgt = t * e->op[k];
		sum += wgt;
		for (int j = 0; j < 3; j++)
		  c[j] += wgt * e->lin[k % 3][j];
	}
	/* what gets through all of it shows the back (as dark as the black) */
	for (int j = 0; j < 3; j++)
	  rgb[j] = (uint8_t)(255 * powf(sum > 1 ? c[j] / sum : c[j] + (1 - sum) * e->lin[K][j], 1 / 2.2f) + 0.5f);
}

void eb_rgba(epbwr_t* e, uint8_t* out)
{
	for (int i = 0; i < e->w * e->h; i++, out += 4)
	{
		eb_pixel(e, i, out, NULL);
		out[3] = 255;
	}
}
