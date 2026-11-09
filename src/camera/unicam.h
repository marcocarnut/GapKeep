//
// unicam.h
//
// The BCM2835's CSI-2 receiver ("Unicam"), instance 1, as the Pi Zero's
// camera connector uses it: two data lanes, a non-continuous clock, RAW8
// written as received into a rotation of DMA buffers. Written from
// docs/camera/SPEC.md (sections 3 and 5); docs/camera/IMPLEMENTATION.md
// has the decisions.
//
// Buffers. The hardware takes the address of the next frame's buffer at
// frame start (FS), and cannot be paused while the sensor streams, so it
// must always have somewhere to write. Each buffer is, at any time:
//
//   Free     nobody's
//   Next     programmed, taken at the next FS
//   Writing  taken at the last FS; complete at frame end (FE)
//   Ready    the newest complete frame
//   InUse    the CPU is reading it (TakeFrame .. ReleaseFrame)
//
// At FE, Writing becomes Ready (an older Ready, never taken, goes back to
// Free). At FS, Next becomes Writing (a Writing that never saw its FE is
// dropped), and a Free buffer becomes Next. With four buffers one is always
// free at that point: Writing, Ready and InUse are at most one each. So the
// consumer always gets the newest frame, and never a buffer being written.
//
// Cache. The CPU never writes the buffers. They are cleaned and
// invalidated once before Unicam gets them (no dirty line may later be
// written back over a frame), and invalidated again (Circle's clean and
// invalidate: the lines are clean) by TakeFrame, before the CPU reads.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _gk_unicam_h
#define _gk_unicam_h

#include <circle/gpioclock.h>
#include <circle/types.h>

class CGkUnicam
{
public:
	static const unsigned Buffers = 4;

	CGkUnicam (void);
	~CGkUnicam (void);

	// The power domain and the CAM1 ("lp") clock. FALSE: the block does
	// not answer with its reset values (unpowered or unclocked).
	boolean PowerOn (void);
	void PowerOff (void);

	// Bring-up (SPEC 5.3) up to, not including, the sensor's stream-on.
	// nStride: bytes per line, a multiple of 32.
	boolean Start (unsigned nWidth, unsigned nHeight, unsigned nStride);
	// The stop sequence (SPEC 5.6, after the sensor's standby). The
	// buffers are freed.
	void Stop (void);

	// The newest complete frame, or 0. The caller owns it until
	// ReleaseFrame(), and must call that before the next TakeFrame.
	const u8 *TakeFrame (void);
	void ReleaseFrame (void);

	// counters, from the interrupt handler
	unsigned GetFramesStarted (void) const		{ return m_nStarted; }
	unsigned GetFramesCompleted (void) const	{ return m_nCompleted; }
	unsigned GetFramesNotTaken (void) const		{ return m_nNotTaken; }
	unsigned GetFramesIncomplete (void) const	{ return m_nIncomplete; }
	unsigned GetLinesInLastFrame (void) const	{ return m_nLastLines; }
	unsigned long long GetLastFrameEndTicks (void) const	{ return m_nLastFrameEnd; }
	// frame starts counted and the time between the first and the last
	// (CLOCKHZ ticks): the frame rate, measured
	void GetFrameStartTiming (unsigned *pCount, unsigned long long *pTicks) const;
	// STA error bits seen since the last call (and clears them)
	u32 GetErrors (void);
	static void DescribeErrors (u32 nErrors, char *pBuffer, unsigned nSize);

	// Logs the receiver's main registers (for diagnosis; no image data).
	void DumpRegisters (const char *pWhen);

private:
	static void InterruptHandler (void *pParam);
	void Interrupt (void);
	void FrameStart (void);
	void FrameEnd (void);
	void Program (unsigned nBuffer);	// as the next frame's buffer
	void FreeBuffers (void);

private:
	enum TState { StateFree, StateNext, StateWriting, StateReady, StateInUse };

	CGPIOClock m_Clock;
	boolean m_bPowered;
	boolean m_bRunning;
	unsigned m_nStride;
	unsigned m_nHeight;
	unsigned m_nBufferSize;
	u8 *m_pBuffer[Buffers];
	volatile TState m_State[Buffers];
	volatile int m_nNext, m_nWriting, m_nReady, m_nInUse;	// -1: none

	volatile unsigned m_nStarted;
	volatile unsigned m_nCompleted;
	volatile unsigned m_nNotTaken;		// Ready, replaced by a newer frame
	volatile unsigned m_nIncomplete;	// FS without FE
	volatile unsigned m_nLastLines;
	volatile unsigned long long m_nFirstFrameStart;
	volatile unsigned long long m_nLastFrameStart;
	volatile unsigned long long m_nLastFrameEnd;
	volatile u32 m_nErrors;
};

#endif
