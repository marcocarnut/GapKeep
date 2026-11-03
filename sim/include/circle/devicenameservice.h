// The simulator's devices: just the keyboard ("ukbd1").
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
