// The simulator's devices: just the keyboard ("ukbd1").
//
// SPDX-License-Identifier: GPL-3.0-or-later
#ifndef _circle_devicenameservice_h
#define _circle_devicenameservice_h
#include <circle/device.h>
#include <circle/types.h>
class CDeviceNameService
{
public:
	static CDeviceNameService *Get (void);
	CDevice *GetDevice (const char *pName, boolean bBlockDevice);
};
#endif
