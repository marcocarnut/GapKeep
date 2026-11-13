/*
 * From EPDPages (sim/epbwr.h, revision 241443b), by Marco Carnut, copied into
 * GapKeep (sim/src/epd/) under GPL-3.0-or-later with its author's
 * permission: the simulator's e-paper panels, under the real driver
 * (sim/src/epaper_sim.cpp, docs/EPAPER.md). Unchanged.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/*
 * epbwr - what a black/white/red e-paper panel physically shows: three
 * pigments driven by the SSD1680's waveform (its LUT), frame by frame,
 * the red's slow build-up, the flashing, residue and ghosts included.
 * Frontend-neutral (no files, no clock, no OS), for board.c; epbwr.c has
 * the model, its assumptions, its parameters and the assumed waveform.
 */
#ifndef EPBWR_H
#define EPBWR_H

#include <stdint.h>

#define EB_LUT  159                      /* 0x32's 153 bytes, then 0x3F, 0x03, 0x04 (3), 0x2C */

/* the model's parameters (epbwr.c says what each is), the waveform too */
typedef struct
{
	double k, vref, vth, expo;       /* black and white: swings/s at vref past the pairing threshold vth (V) */
	double rk, rvth, rexpo;          /* red: the same */
	double front;                    /* how near the front black and white get (red: 0) */
	double sep;                      /* black driven forward pushes red this far behind it */
	double d0;                       /* depth over which a pigment hides one behind it */
	double op_k, op_w, op_r;         /* the pigments' opacities */
	double rgb_k, rgb_w, rgb_r;      /* ...and colours, 0xRRGGBB */
	double slow_f, slow_k;           /* the pigment that hangs back, and its share of the speed */
	double relax_tau;                /* s: ...rejoining the rest, undriven */
	double q_gain, q_tau;            /* polarization: 1/s of V, s */
	double xt;                       /* the fringe field: the neighbours' drive a pixel gets */
	double temp, tc;                 /* deg C; the mobility's change a degree (fraction) */
	double hold_c, hold_tau, unlock; /* black and white held still: how much slower, s to stiffen, V*s to free (1/e) */
	double wpush;                    /* white driven forward pushes red behind it: its share of white's speed */
	double kick;                     /* V: the TFT's kickback, off every pixel's voltage */
	double mix;                      /* 1/(V*s): black and white driven, stirred toward the middle */
	uint8_t lut[EB_LUT];             /* the panel's own (OTP) waveform: the assumed one unless set */
} eb_params_t;

void eb_params_default(eb_params_t* p);
/* "k=4,rvth=1.2,lut=<318 hex digits>": 0, or -1 (and *bad at what it didn't know) */
int  eb_params_parse(eb_params_t* p, const char* s, const char** bad);
/* the numbers, "k=4 vref=10 ..." (not the LUT) */
void eb_params_print(const eb_params_t* p, char* buf, int n);
/* the assumed factory waveform (epbwr.c) */
extern const uint8_t eb_otp_lut[EB_LUT];

/* a waveform: phases of frames, each frame ms long, a voltage (source -
 * VCOM) for each pixel class: the SSD1680's LUT by the RAM's bits, 2 red +
 * bw (0 black, 1 white, 2 and 3 red); class 4, not driven, gets none.
 * The LUT's groups, sub-group and group repeats laid out in order */
#define EB_PHASES  1024

typedef struct
{
	int    n;
	int    group[EB_PHASES];         /* which LUT group each phase is of */
	struct { uint16_t frames; float ms; float v[4]; } ph[EB_PHASES];
} eb_wave_t;

double eb_wave_ms(const eb_wave_t* w);
/* the DC each class gets over the waveform: V*s */
void   eb_wave_dc(const eb_wave_t* w, double dc[4]);
/* the SSD1680's waveform from its LUT (159 bytes as eb_params_t.lut;
 * NULL the assumed one); 0, or -1 if it didn't fit EB_PHASES (cut short) */
int    eb_ssd1680_wave(eb_wave_t* w, const uint8_t* lut);

typedef struct epbwr epbwr_t;

/* w x h pixels, all white and long settled */
epbwr_t* eb_new(int w, int h, const eb_params_t* p);
void     eb_free(epbwr_t* e);

/* a refresh starting at ms: the waveform, and each pixel's class (w * h
 * bytes). One still going on is finished first. */
void   eb_refresh(epbwr_t* e, double ms, const eb_wave_t* w, const uint8_t* cls);
/* the physics up to ms (it only goes forward); 1 if a refresh ended */
int    eb_advance(epbwr_t* e, double ms);
/* the refresh going on: its progress 0..1, or -1; its phase (or -1) */
double eb_progress(epbwr_t* e, double ms, int* phase);
/* how it looks, as of the last eb_advance(): w * h RGBA */
void   eb_rgba(epbwr_t* e, uint8_t* out);
/* ...one pixel's colour (0..255 RGB), and its pigments' depths (6: black,
 * white, red, then their slow parts; 0 the front), for sim/ghost */
void   eb_pixel(epbwr_t* e, int i, uint8_t rgb[3], float z[6]);

#endif
