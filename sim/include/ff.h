// The part of FatFs's API the app loader (src/runtime/appstore.cpp) uses,
// on a host folder instead of the SD card: "SD:/apps/x" is <root>/apps/x,
// where <root> is set with GkSimSetCardRoot(). Read-only, like GapKeep's
// FatFs. Symbolic links and anything but plain files and folders are not
// visible (a FAT card has none).
//
// SPDX-License-Identifier: GPL-3.0-or-later
#ifndef GK_SIM_FF_H
#define GK_SIM_FF_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef unsigned int UINT;
typedef unsigned char BYTE;
typedef uint64_t FSIZE_t;

typedef enum { FR_OK = 0, FR_DISK_ERR, FR_NO_FILE, FR_NO_PATH, FR_NOT_ENABLED } FRESULT;

#define AM_DIR	0x10
#define FA_READ	0x01

typedef struct { int nMounted; } FATFS;
typedef struct { void *pHandle; } DIR;
typedef struct { void *pFile; } FIL;
typedef struct
{
	FSIZE_t fsize;
	BYTE fattrib;
	char fname[256];
} FILINFO;

FRESULT f_mount (FATFS *fs, const char *path, BYTE opt);
FRESULT f_opendir (DIR *dp, const char *path);
FRESULT f_readdir (DIR *dp, FILINFO *fno);
FRESULT f_closedir (DIR *dp);
FRESULT f_open (FIL *fp, const char *path, BYTE mode);
FRESULT f_read (FIL *fp, void *buff, UINT btr, UINT *br);
FRESULT f_close (FIL *fp);

// simulator: the folder that plays the SD card (0: no card)
void GkSimSetCardRoot (const char *pRoot);
// "SIM:/x" is <root>/x: replacements for built-in apps (appstore.cpp, simulator only)
void GkSimSetBuiltinRoot (const char *pRoot);

#ifdef __cplusplus
}
#endif

#endif
