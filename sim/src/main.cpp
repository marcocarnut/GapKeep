//
// main.cpp - zgsim, the zerogap simulator on the command line.
//
// Runs zerogap (the launcher and apps) on the host, drawing into memory.
// The log goes to stdout, as the Pi's goes to the serial port. Commands,
// one per line on stdin, drive it; answers start with "#" on stdout:
//
//   key <name>              press and release a key (QEMU sendkey names:
//                           a, shift-a, ctrl-c, ret, tab, spc, up, meta_l...)
//   keydown <name>          press a key and hold it (it auto-repeats)
//   keyup                   release it
//   pointer <x> <y> <0|1>   mouse at (x, y), left button up (0) or down (1)
//   shot <file.png>         screenshot; answers "#shot <file.png>"
//   launch [<id>]           start that app (or the launcher), as the
//                           launcher would
//   quit                    exit
//
// Usage: zgsim [--size WxH] [--card DIR] [--app ID] [--for SECONDS] [--shot FILE.png]
//   --card DIR      DIR plays the SD card: apps load from DIR/apps
//   --app ID        start that app right after boot
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
	const char *pCard = 0, *pShot = 0, *pApp = 0;
	double fFor = -1;
	for (int i = 1; i < argc; i++)
	{
		if (strcmp (argv[i], "--size") == 0 && i + 1 < argc
		    && sscanf (argv[i + 1], "%dx%d", &nWidth, &nHeight) == 2)
		{
			i++;
		}
		else if (strcmp (argv[i], "--card") == 0 && i + 1 < argc)	pCard = argv[++i];
		else if (strcmp (argv[i], "--app") == 0 && i + 1 < argc)	pApp = argv[++i];
		else if (strcmp (argv[i], "--for") == 0 && i + 1 < argc)	fFor = atof (argv[++i]);
		else if (strcmp (argv[i], "--shot") == 0 && i + 1 < argc)	pShot = argv[++i];
		else
		{
			fprintf (stderr, "usage: zgsim [--size WxH] [--card DIR] [--app ID] [--for SECONDS] [--shot FILE.png]\n");
			return 2;
		}
	}
	if (nWidth < 320 || nHeight < 240 || nWidth > 4096 || nHeight > 4096)
	{
		fprintf (stderr, "zgsim: --size from 320x240 to 4096x4096\n");
		return 2;
	}

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
