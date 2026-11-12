//
// spiprobe.cpp
//
// Whether the machine has SPI0 (runtime/epd.h): QEMU's raspi0 doesn't (its
// registers are an unimplemented device that reads 0), and Circle's
// CSPIMaster would wait for its "done" bit forever. The real controller
// keeps what is written to its clock divider (CLK, 16 bits): written, read
// back, put back.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "runtime/epd.h"
#include <circle/bcm2835.h>
#include <circle/memio.h>
#include <circle/synchronize.h>

#define ARM_SPI0_CLK	(ARM_IO_BASE + 0x204008)

boolean GkSPIControllerPresent (void)
{
	static int s_nPresent = -1;
	if (s_nPresent < 0)
	{
		PeripheralEntry ();
		u32 nOld = read32 (ARM_SPI0_CLK);
		write32 (ARM_SPI0_CLK, 0x1234);
		s_nPresent = (read32 (ARM_SPI0_CLK) & 0xFFFF) == 0x1234;
		write32 (ARM_SPI0_CLK, nOld);
		PeripheralExit ();
	}
	return s_nPresent;
}
