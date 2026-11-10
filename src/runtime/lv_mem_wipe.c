/*
 * lv_mem_wipe.c - LVGL's memory allocator for GapKeep (LV_STDLIB_CUSTOM).
 *
 * LVGL keeps copies of everything it shows: a label holding a seed word
 * keeps that word in a heap buffer. Circle's free() does not clear memory,
 * so this allocator records each block's size and zeroes the block when it
 * is freed or moved by realloc. Secrets shown on screen do not linger in
 * freed memory.
 *
 * LVGL's memory is capped (lv_mem_limit.h): an app's widgets could
 * otherwise take all of it (the JS heap has its own limit, 96 MB). gk:ui
 * refuses to grow an app's screen past GK_LV_MEM_SOFT_LIMIT (js_ui.cpp,
 * a RangeError the app sees); the hard limit, above it, is for what LVGL
 * allocates on its own, and stops the system with a message rather than
 * hand LVGL a failed allocation (LV_ASSERT_MALLOC would halt silently).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include <lvgl/lvgl/lvgl.h>
#include <lvgl/lvgl/src/stdlib/lv_mem_private.h>
#include <stdlib.h>
#include <string.h>

void *malloc (size_t);
void free (void *);

#include "lv_mem_limit.h"
#include "gk_bridge.h"
#include "../crypto/wipe.h"

#define HEADER	8		/* keeps 8-byte alignment */

static size_t s_used;		/* bytes currently allocated, for lv_mem_monitor */
static size_t s_max_used;

void lv_mem_init (void)
{
}

void lv_mem_deinit (void)
{
}

lv_mem_pool_t lv_mem_add_pool (void *mem, size_t bytes)
{
	(void) mem;
	(void) bytes;
	return NULL;
}

void lv_mem_remove_pool (lv_mem_pool_t pool)
{
	(void) pool;
}

void *lv_malloc_core (size_t size)
{
	if (size > GK_LV_MEM_LIMIT || s_used + size > GK_LV_MEM_LIMIT)
		gk_fatal ("LVGL: the screen needs more than " GK_LV_MEM_LIMIT_TEXT " of memory");
	unsigned char *p = malloc (size + HEADER);
	if (p == NULL)
		return NULL;
	*(size_t *) p = size;
	s_used += size;
	if (s_used > s_max_used)
		s_max_used = s_used;
	return p + HEADER;
}

void lv_free_core (void *ptr)
{
	if (ptr == NULL)
		return;
	unsigned char *p = (unsigned char *) ptr - HEADER;
	size_t size = *(size_t *) p;
	s_used -= size;
	gk_wipe (p, size + HEADER);
	free (p);
}

void *lv_realloc_core (void *ptr, size_t new_size)
{
	if (ptr == NULL)
		return lv_malloc_core (new_size);
	if (new_size == 0)
	{
		lv_free_core (ptr);
		return NULL;
	}

	/* always move, so the old block can be wiped */
	size_t old_size = *(size_t *) ((unsigned char *) ptr - HEADER);
	void *p = lv_malloc_core (new_size);
	if (p == NULL)
		return NULL;
	memcpy (p, ptr, old_size < new_size ? old_size : new_size);
	lv_free_core (ptr);
	return p;
}

/* bytes LVGL holds now (sys.memory().ui) */
size_t gk_lv_mem_used (void)
{
	return s_used;
}

void lv_mem_monitor_core (lv_mem_monitor_t *mon_p)
{
	memset (mon_p, 0, sizeof *mon_p);
	mon_p->total_size = s_max_used;
	mon_p->free_size = 0;
	mon_p->max_used = s_max_used;
	mon_p->used_pct = 0;
}

lv_result_t lv_mem_test_core (void)
{
	return LV_RESULT_OK;
}
