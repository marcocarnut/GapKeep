#ifndef _circle_device_h
#define _circle_device_h
class CDevice;
typedef void TDeviceRemovedHandler (CDevice *pDevice, void *pContext);
class CDevice
{
public:
	virtual ~CDevice (void) {}
	void *RegisterRemovedHandler (TDeviceRemovedHandler *pHandler, void *pContext = 0)
		{ m_pRemoved = pHandler; m_pRemovedContext = pContext; return this; }
	TDeviceRemovedHandler *m_pRemoved = 0;
	void *m_pRemovedContext = 0;
};
#endif
