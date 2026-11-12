// Stand-in for Circle's GPIO pins in the simulator (sim/): only what
// src/runtime/epd.cpp uses. The pins lead to the simulated e-paper panel
// (sim/src/epaper_sim.cpp): DC and RST to its controller, BUSY from it,
// pulled as configured when no panel is plugged in.
//
// SPDX-License-Identifier: GPL-3.0-or-later
#ifndef _circle_gpiopin_h
#define _circle_gpiopin_h
#include <circle/types.h>

#define LOW		0
#define HIGH		1

enum TGPIOMode
{
	GPIOModeInput,
	GPIOModeOutput,
	GPIOModeInputPullUp,
	GPIOModeInputPullDown,
	GPIOModeUnknown
};

class CGPIOPin
{
public:
	CGPIOPin (unsigned nPin, TGPIOMode Mode);
	~CGPIOPin (void);

	void SetMode (TGPIOMode Mode);
	void Write (unsigned nValue);
	unsigned Read (void) const;

private:
	unsigned m_nPin;
	TGPIOMode m_Mode;
};

#endif
