//
// imx219.cpp
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "imx219.h"
#include <circle/timer.h>
#include <circle/util.h>
#include <assert.h>

static const u8 SlaveAddress = 0x10;		// 7 bits (SPEC 2.3)
static const u16 ModelID = 0x0219;

// registers (SPEC 4.3)
#define REG_MODEL_ID		0x0000
#define REG_MODE_SELECT		0x0100		// 0 standby, 1 streaming
#define REG_ANA_GAIN		0x0157		// then DIG_GAIN 0x0158-9, COARSE_INT 0x015A-B
#define REG_TEST_PATTERN	0x0600

// One I2C transfer: up to four bytes from nRegister on. Multi-byte values
// go in one transfer, so their bytes are latched together.
struct TRegWrite
{
	u16	nRegister;
	u8	nCount;
	u8	Value[4];
};

// The mode, in the order of SPEC 4.3 (A to E); mode_select = 1 comes later,
// once Unicam is listening.
static const TRegWrite Mode[] =
{
	// A: standby, then the six-step access sequence that opens the
	// manufacturer registers 0x3000-0x5FFF
	{0x0100, 1, {0x00}},
	{0x30EB, 1, {0x05}},
	{0x30EB, 1, {0x0C}},
	{0x300A, 1, {0xFF}},
	{0x300B, 1, {0xFF}},
	{0x30EB, 1, {0x05}},
	{0x30EB, 1, {0x09}},

	// B: undocumented values that every Raspberry Pi mode writes
	{0x455E, 1, {0x00}},
	{0x471E, 1, {0x4B}},
	{0x4767, 1, {0x0F}},
	{0x4750, 1, {0x14}},
	{0x4540, 1, {0x00}},
	{0x47B4, 1, {0x14}},
	{0x4713, 1, {0x30}},
	{0x478B, 1, {0x10}},
	{0x478F, 1, {0x10}},
	{0x4793, 1, {0x10}},
	{0x4797, 1, {0x0E}},
	{0x479B, 1, {0x0E}},

	// C: two lanes, automatic D-PHY timing, INCK 24 MHz, PLLs for
	// 912 Mbit/s per lane, RAW8
	{0x0114, 1, {0x01}},		// CSI_LANE_MODE: 2 lanes
	{0x0128, 1, {0x00}},		// DPHY_CTRL: automatic
	{0x012A, 2, {0x18, 0x00}},	// EXCK_FREQ: 24.0 MHz
	{0x0301, 1, {0x05}},		// VTPXCK_DIV
	{0x0303, 1, {0x01}},		// VTSYCK_DIV
	{0x0304, 1, {0x03}},		// PREPLLCK_VT_DIV
	{0x0305, 1, {0x03}},		// PREPLLCK_OP_DIV
	{0x0306, 2, {0x00, 0x39}},	// PLL_VT_MPY 57
	{0x030B, 1, {0x01}},		// OPSYCK_DIV
	{0x030C, 2, {0x00, 0x72}},	// PLL_OP_MPY 114
	{0x0309, 1, {0x08}},		// OPPXCK_DIV: 8 bits per pixel
	{0x018C, 2, {0x08, 0x08}},	// CSI_DATA_FORMAT_A: RAW8

	// D: the readout window and output size come from the mode
	// (Configure); both modes bin 2x2 in the analogue domain and are
	// turned by 180 degrees (the module is mounted upside down)
	{0x0162, 2, {0x0D, 0x78}},	// LINE_LENGTH_A 3448
	{0x0170, 1, {0x01}},		// X_ODD_INC_A
	{0x0171, 1, {0x01}},		// Y_ODD_INC_A
	{0x0172, 1, {0x03}},		// IMG_ORIENTATION_A: both flips
	{0x0174, 1, {0x03}},		// BINNING_MODE_H_A: x2 analogue
	{0x0175, 1, {0x03}},		// BINNING_MODE_V_A

	// E: frame length (exposure, gains and the test pattern follow, from
	// the caller's values)
	{0x0160, 2, {CZgIMX219::FrameLength >> 8, CZgIMX219::FrameLength & 0xFF}},
};

// The recommended mode: the centre 1280x960, binned (SPEC 1, 4.3 D).
const TZgIMX219Mode CZgIMX219::ModeCentre = {"centre", 1000, 2279, 752, 1711, 640, 480};
// The whole array, binned (SPEC 6.7): 6.6 times the data, the full field
// of view.
const TZgIMX219Mode CZgIMX219::ModeFull = {"full", 0, 3279, 0, 2463, 1640, 1232};

CZgIMX219::CZgIMX219 (CI2CMaster *pI2C)
:	m_pI2C (pI2C),
	m_nLastResult (0)
{
	assert (m_pI2C != 0);
}

boolean CZgIMX219::Write (u16 nRegister, const u8 *pValues, unsigned nCount)
{
	u8 Buffer[2 + 12];
	assert (nCount <= sizeof Buffer - 2);
	Buffer[0] = nRegister >> 8;		// 16-bit index, MSB first
	Buffer[1] = nRegister & 0xFF;
	memcpy (Buffer + 2, pValues, nCount);

	int nResult = m_pI2C->Write (SlaveAddress, Buffer, 2 + nCount);
	if (nResult != (int) (2 + nCount))
	{
		m_nLastResult = nResult;
		return FALSE;
	}
	return TRUE;
}

boolean CZgIMX219::Write8 (u16 nRegister, u8 uchValue)
{
	return Write (nRegister, &uchValue, 1);
}

boolean CZgIMX219::Write16 (u16 nRegister, u16 usValue)
{
	u8 Value[2] = {(u8) (usValue >> 8), (u8) (usValue & 0xFF)};
	return Write (nRegister, Value, 2);
}

// A write of the index, then a read: the sensor keeps the index between
// transfers, so the STOP in between is fine (SPEC 2.3), and the plain
// Write/Read pair avoids the repeated-start path.
boolean CZgIMX219::Read (u16 nRegister, u8 *pValues, unsigned nCount)
{
	u8 Index[2] = {(u8) (nRegister >> 8), (u8) (nRegister & 0xFF)};
	int nResult = m_pI2C->Write (SlaveAddress, Index, 2);
	if (nResult != 2)
	{
		m_nLastResult = nResult;
		return FALSE;
	}

	nResult = m_pI2C->Read (SlaveAddress, pValues, nCount);
	if (nResult != (int) nCount)
	{
		m_nLastResult = nResult;
		return FALSE;
	}
	return TRUE;
}

boolean CZgIMX219::Probe (u16 *pID)
{
	u8 ID[2] = {0, 0};
	*pID = 0;
	if (!Read (REG_MODEL_ID, ID, 2))
	{
		return FALSE;
	}
	*pID = ID[0] << 8 | ID[1];
	return *pID == ModelID;
}

boolean CZgIMX219::SettleLanes (void)
{
	if (!Write8 (REG_MODE_SELECT, 1))
	{
		return FALSE;
	}
	CTimer::SimpleusDelay (100);
	if (!Write8 (REG_MODE_SELECT, 0))
	{
		return FALSE;
	}
	CTimer::SimpleusDelay (100);
	return TRUE;
}

boolean CZgIMX219::Configure (const TZgIMX219Mode &rMode, unsigned nExposure, unsigned nAnalogueCode,
			      unsigned nDigitalGain, unsigned nTestPattern)
{
	for (unsigned i = 0; i < sizeof Mode / sizeof Mode[0]; i++)
	{
		if (!Write (Mode[i].nRegister, Mode[i].Value, Mode[i].nCount))
		{
			return FALSE;
		}
	}

	// X_ADD_STA_A .. y_output_size are adjacent: one transfer; then the
	// test pattern's window, the size of the output, so that the colour
	// bars span the picture
	u16 Window[] = {rMode.nXStart, rMode.nXEnd, rMode.nYStart, rMode.nYEnd,
			rMode.nWidth, rMode.nHeight};
	u8 Values[sizeof Window / sizeof Window[0] * 2];
	for (unsigned i = 0; i < sizeof Window / sizeof Window[0]; i++)
	{
		Values[2 * i] = Window[i] >> 8;
		Values[2 * i + 1] = Window[i] & 0xFF;
	}
	if (   !Write (0x0164, Values, sizeof Values)
	    || !Write16 (0x0624, rMode.nWidth)		// TP_WINDOW_WIDTH
	    || !Write16 (0x0626, rMode.nHeight))	// TP_WINDOW_HEIGHT
	{
		return FALSE;
	}

	return    SetExposure (nExposure, nAnalogueCode, nDigitalGain)
	       && SetTestPattern (nTestPattern);
}

boolean CZgIMX219::StartStreaming (void)
{
	return Write8 (REG_MODE_SELECT, 1);
}

boolean CZgIMX219::StopStreaming (void)
{
	return Write8 (REG_MODE_SELECT, 0);
}

boolean CZgIMX219::SetExposure (unsigned nExposure, unsigned nAnalogueCode, unsigned nDigitalGain)
{
	// beyond FRM_LENGTH_A - 4 the sensor would stretch the frame (SPEC 4.5)
	if (nExposure < MinExposure)		nExposure = MinExposure;
	if (nExposure > MaxExposure)		nExposure = MaxExposure;
	if (nAnalogueCode > MaxAnalogueCode)	nAnalogueCode = MaxAnalogueCode;
	if (nDigitalGain < MinDigitalGain)	nDigitalGain = MinDigitalGain;
	if (nDigitalGain > MaxDigitalGain)	nDigitalGain = MaxDigitalGain;

	// 0x0157 ANA_GAIN_GLOBAL_A, 0x0158-9 DIG_GAIN_GLOBAL_A,
	// 0x015A-B COARSE_INTEGRATION_TIME_A: adjacent, so one transfer
	u8 Values[5] =
	{
		(u8) nAnalogueCode,
		(u8) (nDigitalGain >> 8), (u8) (nDigitalGain & 0xFF),
		(u8) (nExposure >> 8), (u8) (nExposure & 0xFF)
	};
	return Write (REG_ANA_GAIN, Values, sizeof Values);
}

boolean CZgIMX219::SetTestPattern (unsigned nPattern)
{
	return Write16 (REG_TEST_PATTERN, (u16) nPattern);
}
