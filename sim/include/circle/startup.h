// halt(): used by LVGL's assert handler (gk_lv_conf.h) and gk_fatal().
#ifndef _circle_startup_h
#define _circle_startup_h
#ifdef __cplusplus
extern "C"
#endif
void halt (void) __attribute__ ((noreturn));
#endif
