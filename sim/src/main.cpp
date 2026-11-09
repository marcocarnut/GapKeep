//
// main.cpp - zgsim, the zerogap simulator on the command line.
//
// Runs zerogap (the launcher and apps) on the host, drawing into memory.
// The log goes to stdout, as the Pi's goes to the serial port. Commands,
// one per line on stdin, drive it; answers start with "#" on stdout:
//
//   key <name>              press and release a key (QEMU sendkey names:
//                           a, shift-a, ctrl-c, alt_r-q, ret, tab, spc, up,
//                           meta_l...)
//   keydown <name>          press a key and hold it (it auto-repeats)
//   keyup                   release it
//   pointer <x> <y> <0|1>   mouse at (x, y), left button up (0) or down (1)
//   wheel <notches>         the mouse wheel where the pointer is: > 0 down
//   shot <file.png>         screenshot; answers "#shot <file.png>"
//   launch [<id>]           start that app (or the launcher), as the
//                           launcher would
//   keyboard <layout>       the keyboard layout: us, br-abnt2
//   camera qr <text>        the camera films a QR code of <text> (UTF-8)
//   camera qrhex <hex>      ... of these bytes
//   camera picture <file>   ... a picture: binary PGM (P5) or PPM (P6, in colour)
//   camera scene            ... nothing in particular (the default)
//   camera none             there is no camera
//   language <tag>          the language of the apps started from now on
//                           (pt-BR, qps...), as a settings app sets it
//   quit                    exit
//
// Usage: zgsim [--size WxH] [--card DIR] [--builtin DIR] [--app ID] [--lang TAG] [--for SECONDS] [--shot FILE.png]
//   --card DIR      DIR plays the SD card: apps load from DIR/apps
//   --builtin DIR   DIR/<id> replaces the built-in app <id> (DIR/launcher:
//                   a launcher to try out; see docs/SIMULATOR.md)
//   --app ID        start that app right after boot
//   --lang TAG      the language (over the card's zerogap.txt): en, pt-BR,
//                   qps (the pseudo-language: shows untranslated text)...
//   --for SECONDS   run that long, then exit (default: until "quit" or EOF)
//   --shot FILE     with --for: take a screenshot before exiting
//
// tools/zgsim wraps it for app development, tools/qemu_harness.py --sim
// plays test scenarios on it.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "sim.h"
#include <circle/timer.h>
#include <lvgl/lvgl/lvgl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

void ZgSimLogLine (const char *pLine)
{
	printf ("%s\n", pLine);
	fflush (stdout);
}

void ZgSimHalted (void)
{
}

static const unsigned KeyHoldTicks = 60000;	// "key": 60 ms, as the harness holds keys

static unsigned s_nReleaseAt;
static int s_bReleasePending;

// A binary PGM (P5) or PPM (P6) file, 8 bits: its pixels, *pChannels
// bytes each (1 grey, 3 RGB). 0 if it isn't one.
static uint8_t *ReadPicture (const char *pPath, unsigned *pWidth, unsigned *pHeight,
			     unsigned *pChannels)
{
	FILE *f = fopen (pPath, "rb");
	if (f == 0)
	{
		return 0;
	}
	char Magic[3] = {0};
	unsigned w = 0, h = 0, nMax = 0;
	uint8_t *pPixels = 0;
	if (   fscanf (f, "%2s %u %u %u", Magic, &w, &h, &nMax) == 4 && nMax == 255
	    && (strcmp (Magic, "P5") == 0 || strcmp (Magic, "P6") == 0)
	    && w > 0 && h > 0 && w <= 8192 && h <= 8192 && fgetc (f) != EOF)
	{
		*pChannels = Magic[1] == '6' ? 3 : 1;
		pPixels = (uint8_t *) malloc ((size_t) w * h * *pChannels);
		if (fread (pPixels, *pChannels, (size_t) w * h, f) != (size_t) w * h)
		{
			free (pPixels);
			pPixels = 0;
		}
	}
	fclose (f);
	*pWidth = w;
	*pHeight = h;
	return pPixels;
}

static void CameraCommand (char *pArgs)
{
	char *pRest = strchr (pArgs, ' ');
	if (pRest != 0)
	{
		*pRest++ = '\0';
	}
	else
	{
		pRest = pArgs + strlen (pArgs);
	}

	if (strcmp (pArgs, "qr") == 0)
	{
		if (zg_sim_camera_qr ((const uint8_t *) pRest, strlen (pRest), 0) != 0)
		{
			printf ("#error camera qr: too long\n");
		}
	}
	else if (strcmp (pArgs, "qrhex") == 0)
	{
		size_t n = strlen (pRest) / 2;
		uint8_t *pData = (uint8_t *) malloc (n + 1);
		size_t i = 0;
		for (; i < n; i++)
		{
			unsigned b;
			if (sscanf (pRest + 2 * i, "%2x", &b) != 1)
			{
				break;
			}
			pData[i] = (uint8_t) b;
		}
		if (i != n || strlen (pRest) % 2 != 0 || zg_sim_camera_qr (pData, n, 0) != 0)
		{
			printf ("#error camera qrhex <hex>: bad hex or too long\n");
		}
		free (pData);
	}
	else if (strcmp (pArgs, "picture") == 0)
	{
		unsigned w, h, nChannels;
		uint8_t *pPixels = ReadPicture (pRest, &w, &h, &nChannels);
		if (   pPixels == 0
		    || (nChannels == 3 ? zg_sim_camera_picture_rgb (pPixels, w, h)
				       : zg_sim_camera_picture (pPixels, w, h)) != 0)
		{
			printf ("#error camera picture %s: not a binary PGM or PPM file (8 bits),"
				" or too large\n", pRest);
		}
		free (pPixels);
	}
	else if (zg_sim_camera (pArgs) != 0)
	{
		printf ("#error camera qr <text> | qrhex <hex> | picture <file> | scene | none\n");
	}
}

static int Command (char *pLine)
{
	char *pArgs = strchr (pLine, ' ');
	if (pArgs != 0)
	{
		*pArgs++ = '\0';
	}
	else
	{
		pArgs = pLine + strlen (pLine);
	}

	if (strcmp (pLine, "key") == 0 || strcmp (pLine, "keydown") == 0)
	{
		if (zg_sim_key_down_qemu (pArgs) != 0)
		{
			printf ("#error unknown key %s\n", pArgs);
		}
		else if (pLine[3] == '\0')
		{
			s_nReleaseAt = CTimer::GetClockTicks () + KeyHoldTicks;
			s_bReleasePending = 1;
		}
	}
	else if (strcmp (pLine, "keyup") == 0)
	{
		zg_sim_key_up ();
	}
	else if (strcmp (pLine, "pointer") == 0)
	{
		int x, y, b;
		if (sscanf (pArgs, "%d %d %d", &x, &y, &b) == 3)
		{
			zg_sim_pointer (x, y, b);
		}
		else
		{
			printf ("#error pointer <x> <y> <0|1>\n");
		}
	}
	else if (strcmp (pLine, "wheel") == 0)
	{
		int n;
		if (sscanf (pArgs, "%d", &n) == 1)
		{
			zg_sim_wheel (n);
		}
		else
		{
			printf ("#error wheel <notches>\n");
		}
	}
	else if (strcmp (pLine, "shot") == 0)
	{
		// draw everything pending first
		for (int i = 0; i < 3; i++)
		{
			lv_refr_now (0);
		}
		printf (zg_sim_screenshot (pArgs) == 0 ? "#shot %s\n" : "#error shot %s\n", pArgs);
	}
	else if (strcmp (pLine, "launch") == 0)
	{
		if (zg_sim_launch (pArgs[0] ? pArgs : 0) != 0)
		{
			printf ("#error no app %s\n", pArgs);
		}
	}
	else if (strcmp (pLine, "camera") == 0)
	{
		CameraCommand (pArgs);
	}
	else if (strcmp (pLine, "language") == 0)
	{
		if (zg_sim_language (pArgs) != 0)
		{
			printf ("#error no language %s\n", pArgs);
		}
	}
	else if (strcmp (pLine, "keyboard") == 0)
	{
		if (zg_sim_keyboard (pArgs) != 0)
		{
			printf ("#error no keyboard layout %s\n", pArgs);
		}
	}
	else if (strcmp (pLine, "quit") == 0)
	{
		return 0;
	}
	else if (pLine[0] != '\0')
	{
		printf ("#error unknown command %s\n", pLine);
	}
	fflush (stdout);
	return 1;
}

int main (int argc, char **argv)
{
	int nWidth = 640, nHeight = 480;
	const char *pCard = 0, *pBuiltin = 0, *pShot = 0, *pApp = 0;
	double fFor = -1;
	for (int i = 1; i < argc; i++)
	{
		if (strcmp (argv[i], "--size") == 0 && i + 1 < argc
		    && sscanf (argv[i + 1], "%dx%d", &nWidth, &nHeight) == 2)
		{
			i++;
		}
		else if (strcmp (argv[i], "--card") == 0 && i + 1 < argc)	pCard = argv[++i];
		else if (strcmp (argv[i], "--builtin") == 0 && i + 1 < argc)	pBuiltin = argv[++i];
		else if (strcmp (argv[i], "--app") == 0 && i + 1 < argc)	pApp = argv[++i];
		else if (strcmp (argv[i], "--for") == 0 && i + 1 < argc)	fFor = atof (argv[++i]);
		else if (strcmp (argv[i], "--shot") == 0 && i + 1 < argc)	pShot = argv[++i];
		else if (strcmp (argv[i], "--lang") == 0 && i + 1 < argc)	zg_sim_set_language (argv[++i]);
		else
		{
			fprintf (stderr, "usage: zgsim [--size WxH] [--card DIR] [--builtin DIR] [--app ID] [--lang TAG] [--for SECONDS] [--shot FILE.png]\n");
			return 2;
		}
	}
	if (nWidth < 320 || nHeight < 240 || nWidth > 4096 || nHeight > 4096)
	{
		fprintf (stderr, "zgsim: --size from 320x240 to 4096x4096\n");
		return 2;
	}

	zg_sim_set_builtin_dir (pBuiltin);
	if (zg_sim_boot (nWidth, nHeight, pCard) != 0)
	{
		return 1;
	}
	if (pApp != 0 && zg_sim_launch (pApp) != 0)
	{
		fprintf (stderr, "zgsim: no app %s\n", pApp);
		return 1;
	}

	char Line[4096];
	size_t nLine = 0;
	int bInput = fFor < 0;		// with --for, stdin is not read
	for (;;)
	{
		zg_sim_step ();

		if (s_bReleasePending && (int) (CTimer::GetClockTicks () - s_nReleaseAt) >= 0)
		{
			zg_sim_key_up ();
			s_bReleasePending = 0;
		}

		if (fFor >= 0 && CTimer::GetClockTicks64 () >= (unsigned long long) (fFor * CLOCKHZ))
		{
			if (pShot != 0)
			{
				lv_refr_now (0);
				if (zg_sim_screenshot (pShot) != 0)
				{
					fprintf (stderr, "zgsim: cannot write %s\n", pShot);
					return 1;
				}
			}
			return 0;
		}

		struct pollfd Poll = {0, POLLIN, 0};
		if (!bInput || poll (&Poll, 1, 1) <= 0)		// otherwise: 1 ms idle
		{
			if (!bInput)
			{
				usleep (1000);
			}
			continue;
		}

		char c;
		ssize_t n = read (0, &c, 1);
		if (n <= 0)
		{
			return 0;		// EOF
		}
		if (c == '\n' || nLine == sizeof Line - 1)
		{
			Line[nLine] = '\0';
			nLine = 0;
			if (!Command (Line))
			{
				return 0;
			}
		}
		else if (c != '\r')
		{
			Line[nLine++] = c;
		}
	}
}
