//
// epaper.cpp
//
// ui.epaper's off-screen display and its refresh job (epaper.h).
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#include "epaper.h"
#include "jobs.h"
#include "../crypto/wipe.h"
#include <circle/logger.h>
#include <circle/util.h>

static const char From[] = "epaper";

// --- the display -----------------------------------------------------------------

// The picture's way to the panel: quarter turns counter-clockwise (EPDPages'
// rotation), for an app's orientation and flip on the panel as mounted
// (gapkeep.txt's epaper_rotate: m quarter turns clockwise, as its viewer
// sees it). The viewer sees the native rows turned m clockwise, so a
// picture turned m counter-clockwise on its way there shows upright. A
// panel mounted taller than wide (a 2.9" as it comes, m 0 or 180) asked
// for landscape gets a quarter turn more (counter-clockwise: the panel
// is read turned clockwise), and the other way round; flip, a half turn.
unsigned CGkEPaperDisplay::Rotation (boolean bPortrait, boolean bFlip)
{
	const TGkSPIDevice *pPanel = CGkEPD::GetPanel ();
	if (pPanel == 0)
	{
		return 0;
	}
	unsigned m = pPanel->nRotate & 3;
	boolean bTall = (pPanel->pModel->nHeight > pPanel->pModel->nWidth) != ((m & 1) != 0);
	return (m + (bPortrait != bTall ? 1 : 0) + (bFlip ? 2 : 0)) & 3;
}

CGkEPaperDisplay *CGkEPaperDisplay::Open (unsigned nRotation, const char **ppError)
{
	const TGkSPIDevice *pPanel = CGkEPD::GetPanel ();
	if (pPanel == 0)
	{
		*ppError = "no e-paper panel is configured (\"epaper\" in the card's gapkeep.txt)";
		return 0;
	}
	if (!GkSPIControllerPresent ())
	{
		*ppError = "no e-paper panel: this machine has no SPI controller";
		return 0;
	}

	CGkEPaperDisplay *pThis = new CGkEPaperDisplay;
	pThis->m_pModel = pPanel->pModel;
	pThis->m_nRotation = nRotation & 3;
	boolean bTurned = pThis->m_nRotation & 1;
	pThis->m_nWidth = bTurned ? pThis->m_pModel->nHeight : pThis->m_pModel->nWidth;
	pThis->m_nHeight = bTurned ? pThis->m_pModel->nWidth : pThis->m_pModel->nHeight;

	// (lv_display_create applies the system's theme to its screen: ours below)
	lv_display_t *pDisplay = lv_display_create (pThis->m_nWidth, pThis->m_nHeight);
	pThis->m_pDisplay = pDisplay;
	lv_display_set_color_format (pDisplay, LV_COLOR_FORMAT_RGB565);
	pThis->m_pBuffer = lv_draw_buf_create (pThis->m_nWidth, pThis->m_nHeight, LV_COLOR_FORMAT_RGB565, 0);
	if (pThis->m_pBuffer == 0)
	{
		lv_display_delete (pDisplay);
		delete pThis;
		*ppError = "not enough memory for the panel's picture";
		return 0;
	}
	lv_draw_buf_clear (pThis->m_pBuffer, 0);
	lv_display_set_draw_buffers (pDisplay, pThis->m_pBuffer, 0);
	lv_display_set_render_mode (pDisplay, LV_DISPLAY_RENDER_MODE_FULL);
	lv_display_set_flush_cb (pDisplay, Flush);
	lv_display_set_user_data (pDisplay, pThis);

	memset (&pThis->m_Theme, 0, sizeof pThis->m_Theme);
	pThis->m_Theme.apply_cb = ThemeApply;
	pThis->m_Theme.disp = pDisplay;
	pThis->m_Theme.color_primary = lv_color_black ();
	pThis->m_Theme.color_secondary = lv_color_hex (0xFF0000);
	pThis->m_Theme.font_small = pThis->m_Theme.font_normal = pThis->m_Theme.font_large = LV_FONT_DEFAULT;
	lv_display_set_theme (pDisplay, &pThis->m_Theme);

	// black on white, the whole screen, no scrolling
	lv_obj_t *pScreen = lv_display_get_screen_active (pDisplay);
	pThis->m_pScreen = pScreen;
	lv_obj_remove_style_all (pScreen);
	lv_obj_set_style_bg_color (pScreen, lv_color_white (), 0);
	lv_obj_set_style_bg_opa (pScreen, LV_OPA_COVER, 0);
	lv_obj_set_style_text_color (pScreen, lv_color_black (), 0);
	lv_obj_set_style_text_font (pScreen, LV_FONT_DEFAULT, 0);
	lv_obj_remove_flag (pScreen, LV_OBJ_FLAG_SCROLLABLE);
	lv_obj_set_scrollbar_mode (pScreen, LV_SCROLLBAR_MODE_OFF);

	CLogger::Get ()->Write (From, LogNotice, "%s opened, %ux%u", pThis->m_pModel->pModule,
				pThis->m_nWidth, pThis->m_nHeight);
	return pThis;
}

CGkEPaperDisplay::~CGkEPaperDisplay (void)
{
	lv_display_delete (m_pDisplay);		// its screens, every widget on them
	lv_draw_buf_destroy (m_pBuffer);	// (LVGL's heap: wiped)
	CLogger::Get ()->Write (From, LogNotice, "%s closed", m_pModel->pModule);
}

void CGkEPaperDisplay::Flush (lv_display_t *pDisplay, const lv_area_t *pArea, u8 *pPixels)
{
	// the whole screen is in the buffer (LV_DISPLAY_RENDER_MODE_FULL): the
	// panel takes it at refresh
	lv_display_flush_ready (pDisplay);
}

// Panels and Buttons get a black outline; the rest is black on white from
// the screen. (Containers lose their theme: js_ui.cpp removes it.)
void CGkEPaperDisplay::ThemeApply (lv_theme_t *pTheme, lv_obj_t *pObj)
{
	if (lv_obj_get_parent (pObj) == 0)
	{
		return;		// a screen or a layer
	}
	if (lv_obj_check_type (pObj, &lv_obj_class) || lv_obj_check_type (pObj, &lv_button_class))
	{
		lv_obj_set_style_border_color (pObj, lv_color_black (), 0);
		lv_obj_set_style_border_width (pObj, 2, 0);
		lv_obj_set_style_radius (pObj, 6, 0);
		lv_obj_set_style_pad_all (pObj, 8, 0);
		lv_obj_set_style_bg_opa (pObj, LV_OPA_TRANSP, 0);
	}
}

// One pixel of the picture: 0 white, 1 black, 2 red
static inline unsigned PixelClass (u16 nPixel, boolean bRed)
{
	unsigned r = (nPixel >> 11) << 3, g = ((nPixel >> 5) & 0x3F) << 2, b = (nPixel & 0x1F) << 3;
	if (r >= 128 && g < 96 && b < 96)
	{
		return bRed ? 2 : 1;		// red, or black on a panel without
	}
	return r * 299 + g * 587 + b * 114 < 128 * 1000 ? 1 : 0;
}

u8 *CGkEPaperDisplay::Snapshot (unsigned *pBytes)
{
	lv_refr_now (m_pDisplay);

	unsigned nNativeW = m_pModel->nWidth, nNativeH = m_pModel->nHeight;
	unsigned nRowBytes = (nNativeW + 7) / 8;
	unsigned nPlane = nRowBytes * nNativeH;
	unsigned nBytes = nPlane * (m_pModel->bRed ? 2 : 1);
	u8 *pPlanes = new u8[nBytes];
	memset (pPlanes, 0xFF, nPlane);				// white
	if (m_pModel->bRed)
	{
		memset (pPlanes + nPlane, 0x00, nPlane);	// no red
	}

	const u8 *pData = m_pBuffer->data;
	unsigned nStride = m_pBuffer->header.stride;
	for (unsigned y = 0; y < m_nHeight; y++)
	{
		const u16 *pRow = (const u16 *) (pData + y * nStride);
		for (unsigned x = 0; x < m_nWidth; x++)
		{
			unsigned nClass = PixelClass (pRow[x], m_pModel->bRed);
			if (nClass == 0)
			{
				continue;
			}
			// EPDPages' to_native(): a half turn, then a quarter
			unsigned lx = x, ly = y;
			if (m_nRotation & 2)
			{
				lx = m_nWidth - 1 - lx;
				ly = m_nHeight - 1 - ly;
			}
			unsigned nx = lx, ny = ly;
			if (m_nRotation & 1)
			{
				nx = ly;
				ny = m_nWidth - 1 - lx;
			}
			unsigned i = ny * nRowBytes + nx / 8;
			u8 nBit = 0x80 >> (nx & 7);
			if (nClass == 1)
			{
				pPlanes[i] &= ~nBit;			// black
			}
			else
			{
				pPlanes[nPlane + i] |= nBit;		// red (white in B/W)
			}
		}
	}

	*pBytes = nBytes;
	return pPlanes;
}

// --- the refresh job ---------------------------------------------------------------

struct TRefreshJob
{
	u8 *pPlanes;
	unsigned nBytes;
	boolean bStarted;
	const char *pError;
};

static boolean RefreshStep (void *pState, unsigned nDeadline)
{
	TRefreshJob *pJob = (TRefreshJob *) pState;
	CGkEPD *pEPD = CGkEPD::Get ();
	if (pEPD == 0)
	{
		pJob->pError = "no e-paper panel is configured";
		return FALSE;
	}
	if (!pJob->bStarted)
	{
		const TGkEPDModel *pModel = CGkEPD::GetPanel ()->pModel;
		unsigned nPlane = (pModel->nWidth + 7) / 8 * pModel->nHeight;
		if (pJob->nBytes != nPlane * (pModel->bRed ? 2 : 1))
		{
			pJob->pError = "the panel changed";	// (the simulator's --epaper)
			return FALSE;
		}
		if (!pEPD->Start (pJob->pPlanes, pModel->bRed ? pJob->pPlanes + nPlane : 0))
		{
			pJob->pError = pEPD->GetError () != 0 ? pEPD->GetError () : "the panel is busy";
			return FALSE;
		}
		gk_wipe (pJob->pPlanes, pJob->nBytes);		// the driver has a copy
		pJob->bStarted = TRUE;
	}
	int nResult = pEPD->Step (nDeadline);
	if (nResult < 0)
	{
		pJob->pError = pEPD->GetError ();
	}
	return nResult > 0;
}

static double RefreshProgress (void *pState)
{
	TRefreshJob *pJob = (TRefreshJob *) pState;
	CGkEPD *pEPD = CGkEPD::Get ();
	return pJob->bStarted && pEPD != 0 ? pEPD->GetProgress () : 0;
}

static JSValue RefreshFinish (JSContext *ctx, void *pState)
{
	TRefreshJob *pJob = (TRefreshJob *) pState;
	if (pJob->pError == 0)
	{
		return JS_UNDEFINED;
	}
	JSValue Error = JS_NewError (ctx);
	JS_DefinePropertyValueStr (ctx, Error, "message", JS_NewString (ctx, pJob->pError),
				   JS_PROP_WRITABLE | JS_PROP_CONFIGURABLE);
	return JS_Throw (ctx, Error);
}

static void RefreshFree (JSContext *ctx, void *pState)
{
	TRefreshJob *pJob = (TRefreshJob *) pState;
	CGkEPD *pEPD = CGkEPD::Get ();
	if (pJob->bStarted && pEPD != 0 && pEPD->IsBusy ())
	{
		pEPD->Abort ();			// its app stopped
	}
	gk_wipe (pJob->pPlanes, pJob->nBytes);
	delete [] pJob->pPlanes;
	delete pJob;
}

// an AbortSignal's abort: a refresh not started is dropped; one started,
// as CGkEPD::Cancel() says (the waveform runs to deep sleep)
static boolean RefreshAbort (void *pState)
{
	TRefreshJob *pJob = (TRefreshJob *) pState;
	CGkEPD *pEPD = CGkEPD::Get ();
	return pJob->bStarted && pEPD != 0 && pEPD->Cancel ();
}

static boolean RefreshIdle (void *pState)
{
	TRefreshJob *pJob = (TRefreshJob *) pState;
	CGkEPD *pEPD = CGkEPD::Get ();
	return pJob->bStarted && pEPD != 0 && pEPD->Idle ();
}

static const TGkJobOps RefreshOps =
{
	"e-paper refresh", RefreshStep, RefreshProgress, RefreshFinish, RefreshFree, RefreshAbort, RefreshIdle
};

JSValue CGkEPaperDisplay::Refresh (JSContext *ctx, const TGkJobOptions &Options)
{
	TRefreshJob *pJob = new TRefreshJob;
	memset (pJob, 0, sizeof *pJob);
	pJob->pPlanes = Snapshot (&pJob->nBytes);
	return GkJobStart (ctx, &RefreshOps, pJob, Options);	// (an aborted signal: rejected, nothing sent)
}
