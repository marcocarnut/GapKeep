/*
 * From EPDPages (sim/panels.c, revision 241443b), by Marco Carnut, copied into
 * GapKeep (sim/src/epd/) under GPL-3.0-or-later with its author's
 * permission: the simulator's e-paper panels, under the real driver
 * (sim/src/epaper_sim.cpp, docs/EPAPER.md). Changed: only the SSD1680 family's models (no UC8176), and
 * panel_find() by GapKeep's model names too.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/*
 * panels - the panel models the simulator knows (panel.h). A new one: a
 * panel_<controller>.c with its panel_model_t, and a line here
 * (docs/panels.md has the rest).
 */
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "panel.h"

extern const panel_model_t panel_ssd1680, panel_ssd1680_213, panel_ssd1683;

/* (GapKeep: the SSD1680 family's; EPDPages' list has the UC8176 too) */
const panel_model_t* const panels[] = { &panel_ssd1680, &panel_ssd1680_213, &panel_ssd1683 };
/* ...and their names in gapkeep.txt (src/runtime/epd.cpp) */
static const char* const gk_names[] = { "weact-2.9-bwr", "weact-2.13-bw", "weact-4.2-bw" };
const int npanels = sizeof panels / sizeof panels[0];

const panel_model_t* panel_find(const char* s)
{
	char* end;
	long  n = strtol(s, &end, 10);
	if (*s && !*end)
	  return n >= 0 && n < npanels ? panels[n] : NULL;
	for (int i = 0; i < npanels; i++)
	  if (!strcasecmp(s, gk_names[i]) || !strcasecmp(s, panels[i]->name) || !strcasecmp(s, panels[i]->module))
	    return panels[i];
	return NULL;
}

int panel_json(char* buf, int n)
{
	int o = snprintf(buf, n, "[");
	for (int i = 0; i < npanels; i++)
	{
		const panel_model_t* p = panels[i];
		char m[64];
		int  k = 0;
		for (const char* c = p->module; *c && k < (int)sizeof m - 2; c++)
		{
			if (*c == '"' || *c == '\\')
			  m[k++] = '\\';
			m[k++] = *c;
		}
		m[k] = 0;
		o += snprintf(buf + (o < n ? o : n), o < n ? n - o : 0,
		              "%s{\"id\":%d,\"name\":\"%s\",\"module\":\"%s\",\"fw\":%d,\"width\":%d,\"height\":%d,\"red\":%d,"
		              "\"busyLow\":%d,\"rgb\":[[%d,%d,%d],[%d,%d,%d],[%d,%d,%d]],"
		              "\"shows\":[[%d,%d,%d],[%d,%d,%d],[%d,%d,%d]],\"physics\":%d}",
		              i ? "," : "", i, p->name, m, p->fw_id, p->width, p->height, p->red, p->busy_low,
		              p->rgb[0][0], p->rgb[0][1], p->rgb[0][2], p->rgb[1][0], p->rgb[1][1], p->rgb[1][2],
		              p->rgb[2][0], p->rgb[2][1], p->rgb[2][2],
		              p->shows[0][0], p->shows[0][1], p->shows[0][2], p->shows[1][0], p->shows[1][1], p->shows[1][2],
		              p->shows[2][0], p->shows[2][1], p->shows[2][2], p->wave || p->wave3);
	}
	o += snprintf(buf + (o < n ? o : n), o < n ? n - o : 0, "]");
	return o;
}

void panel_logf(const panel_host_t* h, int err, const char* fmt, ...)
{
	char m[256];
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(m, sizeof m, fmt, ap);
	va_end(ap);
	if (h->log)
	  h->log(h->ctx, err, m);
}
