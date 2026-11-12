/*
 * From EPDPages (sim/panel.h, revision 241443b), by Marco Carnut, copied into
 * GapKeep (sim/src/epd/) under GPL-3.0-or-later with its author's
 * permission: the simulator's e-paper panels, under the real driver
 * (sim/src/epaper_sim.cpp, docs/EPAPER.md). Unchanged.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/*
 * panel - a panel model for the simulated board: a controller as far as
 * the firmware drives it (its commands, its RAM), what the module looks
 * like (size, colours, BUSY's polarity), and for the physics (epaper.c)
 * the waveform of each refresh. Each model is a panel_model_t in panels[]
 * (panels.c); board.c, epdsim, epdsim-x11, sim/ghost and the WASM build
 * (wasm.c, which hands the list to the web page) all go through it.
 * docs/panels.md says what adding one takes.
 */
#ifndef PANEL_H
#define PANEL_H

#include <stddef.h>
#include <stdint.h>

#include "epaper.h"
#include "epbwr.h"

/* what a model gets from the board */
typedef struct
{
	void*  ctx;
	double (*ms)(void* ctx);                         /* simulated time */
	void   (*busy_for)(void* ctx, double ms);         /* BUSY up for ms (the board minds its polarity) */
	void   (*drawing)(void* ctx);                    /* a page's drawing begins (power on, a soft reset) */
	/* a refresh: what panel_model_t.shown() gives is the new frame; BUSY
	 * for busy_ms; partial: a partial refresh (no flashing) */
	void   (*refresh)(void* ctx, double busy_ms, int partial);
	void   (*log)(void* ctx, int err, const char* msg);
	int    verbose;
	double refresh_ms;                               /* how long a refresh's BUSY is; negative: its waveform's */
	const uint8_t* otp_lut;                          /* the SSD1680's own (OTP) waveform, EB_LUT bytes; NULL:
	                                                  * the assumed one (epbwr.c), or the physics' lut= */
} panel_host_t;

typedef struct panel_model
{
	const char* name;                /* the controller: "SSD1680" */
	const char* module;              /* the module: "WeAct 2.9\" B/W/R" */
	int         fw_id;               /* its number in src/epd.c's panels[] (and web/serial.js's PANELS): the setting at PANEL_ADDR */
	int         width, height;       /* native: frame-N.bin's rows of width/8 bytes, height of them */
	int         red;                 /* a red plane */
	int         busy_low;            /* BUSY low while busy */
	uint8_t     rgb[3][3];           /* how white, black and red look */
	uint8_t     shows[3][3];         /* ...and physically, settled (the physics' own
	                                    colours: where the page's colour pickers start) */
	size_t      state;               /* bytes of its state, zeroed, then init() */

	void (*init)(void* st, const panel_host_t* h);
	void (*reset)(void* st);         /* RES up: out of reset */
	void (*cs)(void* st, int level); /* /CS changes */
	void (*byte)(void* st, int dc, uint8_t v);   /* a byte on the SPI, /CS low: a command (dc 0) or data */
	/* what it shows: the B/W plane (1 white) and the red one (1 red), as
	 * frame-N.bin; valid from the refresh() call on */
	void (*shown)(void* st, uint8_t* bw, uint8_t* red);
	/* for the physics: the refresh just begun's waveform, and each pixel's
	 * class (epaper.h: 0..3 by old and new data, 4 not driven); 0 if this
	 * model has none (no physics then) */
	int  (*wave)(void* st, ep_wave_t* w, uint8_t* cls);
	/* ...or the three-pigment physics (epbwr.h): the waveform from the
	 * controller's LUT and each pixel's LUT (2 red + bw, 4 not driven) */
	int  (*wave3)(void* st, eb_wave_t* w, uint8_t* cls);
	const char* phys;                /* epaper.c's (epbwr.c's) parameters for it, over the defaults ("" none) */
} panel_model_t;

extern const panel_model_t* const panels[];
extern const int npanels;

/* by name ("UC8176"), module, or number (its index); NULL if none */
const panel_model_t* panel_find(const char* s);
/* the list as JSON, for the web page: [{"id":0,"name":..,"module":..,
 * "fw":0,"width":..,"height":..,"red":1,"busyLow":0,"rgb":[[..],..],
 * "shows":[[..],..],"physics":1}, ...]; its length (written up to n) */
int panel_json(char* buf, int n);

/* a model's helpers */
void panel_logf(const panel_host_t* h, int err, const char* fmt, ...) __attribute__((format(printf, 3, 4)));

#endif
