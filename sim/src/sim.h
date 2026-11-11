/*
 * sim.h - the GapKeep simulator's core: the real runtime (src/runtime, the
 * keyboard device, LVGL, QuickJS) on a host instead of the Pi. Two front
 * ends drive it: the native command-line runner (main.cpp) and the browser
 * (web.cpp, compiled with Emscripten).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_SIM_H
#define GK_SIM_H

#include <stdint.h>

#ifdef __cplusplus
class CUSBKeyboardDevice;
CUSBKeyboardDevice *GkSimKeyboard (void);
void GkSimClockStart (void);
extern "C" {
#endif

/* Boots: display of width x height, apps built in (the bundle compiled into
 * the simulator) plus those in <card>/apps (card 0: no SD card). Starts the
 * launcher. Returns 0 on success. */
int gk_sim_boot (int width, int height, const char *card);

/* Before gk_sim_boot: <dir>/<id> replaces the built-in app <id> (e.g.
 * <dir>/launcher, to work on the launcher). 0: none. */
void gk_sim_set_builtin_dir (const char *dir);

/* Before gk_sim_boot: the language, over the card's gapkeep.txt (0: as
 * gapkeep.txt says). gk_sim_boot fails if the system has no such language. */
void gk_sim_set_language (const char *tag);

/* After boot: the language for the apps started from now on, as a
 * settings app sets it. Returns 0 if the system has it. */
int gk_sim_language (const char *tag);

/* One pass of the main loop, as the kernel's: keyboard, LVGL (input,
 * timers, drawing), app host. Call often (every millisecond or so). */
void gk_sim_step (void);

/* Keys. Names as QEMU's sendkey ("a", "shift-a", "ctrl-c", "ret", "tab",
 * "spc", "backspace", "up", "meta_l", ...) or as the browser's
 * KeyboardEvent.key ("a", "A", "Enter", "Tab", "ArrowUp", "Meta", ...)
 * with GK_SIM_MOD_* modifiers. A key stays down until gk_sim_key_up(),
 * repeating as Circle does (after 400 ms, every 80 ms). Return 0 if the
 * key is known. */
#define GK_SIM_MOD_SHIFT	1
#define GK_SIM_MOD_CTRL		2
#define GK_SIM_MOD_ALT		4
int gk_sim_key_down_qemu (const char *name);
int gk_sim_key_down_dom (const char *key, int mods);
void gk_sim_key_up (void);

/* Starts the app with this id (as the launcher would), or the launcher
 * (id 0). Returns 0 if there is such an app. */
int gk_sim_launch (const char *id);

/* The keyboard layout (src/runtime/keylayout.h): "us", "br-abnt2". QEMU key
 * names are keys by their place on a US keyboard, so with "br-abnt2"
 * "semicolon" types ç, as on QEMU and on the Pi. Returns 0 if there is such
 * a layout. */
int gk_sim_keyboard (const char *layout);

/* The camera (src/runtime/synthcam.h), after boot. What it films:
 * gk_sim_camera ("none") no camera, ("scene") nothing in particular (the
 * default); a QR code of these bytes; a picture (8-bit grey, scaled to
 * fit); or frames as they come (the browser's webcam). Changes are logged
 * (never what a code holds), except quiet ones (animated codes). Return 0 on success,
 * -1 if refused (too long, too large, unknown mode). */
int gk_sim_camera (const char *mode);
int gk_sim_camera_qr (const uint8_t *data, unsigned length, int quiet);	/* quiet: not logged */
int gk_sim_camera_picture (const uint8_t *grey, unsigned width, unsigned height);
int gk_sim_camera_push (const uint8_t *grey, unsigned width, unsigned height);
// the same in colour: R, G, B interleaved (pictures up to 2048 a side)
int gk_sim_camera_picture_rgb (const uint8_t *rgb, unsigned width, unsigned height);
int gk_sim_camera_push_rgb (const uint8_t *rgb, unsigned width, unsigned height);
/* 1 while an app has the camera open (a ui.Scanner): the browser IDE asks
 * for the webcam only then */
int gk_sim_camera_in_use (void);

/* USB devices (gk:usb), native builds only: a device a USB/IP server at
 * host:port offers under busid (0 or "": the first it lists) is plugged in,
 * and stays so: when the server drops it (unplugged, reset), it is detached,
 * and imported again when offered (sim/src/usbip.cpp). Detach pulls the
 * cable of busid (0: every one). Return 0 on success. The browser has no
 * TCP: its build has no USB devices. */
int gk_sim_usbip_attach (const char *host, unsigned port, const char *busid);
int gk_sim_usbip_detach (const char *busid);
void GkSimUSBIPPoll (void);

/* The mouse: absolute position in screen pixels, left button state. */
void gk_sim_pointer (int x, int y, int pressed);

/* The mouse wheel, where the pointer is: notches > 0 scroll down (show
 * what is below), < 0 up, as src/runtime/wheel.h. */
void gk_sim_wheel (int notches);

/* The screen: RGB565 pixels, width * height, rows top to bottom. */
const uint16_t *gk_sim_frame (int *width, int *height);
/* Bumped whenever LVGL drew something. */
unsigned gk_sim_frame_serial (void);

/* Writes the screen as a PNG file. Returns 0 on success. */
int gk_sim_screenshot (const char *path);

/* Front-end hooks: a log line (no newline), and the system halted. */
void GkSimLogLine (const char *line);
void GkSimHalted (void);

#ifdef __cplusplus
}
#endif

#endif
