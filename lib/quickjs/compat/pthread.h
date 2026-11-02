/*
 * Minimal pthread.h for QuickJS on zerogap.
 *
 * quickjs.c always enables CONFIG_ATOMICS (except on Emscripten), which uses
 * a mutex to guard class-ID allocation and a mutex/condition pair for
 * Atomics.wait/notify. zerogap is single-core with a single JS thread, so the
 * mutexes are no-ops. Waiting is not allowed (JS_SetCanBlock is never enabled),
 * so the condition functions are never reached in practice; they fail safely.
 *
 * SPDX-License-Identifier: MIT
 */
#ifndef ZG_COMPAT_PTHREAD_H
#define ZG_COMPAT_PTHREAD_H

#include <time.h>
#include <sys/types.h>	/* newlib already declares the pthread_*_t types */

#undef PTHREAD_MUTEX_INITIALIZER
#define PTHREAD_MUTEX_INITIALIZER ((pthread_mutex_t) 0)

static inline int pthread_mutex_lock (pthread_mutex_t *m)   { (void) m; return 0; }
static inline int pthread_mutex_unlock (pthread_mutex_t *m) { (void) m; return 0; }

static inline int pthread_cond_init (pthread_cond_t *c, const pthread_condattr_t *a) { (void) c; (void) a; return 0; }
static inline int pthread_cond_destroy (pthread_cond_t *c) { (void) c; return 0; }
static inline int pthread_cond_signal (pthread_cond_t *c)  { (void) c; return 0; }
static inline int pthread_cond_wait (pthread_cond_t *c, pthread_mutex_t *m) { (void) c; (void) m; return 22; /* EINVAL */ }
static inline int pthread_cond_timedwait (pthread_cond_t *c, pthread_mutex_t *m, const struct timespec *t)
	{ (void) c; (void) m; (void) t; return 116; /* ETIMEDOUT */ }

#endif
