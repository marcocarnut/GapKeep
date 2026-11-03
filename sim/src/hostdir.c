// Host folder listing for ff_host.c, kept apart because <dirent.h> and
// FatFs both define DIR.
// SPDX-License-Identifier: GPL-3.0-or-later
#include "hostdir.h"
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

struct THostDir
{
	DIR *pDir;
	char Path[1024];
};

void *HostOpenDir (const char *pPath)
{
	DIR *pDir = opendir (pPath);
	if (pDir == 0)
	{
		return 0;
	}
	struct THostDir *p = (struct THostDir *) malloc (sizeof *p);
	p->pDir = pDir;
	snprintf (p->Path, sizeof p->Path, "%s", pPath);
	return p;
}

// Next plain file or folder (no links, devices, "." or ".."); 0 at the end.
int HostReadDir (void *pHandle, char *pName, size_t nSize, int *pIsDir, unsigned long long *pFileSize)
{
	struct THostDir *p = (struct THostDir *) pHandle;
	struct dirent *e;
	while ((e = readdir (p->pDir)) != 0)
	{
		if (strcmp (e->d_name, ".") == 0 || strcmp (e->d_name, "..") == 0)
		{
			continue;
		}
		char Full[2048];
		struct stat st;
		snprintf (Full, sizeof Full, "%s/%s", p->Path, e->d_name);
		if (lstat (Full, &st) != 0 || !(S_ISDIR (st.st_mode) || S_ISREG (st.st_mode)))
		{
			continue;
		}
		snprintf (pName, nSize, "%s", e->d_name);
		*pIsDir = S_ISDIR (st.st_mode);
		*pFileSize = *pIsDir ? 0 : (unsigned long long) st.st_size;
		return 1;
	}
	return 0;
}

void HostCloseDir (void *pHandle)
{
	struct THostDir *p = (struct THostDir *) pHandle;
	closedir (p->pDir);
	free (p);
}

int HostIsFile (const char *pPath)
{
	struct stat st;
	return lstat (pPath, &st) == 0 && S_ISREG (st.st_mode);
}

int HostIsDir (const char *pPath)
{
	struct stat st;
	return stat (pPath, &st) == 0 && S_ISDIR (st.st_mode);
}
