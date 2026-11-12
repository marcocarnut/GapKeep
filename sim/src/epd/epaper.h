/*
 * From EPDPages (sim/epaper.h, revision 241443b), by Marco Carnut, copied into
 * GapKeep (sim/src/epd/) under GPL-3.0-or-later with its author's
 * permission: the simulator's e-paper panels, under the real driver
 * (sim/src/epaper_sim.cpp, docs/EPAPER.md). Unchanged.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/*
 * epaper - what an e-paper panel physically shows: its pixels' pigment
 * driven by a waveform, frame by frame, ghosting included. Frontend-
 * neutral (no files, no clock, no OS), for board.c; see epaper.c for the
 * model, its assumptions and its parameters.
 */
#ifndef EPAPER_H
#define EPAPER_H

#include <stdint.h>

/* the model's parameters (epaper.c says what each is) */
typedef struct
{
	double k;                        /* mobility: full swings a second at vref */
	double vref;                     /* V */
	double vth;                      /* V: no motion below it */
	double expo;                     /* the mobility's power of the voltage */
	double hold_tau;                 /* s: a held pixel stiffening */
	double hold_c;                   /* how much a fully stiff one is slower (0..1) */
	double unlock;                   /* V*s: drive that undoes the stiffness (1/e) */
	double q_gain;                   /* 1/s: polarization charged by the drive (V/(V*s)) */
	double q_tau;                    /* s: ...and its decay */
	double slow_f;                   /* the pigment that hangs back (0..1) */
	double slow_k;                   /* ...its mobility */
	double relax_tau;                /* s: ...rejoining the rest, undriven */
	double xt;                       /* the fringe field: the neighbours' drive a pixel gets (0..1) */
} ep_params_t;

void ep_params_default(ep_params_t* p);
/* "k=8,vth=0.5,...": 0, or -1 (and *bad at the name it didn't know) */
int  ep_params_parse(ep_params_t* p, const char* s, const char** bad);
/* "k=8 vref=10 ...", the whole set */
void ep_params_print(const ep_params_t* p, char* buf, int n);

/* a waveform: phases of frames, each a voltage (source - VCOM) for each
 * pixel class: 0 ww, 1 bw, 2 wb, 3 bb (old, new: w white, b black; the
 * UC8176's LUT groups); class 4, not driven, gets none */
#define EP_PHASES  128

typedef struct
{
	int    n;
	double frame_ms;
	struct { uint16_t frames; float v[4]; } ph[EP_PHASES];
} ep_wave_t;

double ep_wave_ms(const ep_wave_t* w);
/* the DC each class gets over the waveform: V*s */
void   ep_wave_dc(const ep_wave_t* w, double dc[4]);

/* the UC8176's (IL0398's) waveform from its registers: the five LUTs
 * (0x20 VCOM, 0x21..0x24 ww bw wb bb, 44 bytes each; NULL: its OTP one,
 * assumed), the PLL (0x30), VCOM DC (0x82), VDH and VDL (0x01's 3rd and
 * 4th bytes) */
void ep_uc8176_wave(ep_wave_t* w, const uint8_t lut[5][44], uint8_t pll, uint8_t vdc,
                    uint8_t vdh, uint8_t vdl);

typedef struct epaper epaper_t;

/* w x h pixels, all white and long settled */
epaper_t* ep_new(int w, int h, const ep_params_t* p);
void      ep_free(epaper_t* e);
void      ep_set_params(epaper_t* e, const ep_params_t* p);

/* a refresh starting at ms: the waveform, and each pixel's class (w * h
 * bytes). One still going on is finished first. */
void   ep_refresh(epaper_t* e, double ms, const ep_wave_t* w, const uint8_t* cls);
/* the physics up to ms (it only goes forward); 1 if a refresh ended */
int    ep_advance(epaper_t* e, double ms);
/* the refresh going on: its progress 0..1, or -1 */
double ep_progress(epaper_t* e, double ms);
/* the black pigment at the surface, 0 (white) .. 1, w * h floats; as of
 * the last ep_advance() */
const float* ep_state(epaper_t* e);
/* ...as grey levels, 255 white */
void   ep_grey(epaper_t* e, uint8_t* out);

#endif
