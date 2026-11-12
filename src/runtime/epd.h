//
// epd.h
//
// E-paper panels on the GPIO header's SPI0 (docs/EPAPER.md): the models,
// what gapkeep.txt says is wired and where, and the driver, a full refresh
// as a state machine run in slices from the main loop (jobs.h), so nothing
// waits for the panel: a reset and the controller's init, both planes, the
// refresh with the panel's own (OTP) waveform, deep sleep.
//
// Panels are swapped while the system runs (one secret share per panel),
// so every refresh starts from a hardware reset and the init, never
// counting on the panel being the last one or keeping its state, and ends
// in deep sleep, after which it may be unplugged. A missing panel is told
// by BUSY: pulled up here, it stays high without one, and a refresh that
// never shows BUSY high didn't happen either.
//
// SPI0 is shared by the devices gapkeep.txt names, each on its chip select
// (CE0 or CE1): today one e-paper ("epaper"), tomorrow more of them or an
// SPI screen (TGkSPIDevice's kinds). Each device's DC, RST and BUSY are
// GPIOs of its own.
//
// Shared by the kernel and the simulator: CSPIMaster and CGPIOPin are
// Circle's on the Pi, and in the simulator (sim/include) a simulated panel
// (sim/src/epaper_sim.cpp, EPDPages' SSD1680 model) at the other end of the
// wires, so the same driver runs, byte for byte, in both.
//
// What a panel shows is never logged: it may be a secret (a share).
//
// The SSD1680 driver comes from EPDPages (src/epd.c, by Marco Carnut, the
// SSD1680 and SSD1683 parts, as proven on WeAct's modules), copied under
// GPL-3.0-or-later with its author's permission and turned from an AVR's
// banded drawing into whole planes over Circle's SPI and GPIO.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _epd_h
#define _epd_h

#include <circle/types.h>

class CSPIMaster;
class CGPIOPin;

enum TGkEPDFamily
{
	GkEPDSSD1680,		// WeAct's 2.9" B/W/R and 2.13" B/W
	GkEPDSSD1683		// WeAct's 4.2" B/W: the SSD1680's commands, more RAM
};

struct TGkEPDModel
{
	const char *pName;	// in gapkeep.txt: "weact-2.9-bwr"
	const char *pModule;	// for people: "WeAct 2.9\" B/W/R"
	TGkEPDFamily Family;
	unsigned nWidth;	// native: sources (RAM X, bits of a row)
	unsigned nHeight;	// native: gates (rows)
	unsigned nLandscape;	// the rotation (EPDPages': quarter turns counter-
				// clockwise) that draws it wider than tall
	boolean bRed;		// a red plane
	unsigned nXStart;	// the RAM X byte of column 0 (the SSD1680's first
				// source is S8 on these modules: 1)
	unsigned nRefreshMs;	// a full refresh's BUSY, about: for progress
	unsigned nTimeoutMs;	// gives up waiting for it after this
};

// One device on SPI0, as gapkeep.txt describes it.
struct TGkSPIDevice
{
	const char *pKey;		// its keys' prefix: "epaper"
	const TGkEPDModel *pModel;	// 0: none configured
	unsigned nCS;			// chip select: 0 (CE0, GPIO 8) or 1 (CE1, GPIO 7)
	unsigned nDC, nRST, nBUSY;	// GPIOs
	unsigned nHz;			// SPI clock
	unsigned nRotate;		// e-paper: how it is mounted, in quarter turns
					// clockwise as its viewer sees it (0..3)
};

// A GPIO the SPI devices' wires may use: on the header (2..27), and not
// one SPI0 (7..11), the serial port (14, 15) or the camera's probe (0, 1)
// has.
boolean GkEPDPinUsable (unsigned nPin);

// Implemented for each machine (src/spiprobe.cpp on the Pi, the simulator's
// own): whether SPI0 is there at all. QEMU's raspi0 has none (its registers
// read 0, and Circle's CSPIMaster would wait for it forever).
boolean GkSPIControllerPresent (void);

class CGkEPD
{
public:
	// --- configuration (gapkeep.txt, settings.cpp) ---

	// "epaper", "epaper_cs", "epaper_dc", "epaper_rst", "epaper_busy",
	// "epaper_spi_khz": TRUE if the key is one of these (refusals logged).
	static boolean Configure (const char *pKey, const char *pValue, unsigned nLine);
	// After gapkeep.txt (or without one): checks the devices against each
	// other (chip selects, pins) and logs what is configured. A device
	// whose wires clash is dropped.
	static void ConfigDone (void);
	// A sealed kernel's own (make EPAPER=weact-2.9-bwr EPAPER_DC=..., the
	// keys of gapkeep.txt): at boot, before any card. Then gapkeep.txt's
	// keys are ignored (logged). Nothing without GK_EPAPER.
	static void ConfigureBuiltIn (void);
	// Test builds (src/testshot.h, "#epaper ..."): "<model> [cs=ce0]
	// [dc=25] [rst=17] [busy=24] [spi_khz=4000]" or "none", as gapkeep.txt's
	// keys. FALSE if anything was refused (logged).
	static boolean ConfigureLine (const char *pLine, const char *pFrom);
	// The e-paper panel configured, or 0.
	static const TGkSPIDevice *GetPanel (void);
	// The model of this name, or 0. The list, ", "-separated, for messages.
	static const TGkEPDModel *FindModel (const char *pName);
	static const char *ModelNames (void);
	// Simulator only (gksim --epaper): configures the panel as gapkeep.txt
	// would (pName "none": none), over the card's.
	static boolean SetModel (const char *pName, const char *pFrom);

	// --- a refresh ---

	// The driver of the configured panel (0 if none), its pins set up on
	// first use.
	static CGkEPD *Get (void);

	// Starts a full refresh with these planes: the panel's native rows,
	// (nWidth + 7) / 8 bytes each, MSB the leftmost pixel; B/W 1 white,
	// red 1 red (0 for a panel without red). Copied. FALSE if a refresh
	// is going on.
	boolean Start (const u8 *pBW, const u8 *pRed);
	// Works until about nDeadline (CTimer clock ticks). 1: more to do;
	// 0: done, the panel asleep (it may be unplugged); -1: failed
	// (GetError()), the panel reset or left alone.
	int Step (unsigned nDeadline);
	double GetProgress (void) const;	// 0..1
	const char *GetError (void) const	{ return m_pError; }
	// Ends a refresh going on (its app stopped): the panel is left as it
	// is (it finishes a refresh on its own); the next one resets it.
	void Abort (void);
	// An AbortSignal's abort (epaper.cpp, jobs.h): see epd.cpp. TRUE: the
	// refresh goes on to deep sleep (Step until it ends), FALSE: stopped.
	boolean Cancel (void);
	// Nothing to do now (waiting): jobs.h's Idle.
	boolean Idle (void) const;
	boolean IsBusy (void) const		{ return m_State != StateIdle; }

private:
	CGkEPD (const TGkSPIDevice *pDevice);
	~CGkEPD (void);

	boolean Busy (void) const;
	void Command (u8 nCommand, const u8 *pData = 0, unsigned nLength = 0);
	void Command1 (u8 nCommand, u8 nData)	{ Command (nCommand, &nData, 1); }
	void Data (const u8 *pData, unsigned nLength);
	void Setup (void);
	boolean SendRows (unsigned nDeadline);
	void Fail (const char *pError);
	void FreePlanes (void);		// and ReleaseLines()
	boolean TakeLines (void);
	void ReleaseLines (void);
	void Next (int State, unsigned nMs);
	boolean Due (void) const;
	boolean Settled (void) const;

private:
	const TGkSPIDevice *m_pDevice;
	const TGkEPDModel *m_pModel;
	unsigned m_nRowBytes;
	CSPIMaster *m_pSPI;		// SPI0, during a refresh only (TakeLines())
	CGPIOPin *m_pDC, *m_pRST, *m_pBusy;

	enum
	{
		StateIdle,
		StateResetLow,		// RST low
		StateResetHigh,		// RST high, then...
		StateWaitReset,		// ...BUSY low: the controller is there
		StateWaitSoft,		// the soft reset: BUSY low again
		StatePlane,		// the B/W plane, then the red one, row by row
		StateRefresh		// the waveform: BUSY high, then low; deep sleep
	};
	int m_State;
	unsigned m_nStateStart;		// clock ticks
	unsigned m_nStateMs;		// how long the state may last
	u8 *m_pPlanes;			// B/W, then red (as Start() got them)
	unsigned m_nPlane;		// 0 B/W, 1 red
	unsigned m_nRow;		// rows of the plane sent
	boolean m_bSeenBusy;		// BUSY high since the refresh started
	boolean m_bDone;		// the last refresh ended well
	unsigned m_nLastPoll;		// BUSY's last read in StateRefresh
	// timings, for the log (clock ticks, us)
	unsigned m_nResetStart, m_nResetUs, m_nSoftUs, m_nBusyHighUs;
	boolean m_bWaitSawBusy, m_bResetSawBusy;
	unsigned m_nRefreshStart;
	const char *m_pError;

	static TGkSPIDevice s_Panel;
	static CGkEPD *s_pThis;
	static boolean s_bBuiltIn;	// the build's panel (ConfigureBuiltIn())
};

#endif
