// FatFs's read API on a host folder: see sim/include/ff.h.
// SPDX-License-Identifier: GPL-3.0-or-later
#include <ff.h>
#include "hostdir.h"
#include <stdio.h>
#include <string.h>

static char s_Root[1024];		// "SD:"
static char s_BuiltinRoot[1024];	// "SIM:", the built-in app replacements (appstore.cpp)

void GkSimSetCardRoot (const char *pRoot)
{
	snprintf (s_Root, sizeof s_Root, "%s", pRoot ? pRoot : "");
}

void GkSimSetBuiltinRoot (const char *pRoot)
{
	snprintf (s_BuiltinRoot, sizeof s_BuiltinRoot, "%s", pRoot ? pRoot : "");
}

static int HostPath (const char *path, char *out, size_t size)
{
	if (s_Root[0] != '\0' && strncmp (path, "SD:", 3) == 0)
	{
		return snprintf (out, size, "%s%s", s_Root, path + 3) < (int) size;
	}
	if (s_BuiltinRoot[0] != '\0' && strncmp (path, "SIM:", 4) == 0)
	{
		return snprintf (out, size, "%s%s", s_BuiltinRoot, path + 4) < (int) size;
	}
	return 0;
}

FRESULT f_mount (FATFS *fs, const char *path, BYTE opt)
{
	(void) opt;
	if (strcmp (path, "SD:") != 0 || s_Root[0] == '\0' || !HostIsDir (s_Root))
	{
		return FR_NOT_ENABLED;
	}
	fs->nMounted = 1;
	return FR_OK;
}

FRESULT f_opendir (DIR *dp, const char *path)
{
	char p[1300];
	dp->pHandle = HostPath (path, p, sizeof p) ? HostOpenDir (p) : 0;
	return dp->pHandle ? FR_OK : FR_NO_PATH;
}

FRESULT f_readdir (DIR *dp, FILINFO *fno)
{
	int bIsDir;
	unsigned long long nSize;
	if (!HostReadDir (dp->pHandle, fno->fname, sizeof fno->fname, &bIsDir, &nSize))
	{
		fno->fname[0] = '\0';
		return FR_OK;
	}
	fno->fattrib = bIsDir ? AM_DIR : 0;
	fno->fsize = nSize;
	return FR_OK;
}

FRESULT f_closedir (DIR *dp)
{
	HostCloseDir (dp->pHandle);
	dp->pHandle = 0;
	return FR_OK;
}

FRESULT f_open (FIL *fp, const char *path, BYTE mode)
{
	char p[1300];
	if (mode != FA_READ || !HostPath (path, p, sizeof p) || !HostIsFile (p))
	{
		return FR_NO_FILE;
	}
	fp->pFile = fopen (p, "rb");
	return fp->pFile ? FR_OK : FR_NO_FILE;
}

FRESULT f_read (FIL *fp, void *buff, UINT btr, UINT *br)
{
	size_t n = fread (buff, 1, btr, (FILE *) fp->pFile);
	*br = (UINT) n;
	return n == btr || feof ((FILE *) fp->pFile) ? FR_OK : FR_DISK_ERR;
}

FRESULT f_close (FIL *fp)
{
	fclose ((FILE *) fp->pFile);
	fp->pFile = 0;
	return FR_OK;
}
