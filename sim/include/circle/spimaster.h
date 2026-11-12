// Stand-in for Circle's SPI0 master in the simulator (sim/): only what
// src/runtime/epd.cpp uses. What is written on a chip select goes to the
// simulated device there (sim/src/epaper_sim.cpp), byte by byte, the chip
// select low before and high after, as on the Pi.
//
// SPDX-License-Identifier: GPL-3.0-or-later
#ifndef _circle_spimaster_h
#define _circle_spimaster_h
#include <circle/types.h>

class CSPIMaster
{
public:
	CSPIMaster (unsigned nClockSpeed = 500000, unsigned CPOL = 0, unsigned CPHA = 0,
		    unsigned nDevice = 0);
	~CSPIMaster (void);

	boolean Initialize (void);
	void SetClock (unsigned nClockSpeed);
	int Write (unsigned nChipSelect, const void *pBuffer, unsigned nCount);

private:
	unsigned m_nClockSpeed;
};

#endif
