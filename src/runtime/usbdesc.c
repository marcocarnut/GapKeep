/*
 * usbdesc.c - see usbdesc.h.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "usbdesc.h"
#include "textcheck.h"
#include <string.h>

#define DESC_DEVICE		1
#define DESC_CONFIGURATION	2
#define DESC_STRING		3
#define DESC_INTERFACE		4

static uint16_t Get16 (const uint8_t *p)
{
	return (uint16_t) (p[0] | p[1] << 8);
}

int gk_usb_parse_device (const uint8_t *p, size_t n, gk_usb_device_desc_t *pDesc)
{
	memset (pDesc, 0, sizeof *pDesc);
	if (p == 0 || n < 18 || p[0] != 18 || p[1] != DESC_DEVICE)
	{
		return -1;
	}
	uint8_t nMax = p[7];
	if (nMax != 8 && nMax != 16 && nMax != 32 && nMax != 64)	/* USB 2.0 9.6.1 */
	{
		return -1;
	}
	pDesc->device_class = p[4];
	pDesc->max_packet0 = nMax;
	pDesc->vid = Get16 (p + 8);
	pDesc->pid = Get16 (p + 10);
	pDesc->bcd_device = Get16 (p + 12);
	pDesc->i_manufacturer = p[14];
	pDesc->i_product = p[15];
	pDesc->i_serial = p[16];
	pDesc->num_configurations = p[17];
	return 0;
}

int gk_usb_config_total (const uint8_t *p, size_t n)
{
	if (p == 0 || n < 9 || p[0] < 9 || p[1] != DESC_CONFIGURATION)
	{
		return -1;
	}
	unsigned nTotal = Get16 (p + 2);
	if (nTotal < 9 || nTotal > GK_USB_MAX_CONFIG_SIZE)
	{
		return -1;
	}
	return (int) nTotal;
}

int gk_usb_parse_config (const uint8_t *p, size_t n, gk_usb_config_t *pConfig)
{
	memset (pConfig, 0, sizeof *pConfig);
	int nTotal = gk_usb_config_total (p, n);
	if (nTotal < 0 || (size_t) nTotal != n || p[0] > n)
	{
		return -1;
	}
	pConfig->value = p[5];

	size_t i = p[0];
	while (i < n)
	{
		if (n - i < 2)
		{
			return -1;
		}
		uint8_t nLength = p[i], nType = p[i + 1];
		if (nLength < 2 || nLength > n - i)
		{
			return -1;
		}
		if (nType == DESC_INTERFACE)
		{
			if (nLength < 9)
			{
				return -1;
			}
			const uint8_t *q = p + i;
			if (q[3] == 0)				/* bAlternateSetting */
			{
				for (unsigned k = 0; k < pConfig->interface_count; k++)
				{
					if (pConfig->interfaces[k].number == q[2])
					{
						return -1;
					}
				}
				if (pConfig->interface_count == GK_USB_MAX_INTERFACES)
				{
					return -1;
				}
				gk_usb_interface_t *pIf = &pConfig->interfaces[pConfig->interface_count++];
				pIf->number = q[2];
				pIf->num_endpoints = q[4];
				pIf->cls = q[5];
				pIf->subclass = q[6];
				pIf->protocol = q[7];
			}
		}
		else if (nType == DESC_CONFIGURATION || nType == DESC_DEVICE)
		{
			return -1;			/* only one, and first */
		}
		i += nLength;
	}
	return 0;
}

int gk_usb_parse_langid (const uint8_t *p, size_t n, uint16_t *pLangID)
{
	*pLangID = 0;
	if (p == 0 || n < 4 || p[0] < 4 || p[0] > n || p[1] != DESC_STRING)
	{
		return -1;
	}
	*pLangID = Get16 (p + 2);
	return 0;
}

/* c as UTF-8 at pOut[*pLen], if it fits before the NUL */
static int Put (char *pOut, size_t nOutSize, size_t *pLen, unsigned c)
{
	char Buf[4];
	size_t k;
	if (c < 0x80)
	{
		Buf[0] = (char) c; k = 1;
	}
	else if (c < 0x800)
	{
		Buf[0] = (char) (0xC0 | c >> 6); Buf[1] = (char) (0x80 | (c & 0x3F)); k = 2;
	}
	else if (c < 0x10000)
	{
		Buf[0] = (char) (0xE0 | c >> 12); Buf[1] = (char) (0x80 | (c >> 6 & 0x3F));
		Buf[2] = (char) (0x80 | (c & 0x3F)); k = 3;
	}
	else
	{
		Buf[0] = (char) (0xF0 | c >> 18); Buf[1] = (char) (0x80 | (c >> 12 & 0x3F));
		Buf[2] = (char) (0x80 | (c >> 6 & 0x3F)); Buf[3] = (char) (0x80 | (c & 0x3F)); k = 4;
	}
	if (*pLen + k >= nOutSize)
	{
		return 0;
	}
	memcpy (pOut + *pLen, Buf, k);
	*pLen += k;
	return 1;
}

int gk_usb_parse_string (const uint8_t *p, size_t n, char *pOut, size_t nOutSize)
{
	if (nOutSize < 4)
	{
		return -1;
	}
	pOut[0] = '\0';
	if (p == 0 || n < 2 || p[0] < 2 || p[0] > n || p[1] != DESC_STRING)
	{
		return -1;
	}
	size_t nUnits = (p[0] - 2) / 2;		/* an odd last byte is dropped */
	const uint8_t *q = p + 2;
	size_t nLen = 0;
	for (size_t i = 0; i < nUnits; i++)
	{
		unsigned c = Get16 (q + 2 * i);
		if (c >= 0xD800 && c <= 0xDBFF && i + 1 < nUnits)
		{
			unsigned d = Get16 (q + 2 * (i + 1));
			if (d >= 0xDC00 && d <= 0xDFFF)
			{
				c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00);
				i++;
			}
		}
		if (c == 0 || gk_is_forbidden_char ((int) c, 0))	/* lone surrogates too */
		{
			c = '?';
		}
		if (!Put (pOut, nOutSize, &nLen, c))
		{
			break;
		}
	}
	pOut[nLen] = '\0';
	return (int) nLen;
}
