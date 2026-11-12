/*
 * From EPDPages (sim/panel_ssd1680.c, revision 241443b), by Marco Carnut, copied into
 * GapKeep (sim/src/epd/) under GPL-3.0-or-later with its author's
 * permission: the simulator's e-paper panels, under the real driver
 * (sim/src/epaper_sim.cpp, docs/EPAPER.md). Changed: deep sleep (0x10 0x01) is modelled: the controller then
 * ignores everything until a hardware reset, BUSY high, as the datasheet
 * says.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/*
 * panel_ssd1680 - the SSD1680 of WeAct's 2.9" B/W/R and 2.13" B/W modules
 * (and the SSD1683 of its 4.2" B/W: below), as far as the firmware uses
 * it (src/epd.c): RAM X/Y windows and counters
 * (0x44 0x45 0x4E 0x4F), data entry mode (0x11, X first), the B/W (0x24)
 * and red (0x26) RAM, soft reset (0x12), refresh (0x20). BUSY high while
 * busy. On the B/W module the red RAM is the old data: display mode 1
 * (0x22 bit 3 clear) is a full refresh, which drives every pixel to the
 * B/W RAM; mode 2, the OTP's partial waveform, only those whose two RAMs
 * differ, so old data that isn't what's shown shows. A reset, hard or
 * soft, leaves the RAM scrambled: the datasheet says it's kept, but on the
 * 2.13" a partial refresh after one flashed as a full one, so the firmware
 * mustn't count on it. It has no physics: the B/W/R's below.
 * For the physics (epbwr.c), the waveform: the LUT register (0x32's 153
 * bytes) and its voltages (0x3F, 0x03, 0x04 VSH1 VSH2 VSL, 0x2C VCOM), as
 * a refresh takes them: loaded from the OTP first if display update
 * control 2 (0x22) says so (bit 4: its reset value, 0xFF, does, and the
 * firmware leaves it), else as written (0xC7, after a custom LUT). The
 * OTP's own is the assumed one (epbwr.c), or the physics' lut=.
 * The SSD1683 of WeAct's 4.2" B/W (400x300) is a third module: the same
 * commands with 50 bytes of RAM X, from byte 0 (its first source S0, where
 * the SSD1680 modules' is S8: X from 1 there), 300 gates. Update control 1
 * (0x21) counts here: its red RAM option (bits 7..4: 0 normal, 4 bypassed
 * as 0, 8 inverted) is what display mode 2 takes as the old data, so a
 * partial refresh with the red RAM bypassed (as a full one has it) shows
 * wrong. Its physics is the 4.2" UC8176's (epaper.c), by each pixel's old
 * and new data: for display mode 1 the assumed OTP full waveform there
 * (it takes the new data alone); for mode 2, the OTP's partial one, which
 * we don't know either: the firmware's UC8176 partial waveform (GxEPD2's,
 * src/epd.c's frames) stands in. Mode 2 drives every pixel (the window is
 * only the RAM's), those that don't change by their ww and bb levels.
 */
#include <stdio.h>
#include <string.h>

#include "panel.h"

#define RAM_W   50                       /* bytes: the SSD1683's 400 sources (the SSD1680's 176: 22) */
#define RAM_H   300                      /* (the SSD1680's 296) */
#define ROWS    300                      /* the most: the 4.2"'s */
#define ROW_B   50
#define BW_MS   3000                     /* the 2.13" B/W's refresh (a guess: no waveform) */
#define PART_MS 500                      /* ...and its partial one (a guess too) */

typedef struct
{
	const panel_host_t* h;
	int     rows, row_b, red;            /* the module's */
	int     x0;                          /* the RAM X byte of its column 0: 1 (S8) on the SSD1680's, 0 the SSD1683's */
	int     ram_w;                       /* the controller's RAM X bytes */
	int     s83;                         /* the SSD1683 */
	uint8_t upd1;                        /* 0x21's first byte */
	int     part;                        /* the last refresh display mode 2 */
	uint8_t old[ROWS * ROW_B];           /* ...its old data, as 0x21 had it */
	uint8_t ram[2][RAM_H][RAM_W];
	uint8_t cmd, n, data[8];
	uint8_t mode;                        /* 0x11 */
	int     xs, xe, ys, ye, x, y;
	int     plane;                       /* -1: not writing RAM */
	uint8_t disp[2][ROWS * ROW_B];       /* what shows: the RAM at the last refresh */
	uint8_t lut[EB_LUT];                 /* the waveform's registers: 0x32's, then 0x3F 0x03 0x04 0x2C's */
	int     lut_n;                       /* 0x32's bytes so far */
	uint8_t upd2;                        /* 0x22 */
	uint8_t wave[EB_LUT];                /* the last refresh's */
	int     custom;                      /* ...as written, not the OTP's */
	int     asleep;                      /* deep sleep (0x10): deaf until a hardware reset (GapKeep) */
} ssd_t;

static const uint8_t* otp(ssd_t* s)
{
	return s->h->otp_lut ? s->h->otp_lut : eb_otp_lut;
}

/* the registers after a reset: the OTP's waveform, loaded at the refresh */
static void defaults(ssd_t* s)
{
	memcpy(s->lut, otp(s), EB_LUT);
	s->upd2 = 0xFF;
	s->upd1 = 0x00;
}

/* ...and the RAM, not to be counted on */
static void scramble(ssd_t* s)
{
	uint8_t* p = &s->ram[0][0][0];
	for (size_t i = 0; i < sizeof s->ram; i++)
	  p[i] = (uint8_t)(i * 97 + 0x5A);
}

static void init(ssd_t* s, const panel_host_t* h)
{
	s->h = h;
	s->plane = -1;
	memset(s->disp[0], 0xFF, sizeof s->disp[0]);   /* white before the first refresh */
	defaults(s);
	memcpy(s->wave, s->lut, EB_LUT);
}

static void init_bwr(void* st, const panel_host_t* h)
{
	ssd_t* s = st;
	s->rows = 296, s->row_b = 16, s->red = 1, s->x0 = 1, s->ram_w = 22;
	init(s, h);
}

static void init_bw(void* st, const panel_host_t* h)
{
	ssd_t* s = st;
	s->rows = 250, s->row_b = 16, s->red = 0, s->x0 = 1, s->ram_w = 22;   /* 122 sources: the last byte's 6 low bits none */
	init(s, h);
}

static void init_83(void* st, const panel_host_t* h)
{
	ssd_t* s = st;
	s->rows = 300, s->row_b = 50, s->red = 0, s->x0 = 0, s->ram_w = 50, s->s83 = 1;
	init(s, h);
}

static void command_done(ssd_t* s)
{
	/* commands whose meaning needs all their data */
	uint8_t* d = s->data;
	int      n = s->n;
	switch (s->cmd)
	{
		case 0x11: if (n >= 1) s->mode = d[0]; break;
		case 0x44: if (n >= 2) { s->xs = d[0] & 0x3F; s->xe = d[1] & 0x3F; } break;
		case 0x45: if (n >= 4) { s->ys = d[0] | (d[1] & 1) << 8; s->ye = d[2] | (d[3] & 1) << 8; } break;
		case 0x4E: if (n >= 1) s->x = d[0] & 0x3F; break;
		case 0x4F: if (n >= 2) s->y = d[0] | (d[1] & 1) << 8; break;
		case 0x22: if (n >= 1) s->upd2 = d[0]; break;
		case 0x21: if (n >= 1) s->upd1 = d[0]; break;
		case 0x3F: if (n >= 1) s->lut[153] = d[0]; break;
		case 0x03: if (n >= 1) s->lut[154] = d[0]; break;
		case 0x04: for (int i = 0; i < n && i < 3; i++) s->lut[155 + i] = d[i]; break;
		case 0x2C: if (n >= 1) s->lut[158] = d[0]; break;
		case 0x10:
			/* deep sleep (GapKeep): mode 1 or 2; BUSY stays high */
			if (n >= 1 && (d[0] & 3) && !s->asleep)
			{
				s->asleep = 1;
				s->h->busy_for(s->h->ctx, 1e15);
				if (s->h->verbose)
				  panel_logf(s->h, 0, "panel: deep sleep");
			}
			break;
	}
}

static void ram_write(ssd_t* s, uint8_t v)
{
	if (s->x >= 0 && s->x < s->ram_w && s->y >= 0 && s->y < RAM_H)
	  s->ram[s->plane][s->y][s->x] = v;
	int xi = s->mode & 1 ? 1 : -1, yi = s->mode & 2 ? 1 : -1;
	if (s->mode & 4)
	{
		panel_logf(s->h, 1, "panel: Y-first address mode not modelled");
		return;
	}
	if (s->x == s->xe)
	{
		s->x = s->xs;
		s->y += yi;
	}
	else
	  s->x += xi;
}

/* the SSD1683's waveforms for the physics (above): the UC8176's, as its
 * LUTs would have them (epaper.c), at its frame rate, VCOM DC and VDH/VDL
 * as src/epd.c sets them there */
static const uint8_t part83[5] = { 0x00, 0x18, 0x5A, 0xA5, 0x24 };    /* VCOM, ww, bw, wb, bb */
static const uint8_t frames83[11] = { 60, 1, 4, 60, 1, 0x00, 1, 0, 0, 0, 1 };

static void wave83(ssd_t* s, ep_wave_t* w)
{
	if (!s->part)
	{
		ep_uc8176_wave(w, NULL, 0x3C, 0x00, 0x2B, 0x2B);
		return;
	}
	uint8_t lut[5][44];
	memset(lut, 0, sizeof lut);
	for (int i = 0; i < 5; i++)
	{
		lut[i][0] = part83[i];
		memcpy(&lut[i][1], frames83, sizeof frames83);
	}
	ep_uc8176_wave(w, (const uint8_t (*)[44])lut, 0x3A, 0x12, 0x2B, 0x2B);
}

/* ...and each pixel's class: by its old data and new in mode 2, by the
 * new alone in mode 1 (as the UC8176's full refresh has it, the old all
 * white) */
static int wave(void* st, ep_wave_t* w, uint8_t* cls)
{
	ssd_t* s = st;
	wave83(s, w);
	if (cls)
	  for (int y = 0; y < s->rows; y++)
	    for (int x = 0; x < s->row_b * 8; x++)
	    {
		    int i = y * s->row_b + (x >> 3), m = 0x80 >> (x & 7);
		    int o = !s->part || (s->old[i] & m), n = !!(s->disp[0][i] & m);
		    cls[y * s->row_b * 8 + x] = o && n ? 0 : !o && n ? 1 : o ? 2 : 3;
	    }
	return 1;
}

static void reset(void* st)
{
	ssd_t* s = st;
	s->cmd = 0;
	s->plane = -1;
	s->asleep = 0;
	defaults(s);
	scramble(s);
	s->h->busy_for(s->h->ctx, 1);        /* the controller coming out of reset */
}

static void cs(void* st, int level)
{
	if (level && !((ssd_t*)st)->asleep)
	  command_done(st);
}

static void byte(void* st, int dc, uint8_t v)
{
	ssd_t* s = st;
	const panel_host_t* h = s->h;
	if (s->asleep)
	{
		/* asleep: only a hardware reset wakes it (GapKeep) */
		if (s->asleep == 1)
		  panel_logf(h, 1, "panel: bytes sent in deep sleep, ignored (no reset first)");
		s->asleep = 2;
		return;
	}
	if (!dc)
	{
		command_done(s);
		s->cmd   = v;
		s->n     = 0;
		s->plane = v == 0x24 ? 0 : v == 0x26 ? 1 : -1;
		s->lut_n = 0;
		if (h->verbose && s->plane < 0)
		  panel_logf(h, 0, "panel: command %02x", v);
		switch (v)
		{
			case 0x12: defaults(s); scramble(s); h->busy_for(h->ctx, 2); h->drawing(h->ctx); break;
			case 0x20:
			{
				if (!s->red)
				{
					/* mode 2's old data: the red RAM, as 0x21 says (0
					 * bypassed, 8 inverted) */
					int part = s->upd2 & 0x08, ro = s->upd1 >> 4;
					s->part = !!part;
					for (int y = 0; y < s->rows; y++)
					  for (int x = 0; x < s->row_b; x++)
					  {
						  uint8_t r = s->ram[1][y][s->x0 + x], old = ro == 4 ? 0 : ro == 8 ? ~r : r;
						  uint8_t n = s->ram[0][y][s->x0 + x], d = part ? n ^ old : 0xFF;
						  uint8_t* o = &s->disp[0][y * s->row_b + x];
						  s->old[y * s->row_b + x] = old;
						  *o = (*o & ~d) | (n & d);
					  }
					if (h->verbose)
					  panel_logf(h, 0, "panel: display mode %d (0x22 %02x, 0x21 %02x)", part ? 2 : 1, s->upd2, s->upd1);
					double ms = part ? PART_MS : BW_MS;
					if (s->s83)
					{
						ep_wave_t w;
						wave83(s, &w);
						ms = ep_wave_ms(&w);
					}
					h->refresh(h->ctx, h->refresh_ms < 0 ? ms : part ? h->refresh_ms / 4 : h->refresh_ms, !!part);
					break;
				}
				for (int y = 0; y < s->rows; y++)
				  for (int p = 0; p < 2; p++)
				    memcpy(&s->disp[p][y * s->row_b], &s->ram[p][y][s->x0], s->row_b);
				/* the waveform: the OTP's (loaded now, over what was
				 * written) or the registers' */
				s->custom = !(s->upd2 & 0x10);
				if (!s->custom)
				  memcpy(s->lut, otp(s), EB_LUT);
				memcpy(s->wave, s->lut, EB_LUT);
				eb_wave_t w;
				int cut = eb_ssd1680_wave(&w, s->wave);
				if (cut)
				  panel_logf(h, 1, "panel: the waveform has more than %d phases: cut short", EB_PHASES);
				if (h->verbose)
				{
					double dc[4];
					eb_wave_dc(&w, dc);
					panel_logf(h, 0, "panel: %s waveform (0x22 %02x), %d phases, %.0f ms; DC black %+.2f white %+.2f red %+.2f V*s",
					           s->custom ? "register" : "OTP (assumed)", s->upd2, w.n, eb_wave_ms(&w), dc[0], dc[1], dc[2]);
				}
				/* (-r wave: as long as the waveform, 18.1 s as filmed) */
				h->refresh(h->ctx, h->refresh_ms < 0 ? eb_wave_ms(&w) : h->refresh_ms, 0);
				break;
			}
			case 0x10: break;            /* deep sleep: data follows */
		}
		return;
	}
	if (s->plane >= 0)
	{
		ram_write(s, v);
		return;
	}
	if (s->cmd == 0x32)
	{
		if (s->lut_n < 153)
		  s->lut[s->lut_n++] = v;
		return;
	}
	if (s->n < sizeof s->data)
	  s->data[s->n++] = v;
	command_done(s);
}

static void shown(void* st, uint8_t* bw, uint8_t* red)
{
	ssd_t* s = st;
	int n = s->rows * s->row_b;
	memcpy(bw, s->disp[0], n);
	if (s->red)
	  memcpy(red, s->disp[1], n);
	else
	  memset(red, 0, n);
}

/* the last refresh's waveform, and each pixel's LUT: 2 red + bw */
static int wave3(void* st, eb_wave_t* w, uint8_t* cls)
{
	ssd_t* s = st;
	eb_ssd1680_wave(w, s->wave);
	if (cls)
	  for (int y = 0; y < s->rows; y++)
	    for (int x = 0; x < s->row_b * 8; x++)
	    {
		    int i = y * s->row_b + (x >> 3), m = 0x80 >> (x & 7);
		    cls[y * s->row_b * 8 + x] = (s->disp[1][i] & m ? 2 : 0) | !!(s->disp[0][i] & m);
	    }
	return 1;
}

const panel_model_t panel_ssd1680 = {
	.name = "SSD1680", .module = "WeAct 2.9\" B/W/R", .fw_id = 0,
	.width = 128, .height = 296, .red = 1, .busy_low = 0,
	.rgb = { { 255, 255, 255 }, { 20, 20, 20 }, { 210, 30, 30 } },
	.shows = { { 190, 187, 189 }, { 29, 25, 36 }, { 124, 24, 25 } },   /* epbwr.c's, settled (redghost -c) */
	.state = sizeof(ssd_t),
	.init = init_bwr, .reset = reset, .cs = cs, .byte = byte, .shown = shown,
	.wave = NULL, .wave3 = wave3, .phys = "",
};

const panel_model_t panel_ssd1680_213 = {
	.name = "SSD1680", .module = "WeAct 2.13\" B/W", .fw_id = 2,
	.width = 122, .height = 250, .red = 0, .busy_low = 0,
	.rgb = { { 255, 255, 255 }, { 20, 20, 20 }, { 210, 30, 30 } },
	.shows = { { 236, 234, 226 }, { 28, 26, 18 }, { 210, 30, 30 } },   /* (the 4.2"'s: not measured) */
	.state = sizeof(ssd_t),
	.init = init_bw, .reset = reset, .cs = cs, .byte = byte, .shown = shown,
	.wave = NULL, .wave3 = NULL, .phys = "",
};

const panel_model_t panel_ssd1683 = {
	.name = "SSD1683", .module = "WeAct 4.2\" B/W", .fw_id = 3,
	.width = 400, .height = 300, .red = 0, .busy_low = 0,
	.rgb = { { 255, 255, 255 }, { 20, 20, 20 }, { 210, 30, 30 } },
	.shows = { { 236, 234, 226 }, { 28, 26, 18 }, { 210, 30, 30 } },   /* ep_grey()'s ends, as the UC8176's */
	.state = sizeof(ssd_t),
	.init = init_83, .reset = reset, .cs = cs, .byte = byte, .shown = shown,
	.wave = wave, .wave3 = NULL, .phys = "",
};
