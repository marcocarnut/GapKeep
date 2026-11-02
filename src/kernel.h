//
// kernel.h
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _kernel_h
#define _kernel_h

#include <circle/actled.h>
#include <circle/koptions.h>
#include <circle/devicenameservice.h>
#include <circle/screen.h>
#ifdef ZG_SERIAL_LOG
#include <circle/serial.h>
#endif
#include <circle/exceptionhandler.h>
#include <circle/interrupt.h>
#include <circle/timer.h>
#include <circle/logger.h>
#include <circle/usb/usbhcidevice.h>
#ifndef ZG_SEALED
#include <SDCard/emmc.h>
#endif
#include <lvgl/lvgl.h>
#include <circle/types.h>
#include "kbdindev.h"
#include "runtime/apphost.h"
#include "crypto/hwrng.h"
#ifdef ZG_TEST
#include "testshot.h"
#endif

#ifndef ZG_SERIAL_LOG
// Production builds for the Pi send nothing anywhere: the log goes here.
class CZgNullDevice : public CDevice
{
public:
	int Write (const void *pBuffer, size_t nCount)	{ return (int) nCount; }
};
#endif

enum TShutdownMode
{
	ShutdownNone,
	ShutdownHalt,
	ShutdownReboot
};

class CKernel
{
public:
	CKernel (void);
	~CKernel (void);

	boolean Initialize (void);

	TShutdownMode Run (void);

private:
	// do not change this order
	CActLED			m_ActLED;
	CKernelOptions		m_Options;
	CDeviceNameService	m_DeviceNameService;
	CScreenDevice		m_Screen;
#ifdef ZG_SERIAL_LOG
	CSerialDevice		m_Serial;
#else
	CZgNullDevice		m_NullLog;
#endif
	CExceptionHandler	m_ExceptionHandler;
	CInterruptSystem	m_Interrupt;
	CTimer			m_Timer;
	CLogger			m_Logger;
	CUSBHCIDevice		m_USBHCI;
#ifndef ZG_SEALED
	CEMMCDevice		m_EMMC;		// read once at boot, for /apps
#endif

	CZgRandom		m_Random;
	CLVGL			m_GUI;
	CKeyboardIndev		m_Keyboard;
	CAppHost		m_AppHost;
#ifdef ZG_TEST
	CTestShot		m_TestShot;
#endif
};

#endif
