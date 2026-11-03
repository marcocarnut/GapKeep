#ifndef ZG_SIM_HOSTDIR_H
#define ZG_SIM_HOSTDIR_H
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
void *HostOpenDir (const char *pPath);
int HostReadDir (void *pHandle, char *pName, size_t nSize, int *pIsDir, unsigned long long *pFileSize);
void HostCloseDir (void *pHandle);
int HostIsFile (const char *pPath);
int HostIsDir (const char *pPath);
#ifdef __cplusplus
}
#endif
#endif
