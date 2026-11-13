//
// web.cpp - the simulator's browser front end (built with Emscripten, see
// sim/Makefile "make web"). JavaScript drives it:
//
//   const gk = await createGapkeep ({ onLog, onHalt });
//   // the SD card: Emscripten's in-memory file system, apps in /card/apps
//   gk.FS.mkdirTree ("/card/apps/myapp"); gk.FS.writeFile (..., text);
//   gk._gk_sim_boot (640, 480, cardPathPtr)      // or 0: no card
//   setInterval (() => gk._gk_web_run (), 4)      // main loop
//   gk._gk_web_frame () -> pointer to RGB565 pixels (gk.HEAPU16)
//   gk._gk_sim_key_down_dom (keyPtr, mods), gk._gk_sim_key_up ()
//   gk._gk_sim_pointer (x, y, pressed)
//
// To restart (Run again, Reset), JavaScript makes a new instance: every
// boot starts from a fresh machine, as on the device.
//
// sim/web/gapkeep.js wraps all of this in a small class.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "sim.h"
#include <circle/timer.h>
#include <emscripten.h>
#include <stdlib.h>

EM_JS (void, JsLog, (const char *pLine), {
	if (Module.onLog) Module.onLog (UTF8ToString (pLine));
	else console.log (UTF8ToString (pLine));
});

EM_JS (void, JsHalted, (void), {
	if (Module.onHalt) Module.onHalt ();
});

void GkSimLogLine (const char *pLine)
{
	JsLog (pLine);
}

void GkSimHalted (void)
{
	JsHalted ();
}

extern "C" {

// One pass of the main loop. Call every few milliseconds (setInterval):
// LVGL itself only redraws every 5 ms.
EMSCRIPTEN_KEEPALIVE void gk_web_run (void)
{
	gk_sim_step ();
}

EMSCRIPTEN_KEEPALIVE const uint16_t *gk_web_frame (void)
{
	int w, h;
	return gk_sim_frame (&w, &h);
}

EMSCRIPTEN_KEEPALIVE int gk_web_width (void)
{
	int w, h;
	gk_sim_frame (&w, &h);
	return w;
}

EMSCRIPTEN_KEEPALIVE int gk_web_height (void)
{
	int w, h;
	gk_sim_frame (&w, &h);
	return h;
}

// The e-paper panel plugged in (sim.h): its size (0 if none), and what it
// shows as RGB, w * h * 3 bytes, its pigments' physics where the model has
// them (the refresh as it happens), in a buffer that stays until the next
// call.
EMSCRIPTEN_KEEPALIVE int gk_web_epaper_width (void)
{
	int w, h;
	return gk_sim_epaper_size (&w, &h) == 0 ? w : 0;
}

EMSCRIPTEN_KEEPALIVE int gk_web_epaper_height (void)
{
	int w, h;
	return gk_sim_epaper_size (&w, &h) == 0 ? h : 0;
}

EMSCRIPTEN_KEEPALIVE const uint8_t *gk_web_epaper_frame (void)
{
	static uint8_t *s_pRGB;
	static size_t s_nSize;
	int w, h;
	if (gk_sim_epaper_size (&w, &h) != 0)
	{
		return 0;
	}
	size_t nSize = (size_t) w * h * 3;
	if (nSize > s_nSize)
	{
		free (s_pRGB);
		s_pRGB = (uint8_t *) malloc (nSize);
		s_nSize = nSize;
	}
	gk_sim_epaper_rgb (s_pRGB, 1);
	return s_pRGB;
}

}
