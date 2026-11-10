//
// cardfs.h
//
// FatFs, as GapKeep uses it: the SD card is read at boot only (the apps,
// gapkeep.txt and the data folders the apps list, appstore.cpp), then
// unmounted, so that it can be removed. Every FatFs call goes through
// GkCardGuard(): after boot it logs an error ("f_open after boot") and
// refuses, so a part of GapKeep that would read the card later shows up
// in the log (and in tests/card_removal.txt) instead of working only while
// the card happens to be there.
//
// Include this instead of <ff.h>. Not for sealed builds, which have no SD
// card code.
//
// SPDX-License-Identifier: GPL-3.0-or-later
//
#ifndef _cardfs_h
#define _cardfs_h

#include <circle/types.h>
#include <ff.h>				// lib/fatfs: read-only FatFs (the simulator: sim/include/ff.h)

// TRUE before the end of boot; after it, logs pFunction at LogError and
// returns FALSE (appstore.cpp)
boolean GkCardGuard (const char *pFunction);

#define f_mount(...)	(GkCardGuard ("f_mount") ? f_mount (__VA_ARGS__) : FR_NOT_ENABLED)
#define f_open(...)	(GkCardGuard ("f_open") ? f_open (__VA_ARGS__) : FR_NOT_ENABLED)
#define f_read(...)	(GkCardGuard ("f_read") ? f_read (__VA_ARGS__) : FR_NOT_ENABLED)
#define f_opendir(...)	(GkCardGuard ("f_opendir") ? f_opendir (__VA_ARGS__) : FR_NOT_ENABLED)
#define f_readdir(...)	(GkCardGuard ("f_readdir") ? f_readdir (__VA_ARGS__) : FR_NOT_ENABLED)
// closing what boot opened is fine
#endif
