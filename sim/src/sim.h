/*
 * sim.h - the zerogap simulator's core: the real runtime (src/runtime, the
 * keyboard device, LVGL, QuickJS) on a host instead of the Pi. Two front
 * ends drive it: the native command-line runner (main.cpp) and the browser
 * (web.cpp, compiled with Emscripten).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef ZG_SIM_H
#define ZG_SIM_H

#include <stdint.h>

#ifdef __cplusplus
class CUSBKeyboardDevice;
CUSBKeyboardDevice *ZgSimKeyboard (void);
void ZgSimClockStart (void);
extern "C" {
#endif

/* Boots: display of width x height, apps built in (the bundle compiled into
 * the simulator) plus those in <card>/apps (card 0: no SD card). Starts the
 * launcher. Returns 0 on success. */
int zg_sim_boot (int width, int height, const char *card);

/* Before zg_sim_boot: <dir>/<id> replaces the built-in app <id> (e.g.
 * <dir>/launcher, to work on the launcher). 0: none. */
void zg_sim_set_builtin_dir (const char *dir);

/* Before zg_sim_boot: the language, over the card's zerogap.txt (0: as
 * zerogap.txt says). zg_sim_boot fails if the system has no such language. */
void zg_sim_set_language (const char *tag);

/* After boot: the language for the apps started from now on, as a
 * settings app sets it. Returns 0 if the system has it. */
int zg_sim_language (const char *tag);

/* One pass of the main loop, as the kernel's: keyboard, LVGL (input,
 * timers, drawing), app host. Call often (every millisecond or so). */
void zg_sim_step (void);

/* Keys. Names as QEMU's sendkey ("a", "shift-a", "ctrl-c", "ret", "tab",
 * "spc", "backspace", "up", "meta_l", ...) or as the browser's
 * KeyboardEvent.key ("a", "A", "Enter", "Tab", "ArrowUp", "Meta", ...)
 * with ZG_SIM_MOD_* modifiers. A key stays down until zg_sim_key_up(),
 * repeating as Circle does (after 400 ms, every 80 ms). Return 0 if the
 * key is known. */
#define ZG_SIM_MOD_SHIFT	1
#define ZG_SIM_MOD_CTRL		2
#define ZG_SIM_MOD_ALT		4
int zg_sim_key_down_qemu (const char *name);
int zg_sim_key_down_dom (const char *key, int mods);
void zg_sim_key_up (void);

/* Starts the app with this id (as the launcher would), or the launcher
 * (id 0). Returns 0 if there is such an app. */
int zg_sim_launch (const char *id);

/* The keyboard layout (src/runtime/keylayout.h): "us", "br-abnt2". QEMU key
 * names are keys by their place on a US keyboard, so with "br-abnt2"
 * "semicolon" types ç, as on QEMU and on the Pi. Returns 0 if there is such
 * a layout. */
int zg_sim_keyboard (const char *layout);

/* The camera (src/runtime/synthcam.h), after boot. What it films:
 * zg_sim_camera ("none") no camera, ("scene") nothing in particular (the
 * default); a QR code of these bytes; a picture (8-bit grey, scaled to
 * fit); or frames as they come (the browser's webcam). Changes are logged
 * (never what a code holds), except quiet ones (animated codes). Return 0 on success,
 * -1 if refused (too long, too large, unknown mode). */
int zg_sim_camera (const char *mode);
int zg_sim_camera_qr (const uint8_t *data, unsigned length, int quiet);	/* quiet: not logged */
int zg_sim_camera_picture (const uint8_t *grey, unsigned width, unsigned height);
int zg_sim_camera_push (const uint8_t *grey, unsigned width, unsigned height);
// the same in colour: R, G, B interleaved (pictures up to 2048 a side)
int zg_sim_camera_picture_rgb (const uint8_t *rgb, unsigned width, unsigned height);
int zg_sim_camera_push_rgb (const uint8_t *rgb, unsigned width, unsigned height);

/* The mouse: absolute position in screen pixels, left button state. */
void zg_sim_pointer (int x, int y, int pressed);

/* The screen: RGB565 pixels, width * height, rows top to bottom. */
const uint16_t *zg_sim_frame (int *width, int *height);
/* Bumped whenever LVGL drew something. */
unsigned zg_sim_frame_serial (void);

/* Writes the screen as a PNG file. Returns 0 on success. */
int zg_sim_screenshot (const char *path);

/* Front-end hooks: a log line (no newline), and the system halted. */
void ZgSimLogLine (const char *line);
void ZgSimHalted (void);

#ifdef __cplusplus
}
#endif

#endif
