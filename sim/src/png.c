/*
 * png.c - screenshots: the RGB565 frame (and the e-paper panel, epaper_sim.cpp)
 * as an RGB PNG. Uncompressed
 * ("stored" deflate blocks), so no zlib is needed; a 640x480 shot is 900 KB.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include "sim.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint32_t s_CRCTable[256];

static uint32_t CRC (uint32_t crc, const uint8_t *p, size_t n)
{
	if (s_CRCTable[1] == 0)
	{
		for (uint32_t i = 0; i < 256; i++)
		{
			uint32_t c = i;
			for (int k = 0; k < 8; k++)
			{
				c = (c & 1) ? 0xEDB88320u ^ (c >> 1) : c >> 1;
			}
			s_CRCTable[i] = c;
		}
	}
	crc = ~crc;
	while (n--)
	{
		crc = s_CRCTable[(crc ^ *p++) & 0xFF] ^ (crc >> 8);
	}
	return ~crc;
}

static void Put32 (uint8_t *p, uint32_t v)
{
	p[0] = v >> 24; p[1] = v >> 16; p[2] = v >> 8; p[3] = v;
}

static int Chunk (FILE *f, const char *type, const uint8_t *data, size_t n)
{
	uint8_t head[8];
	Put32 (head, (uint32_t) n);
	memcpy (head + 4, type, 4);
	uint32_t crc = CRC (CRC (0, (const uint8_t *) type, 4), data, n);
	uint8_t tail[4];
	Put32 (tail, crc);
	return    fwrite (head, 1, 8, f) == 8
	       && (n == 0 || fwrite (data, 1, n, f) == n)
	       && fwrite (tail, 1, 4, f) == 4;
}

int gk_sim_screenshot (const char *path)
{
	int w, h;
	const uint16_t *frame = gk_sim_frame (&w, &h);
	if (frame == 0)
	{
		return -1;
	}
	uint8_t *rgb = malloc ((size_t) w * h * 3), *p = rgb;
	for (int i = 0; i < w * h; i++)
	{
		uint16_t c = frame[i];
		uint8_t r = (c >> 11) & 0x1F, g = (c >> 5) & 0x3F, b = c & 0x1F;
		*p++ = (r << 3) | (r >> 2);
		*p++ = (g << 2) | (g >> 4);
		*p++ = (b << 3) | (b >> 2);
	}
	int result = gk_sim_write_png (path, rgb, w, h);
	free (rgb);
	return result;
}

int gk_sim_write_png (const char *path, const uint8_t *rgb, int w, int h)
{
	/* raw scanlines: filter byte 0, then RGB */
	size_t row = 1 + (size_t) w * 3;
	size_t raw_size = row * h;
	uint8_t *raw = malloc (raw_size);
	for (int y = 0; y < h; y++)
	{
		raw[y * row] = 0;
		memcpy (raw + y * row + 1, rgb + (size_t) y * w * 3, (size_t) w * 3);
	}

	/* zlib stream of stored blocks (at most 65535 bytes each) */
	size_t blocks = (raw_size + 65534) / 65535;
	size_t z_size = 2 + raw_size + blocks * 5 + 4;
	uint8_t *z = malloc (z_size), *q = z;
	*q++ = 0x78; *q++ = 0x01;
	uint32_t a = 1, b = 0;
	for (size_t off = 0; off < raw_size; )
	{
		size_t n = raw_size - off > 65535 ? 65535 : raw_size - off;
		*q++ = off + n == raw_size;		/* BFINAL, BTYPE 00 */
		*q++ = n; *q++ = n >> 8; *q++ = ~n; *q++ = ~n >> 8;
		memcpy (q, raw + off, n);
		for (size_t i = 0; i < n; i++)
		{
			a = (a + raw[off + i]) % 65521;
			b = (b + a) % 65521;
		}
		q += n;
		off += n;
	}
	Put32 (q, (b << 16) | a);
	q += 4;

	uint8_t ihdr[13];
	Put32 (ihdr, w);
	Put32 (ihdr + 4, h);
	ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;	/* 8-bit RGB */

	FILE *f = fopen (path, "wb");
	int ok = f != 0
		&& fwrite ("\x89PNG\r\n\x1a\n", 1, 8, f) == 8
		&& Chunk (f, "IHDR", ihdr, sizeof ihdr)
		&& Chunk (f, "IDAT", z, q - z)
		&& Chunk (f, "IEND", 0, 0);
	if (f != 0 && fclose (f) != 0)
	{
		ok = 0;
	}
	free (raw);
	free (z);
	return ok ? 0 : -1;
}
