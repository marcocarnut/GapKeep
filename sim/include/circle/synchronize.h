// The simulator is single-threaded: no barriers needed.
#ifndef _circle_synchronize_h
#define _circle_synchronize_h
#define DataMemBarrier()	do {} while (0)
#endif
