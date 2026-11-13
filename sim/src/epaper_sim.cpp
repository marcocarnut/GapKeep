//
// epaper_sim.cpp - e-paper panels at the other end of the simulator's SPI0
// and GPIO pins (sim/include/circle/spimaster.h, gpiopin.h), under the real
// driver (src/runtime/epd.cpp): each byte it sends goes to EPDPages' model
// of the SSD1680 (sim/src/epd/panel_ssd1680.c), which keeps its RAM, plays
// a refresh and holds BUSY up as the real one does, and, for the 2.9"
// B/W/R, to its pigments' physics (epbwr.c), for the browser IDE's view.
//
// Panels are things with names, plugged in and out (sim.h: "epaper plug",
// "epaper unplug"): each keeps what it shows when unplugged, as e-paper
// does, so a test can write two panels in turn and look at both. Without a
// panel, BUSY reads as its pull resistor makes it.
//
// What a panel shows is never logged.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "sim.h"
#include "../../src/runtime/epd.h"
#include <circle/gpiopin.h>
#include <circle/spimaster.h>
#include <circle/logger.h>
#include <circle/timer.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

extern "C" {
#include "epd/panel.h"
}

static const char From[] = "epaper-sim";

struct TSimPanel
{
	char Name[32];
	const panel_model_t *pModel;
	void *pState;			// the controller's (panel_model_t.state bytes)
	panel_host_t Host;
	double fBusyUntil;		// ms
	uint8_t *pShown[2];		// the planes at the last refresh: B/W (1 white), red (1 red)
	epbwr_t *pPhysics;		// the B/W/R's pigments, or 0
	double fRefreshAt, fRefreshMs;	// the last refresh: its start and BUSY's length
	unsigned nRefreshes;
	TSimPanel *pNext;
};

static TSimPanel *s_pPanels;		// every panel there is
static TSimPanel *s_pPlugged;		// the one plugged in, or 0
static double s_fRefreshMs = -1;	// BUSY for a refresh: < 0 as long as its waveform
static unsigned s_nSerial;		// bumped when what the panel shows may have changed
static const char *s_pSetModel;		// --epaper
// The pigments' physics costs seconds of CPU a refresh, computed when the
// panel is looked at (or when the next refresh begins: all at once, inside
// an SPI write). The browser shows it; the command line has it only when
// asked (gksim --epaper-physics), so that scenarios run at full speed.
#ifdef __EMSCRIPTEN__
static boolean s_bPhysics = TRUE;
#else
static boolean s_bPhysics = FALSE;
#endif

static int s_Level[64];			// GPIO outputs
static TGPIOMode s_Mode[64];

static double NowMs (void)
{
	return CTimer::GetClockTicks64 () / 1000.0;
}

// --- the panel's host side (EPDPages' panel_host_t) -------------------------------

static double HostMs (void *ctx)
{
	return NowMs ();
}

static void HostBusyFor (void *ctx, double fMs)
{
	((TSimPanel *) ctx)->fBusyUntil = NowMs () + fMs;
}

static void HostDrawing (void *ctx)
{
}

static void HostRefresh (void *ctx, double fBusyMs, int bPartial)
{
	TSimPanel *p = (TSimPanel *) ctx;
	p->pModel->shown (p->pState, p->pShown[0], p->pShown[1]);
	if (p->pPhysics != 0 && p->pModel->wave3 != 0)
	{
		static eb_wave_t Wave;		// (24 KB: not on the stack)
		uint8_t *pClass = (uint8_t *) malloc ((size_t) p->pModel->width * p->pModel->height);
		p->pModel->wave3 (p->pState, &Wave, pClass);
		eb_refresh (p->pPhysics, NowMs (), &Wave, pClass);
		free (pClass);
	}
	p->fBusyUntil = NowMs () + fBusyMs;
	p->fRefreshAt = NowMs ();
	p->fRefreshMs = fBusyMs;
	p->nRefreshes++;
	s_nSerial++;
	CLogger::Get ()->Write (From, LogNotice, "panel %s: refresh %u (%s), BUSY for %.0f ms", p->Name,
				p->nRefreshes, bPartial ? "partial" : "full", fBusyMs);
}

static void HostLog (void *ctx, int bError, const char *pMessage)
{
	CLogger::Get ()->Write (From, bError ? LogWarning : LogNotice, "panel %s: %s",
				((TSimPanel *) ctx)->Name, pMessage);
}

static TSimPanel *NewPanel (const char *pName, const panel_model_t *pModel)
{
	TSimPanel *p = (TSimPanel *) calloc (1, sizeof *p);
	snprintf (p->Name, sizeof p->Name, "%s", pName);
	p->pModel = pModel;
	p->Host.ctx = p;
	p->Host.ms = HostMs;
	p->Host.busy_for = HostBusyFor;
	p->Host.drawing = HostDrawing;
	p->Host.refresh = HostRefresh;
	p->Host.log = HostLog;
	p->Host.refresh_ms = s_fRefreshMs;
	p->pState = calloc (1, pModel->state);
	pModel->init (p->pState, &p->Host);
	size_t nPlane = (size_t) (pModel->width + 7) / 8 * pModel->height;
	p->pShown[0] = (uint8_t *) malloc (nPlane);
	p->pShown[1] = (uint8_t *) calloc (1, nPlane);
	memset (p->pShown[0], 0xFF, nPlane);		// white, as it comes
	if (pModel->wave3 != 0 && s_bPhysics)
	{
		eb_params_t Params;
		eb_params_default (&Params);
		eb_params_parse (&Params, pModel->phys, 0);
		p->pPhysics = eb_new (pModel->width, pModel->height, &Params);
	}
	p->pNext = s_pPanels;
	s_pPanels = p;
	return p;
}

// --- the wires ----------------------------------------------------------------------

static const TGkSPIDevice *Wires (void)
{
	return CGkEPD::GetPanel ();
}

CGPIOPin::CGPIOPin (unsigned nPin, TGPIOMode Mode)
:	m_nPin (nPin), m_Mode (Mode)
{
	SetMode (Mode);
}

CGPIOPin::~CGPIOPin (void)
{
	if (m_nPin < 64)
	{
		s_Mode[m_nPin] = GPIOModeInput;
	}
}

void CGPIOPin::SetMode (TGPIOMode Mode)
{
	m_Mode = Mode;
	if (m_nPin < 64)
	{
		s_Mode[m_nPin] = Mode;
		if (Mode == GPIOModeOutput)
		{
			s_Level[m_nPin] = 0;	// as Circle: an output starts low
		}
	}
}

void CGPIOPin::Write (unsigned nValue)
{
	if (m_nPin >= 64 || m_Mode != GPIOModeOutput)
	{
		return;
	}
	int nOld = s_Level[m_nPin];
	s_Level[m_nPin] = nValue ? 1 : 0;
	const TGkSPIDevice *pWires = Wires ();
	if (   pWires != 0 && m_nPin == pWires->nRST && !nOld && nValue
	    && s_pPlugged != 0)
	{
		s_pPlugged->pModel->reset (s_pPlugged->pState);		// out of reset
	}
}

unsigned CGPIOPin::Read (void) const
{
	if (m_nPin >= 64)
	{
		return LOW;
	}
	const TGkSPIDevice *pWires = Wires ();
	if (pWires != 0 && m_nPin == pWires->nBUSY)
	{
		if (s_pPlugged != 0)
		{
			// the SSD1680's BUSY: high while busy (and in reset)
			boolean bBusy = NowMs () < s_pPlugged->fBusyUntil || !s_Level[pWires->nRST];
			return bBusy ^ s_pPlugged->pModel->busy_low ? HIGH : LOW;
		}
		return m_Mode == GPIOModeInputPullDown ? LOW : HIGH;	// floating: pulled
	}
	return s_Level[m_nPin] ? HIGH : LOW;
}

CSPIMaster::CSPIMaster (unsigned nClockSpeed, unsigned CPOL, unsigned CPHA, unsigned nDevice)
:	m_nClockSpeed (nClockSpeed)
{
}

CSPIMaster::~CSPIMaster (void)
{
}

boolean CSPIMaster::Initialize (void)
{
	return TRUE;
}

void CSPIMaster::SetClock (unsigned nClockSpeed)
{
	m_nClockSpeed = nClockSpeed;
}

int CSPIMaster::Write (unsigned nChipSelect, const void *pBuffer, unsigned nCount)
{
	const TGkSPIDevice *pWires = Wires ();
	TSimPanel *p = s_pPlugged;
	if (p != 0 && pWires != 0 && nChipSelect == pWires->nCS && s_Level[pWires->nRST])
	{
		const uint8_t *pData = (const uint8_t *) pBuffer;
		int nDC = s_Level[pWires->nDC];
		p->pModel->cs (p->pState, 0);
		for (unsigned i = 0; i < nCount; i++)
		{
			p->pModel->byte (p->pState, nDC, pData[i]);
		}
		p->pModel->cs (p->pState, 1);
	}
	return (int) nCount;
}

boolean GkSPIControllerPresent (void)
{
	return TRUE;
}

// --- the simulator's side (sim.h) ---------------------------------------------------

void gk_sim_epaper_physics (int on)
{
	s_bPhysics = on != 0;
}

void gk_sim_set_epaper (const char *model)
{
	s_pSetModel = model;
}

void GkSimEPaperBoot (void)
{
	if (s_pSetModel != 0)
	{
		if (!CGkEPD::SetModel (s_pSetModel, "--epaper"))
		{
			CLogger::Get ()->Write (From, LogWarning, "--epaper %s: one of none, %s expected",
						s_pSetModel, CGkEPD::ModelNames ());
		}
		CGkEPD::ConfigDone ();
	}
	// a panel of that model plugged in from the start
	const TGkSPIDevice *pWires = Wires ();
	if (pWires != 0)
	{
		gk_sim_epaper_plug ("1", 0);
	}
}

int gk_sim_epaper_plug (const char *name, const char *model)
{
	const panel_model_t *pModel = 0;
	if (model != 0 && *model != '\0')
	{
		pModel = panel_find (model);
	}
	else if (Wires () != 0)
	{
		pModel = panel_find (Wires ()->pModel->pName);
	}
	TSimPanel *p = s_pPanels;
	while (p != 0 && strcmp (p->Name, name) != 0)
	{
		p = p->pNext;
	}
	if (p == 0)
	{
		if (pModel == 0)
		{
			return -1;
		}
		p = NewPanel (name, pModel);
	}
	else if (pModel != 0 && pModel != p->pModel)
	{
		return -1;		// that panel is another model
	}
	s_pPlugged = p;
	p->fBusyUntil = 0;
	p->pModel->reset (p->pState);	// powered up: as out of reset (its RAM lost)
	p->fBusyUntil = 0;
	s_nSerial++;
	CLogger::Get ()->Write (From, LogNotice, "panel %s (%s) plugged in", p->Name, p->pModel->module);
	return 0;
}

void gk_sim_epaper_unplug (void)
{
	if (s_pPlugged != 0)
	{
		CLogger::Get ()->Write (From, LogNotice, "panel %s unplugged", s_pPlugged->Name);
		s_pPlugged = 0;
		s_nSerial++;
	}
}

void gk_sim_epaper_refresh_ms (double ms)
{
	s_fRefreshMs = ms;
	for (TSimPanel *p = s_pPanels; p != 0; p = p->pNext)
	{
		p->Host.refresh_ms = ms;
	}
}

// The plugged-in panel as its viewer sees it, mounted as gapkeep.txt's
// epaper_rotate says (its native rows turned that many quarter turns
// clockwise; 0 if none is configured): w x h, and the quarter turns
static boolean View (int *pWidth, int *pHeight, int *pTurns)
{
	if (s_pPlugged == 0)
	{
		return FALSE;
	}
	const panel_model_t *m = s_pPlugged->pModel;
	const TGkSPIDevice *pWires = Wires ();
	*pTurns = pWires != 0 ? pWires->nRotate & 3 : 0;
	*pWidth = *pTurns & 1 ? m->height : m->width;
	*pHeight = *pTurns & 1 ? m->width : m->height;
	return TRUE;
}

// native (nx, ny) for the view's (x, y): each quarter turn clockwise
// undone, the last first (V_k(x, y) = V_k-1(y, h_k-1 - 1 - x))
static size_t NativeIndex (const panel_model_t *m, int nTurns, int x, int y)
{
	for (int k = nTurns; k > 0; k--)
	{
		int nPrevHeight = (k - 1) & 1 ? m->width : m->height;
		int t = x;
		x = y;
		y = nPrevHeight - 1 - t;
	}
	return (size_t) y * m->width + x;
}

int gk_sim_epaper_size (int *width, int *height)
{
	int nTurns;
	return View (width, height, &nTurns) ? 0 : -1;
}

void gk_sim_epaper_rgb (uint8_t *rgb, int physics)
{
	int w, h, nTurns;
	if (!View (&w, &h, &nTurns))
	{
		return;
	}
	TSimPanel *p = s_pPlugged;
	const panel_model_t *m = p->pModel;
	uint8_t *pRGBA = 0;
	if (physics && p->pPhysics != 0)
	{
		pRGBA = (uint8_t *) malloc ((size_t) 4 * m->width * m->height);
		eb_advance (p->pPhysics, NowMs ());
		eb_rgba (p->pPhysics, pRGBA);
	}
	int nRowBytes = (m->width + 7) / 8;
	for (int y = 0; y < h; y++)
	{
		for (int x = 0; x < w; x++)
		{
			size_t i = NativeIndex (m, nTurns, x, y);
			uint8_t *pOut = rgb + 3 * ((size_t) y * w + x);
			if (pRGBA != 0)
			{
				memcpy (pOut, pRGBA + 4 * i, 3);
				continue;
			}
			int nx = (int) (i % m->width), ny = (int) (i / m->width);
			uint8_t nBit = 0x80 >> (nx & 7);
			size_t b = (size_t) ny * nRowBytes + nx / 8;
			int c = m->red && (p->pShown[1][b] & nBit) ? 2 : (p->pShown[0][b] & nBit) ? 0 : 1;
			memcpy (pOut, m->rgb[c], 3);
		}
	}
	free (pRGBA);
}

unsigned gk_sim_epaper_serial (void)
{
	// while a refresh's physics plays, every call is a change
	if (s_pPlugged != 0 && s_pPlugged->pPhysics != 0 && eb_progress (s_pPlugged->pPhysics, NowMs (), 0) >= 0)
	{
		return ++s_nSerial;
	}
	return s_nSerial;
}

double gk_sim_epaper_progress (void)
{
	TSimPanel *p = s_pPlugged;
	if (p == 0 || p->fRefreshMs <= 0 || NowMs () >= p->fRefreshAt + p->fRefreshMs)
	{
		return -1;
	}
	return (NowMs () - p->fRefreshAt) / p->fRefreshMs;
}

const char *gk_sim_epaper_plugged (void)
{
	return s_pPlugged != 0 ? s_pPlugged->Name : 0;
}

// What the plugged-in panel shows (its RAM at the last refresh, in the
// module's colours; or, physics, as its pigments look now), landscape,
// with an 8-pixel white margin (the quiet zone a QR code reader wants, as
// the module's bezel gives it).
int gk_sim_epaper_shot (const char *path, int physics)
{
	int w, h;
	if (gk_sim_epaper_size (&w, &h) != 0)
	{
		return -1;
	}
	const int nMargin = 8;
	int W = w + 2 * nMargin, H = h + 2 * nMargin;
	uint8_t *pPanel = (uint8_t *) malloc ((size_t) 3 * w * h);
	gk_sim_epaper_rgb (pPanel, physics);
	uint8_t *pImage = (uint8_t *) malloc ((size_t) 3 * W * H);
	memset (pImage, 0xFF, (size_t) 3 * W * H);
	for (int y = 0; y < h; y++)
	{
		memcpy (pImage + 3 * ((size_t) (y + nMargin) * W + nMargin), pPanel + 3 * (size_t) y * w, 3 * (size_t) w);
	}
	int nResult = gk_sim_write_png (path, pImage, W, H);
	free (pPanel);
	free (pImage);
	return nResult;
}
