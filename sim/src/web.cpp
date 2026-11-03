//
// web.cpp - the simulator's browser front end (built with Emscripten, see
// sim/Makefile "make web"). JavaScript drives it:
//
//   const zg = await createZerogap ({ onLog, onHalt });
//   // the SD card: Emscripten's in-memory file system, apps in /card/apps
//   zg.FS.mkdirTree ("/card/apps/myapp"); zg.FS.writeFile (..., text);
//   zg._zg_sim_boot (640, 480, cardPathPtr)      // or 0: no card
//   setInterval (() => zg._zg_web_run (), 4)      // main loop
//   zg._zg_web_frame () -> pointer to RGB565 pixels (zg.HEAPU16)
//   zg._zg_sim_key_down_dom (keyPtr, mods), zg._zg_sim_key_up ()
//   zg._zg_sim_pointer (x, y, pressed)
//
// To restart (Run again, Reset), JavaScript makes a new instance: every
// boot starts from a fresh machine, as on the device.
//
// sim/web/zerogap.js wraps all of this in a small class.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "sim.h"
#include <circle/timer.h>
#include <emscripten.h>

EM_JS (void, JsLog, (const char *pLine), {
	if (Module.onLog) Module.onLog (UTF8ToString (pLine));
	else console.log (UTF8ToString (pLine));
});

EM_JS (void, JsHalted, (void), {
	if (Module.onHalt) Module.onHalt ();
});

void ZgSimLogLine (const char *pLine)
{
	JsLog (pLine);
}

void ZgSimHalted (void)
{
	JsHalted ();
}

extern "C" {

// One pass of the main loop. Call every few milliseconds (setInterval):
// LVGL itself only redraws every 5 ms.
EMSCRIPTEN_KEEPALIVE void zg_web_run (void)
{
	zg_sim_step ();
}

EMSCRIPTEN_KEEPALIVE const uint16_t *zg_web_frame (void)
{
	int w, h;
	return zg_sim_frame (&w, &h);
}

EMSCRIPTEN_KEEPALIVE int zg_web_width (void)
{
	int w, h;
	zg_sim_frame (&w, &h);
	return w;
}

EMSCRIPTEN_KEEPALIVE int zg_web_height (void)
{
	int w, h;
	zg_sim_frame (&w, &h);
	return h;
}

}
