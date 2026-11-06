/* SPDX-License-Identifier: MIT */
/*
 * colorqr: reads the data held in a QR code's colours. See FORMAT.md.
 *
 * C99, single precision and a little double. No libm, no heap, no global state: all memory comes
 * from the caller's work buffer, so calls are reentrant. Input is treated as untrusted.
 */
#ifndef COLORQR_H
#define COLORQR_H

#include <stddef.h>
#include <stdint.h>

#define CQ_VERSION "1.0.0"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
	CQ_OK = 0,
	CQ_ERR_ARGS,         /* bad arguments */
	CQ_ERR_NOMEM,        /* work buffer too small: see cq_result.work_used */
	CQ_ERR_BASE,         /* the base QR code could not be rebuilt */
	CQ_ERR_NO_COLOUR,    /* a plain QR code: no colour layer */
	CQ_ERR_PAYLOAD,      /* a colour layer that could not be decoded */
	CQ_ERR_TOO_BIG       /* decoded, but larger than the caller's payload buffer */
} cq_status;

/* Input has no gamma curve, as with raw sensor data. White balance is handled either way. */
#define CQ_FLAG_LINEAR 1u
/* Always run the full decode, even if the symbol looks plain. For testing. */
#define CQ_FLAG_NO_FAST_PATH 2u
/* Skip the local grid correction of large symbols. For testing. */
#define CQ_FLAG_NO_LOCAL_GRID 4u

typedef struct {
	uint8_t *payload;      /* in: caller's buffer. Out: the payload */
	size_t payload_cap;    /* in: its size */
	size_t payload_len;    /* out */
	int profile;           /* out: 0 a4.50, 1 a8.50 */
	int rate_num, rate_den;/* out: code rate */
	size_t work_used;      /* out: peak bytes of the work buffer */
	unsigned iterations;   /* out: decoder iterations */
} cq_result;

/*
 * Decodes one located symbol.
 *
 * rgb:     interleaved R, G, B, 8 bits each, `stride` bytes per row
 * corners: {x, y} of the symbol's top left, top right, bottom right and bottom left, roughly,
 *          as any QR locator gives them
 * version: the QR version, 1..40
 * work:    scratch memory, 8-byte aligned, of cq_work_size() bytes
 */
cq_status cq_decode(const uint8_t *rgb, unsigned width, unsigned height, unsigned stride,
                    const float corners[4][2], unsigned version, unsigned flags,
                    void *work, size_t work_size, cq_result *result);

/* The base QR code as a decoder already corrected it, so the symbol need not be read again. */
typedef struct {
	const uint8_t *data;   /* corrected data codewords, block after block, without parity */
	size_t data_len;
	int ecl;               /* 0 L, 1 M, 2 Q, 3 H */
	int mask;              /* 0..7 */
} cq_base;

/*
 * cq_decode, with the base QR code supplied. It is checked against the frame and ignored if it
 * does not match, so a wrong or mirrored base costs nothing but the re-read cq_decode would do.
 */
cq_status cq_decode_base(const uint8_t *rgb, unsigned width, unsigned height, unsigned stride,
                         const float corners[4][2], unsigned version, const cq_base *base,
                         unsigned flags, void *work, size_t work_size, cq_result *result);

/* Work buffer that is always enough for frames up to this size and versions up to max_version.
 * Returns 0 for invalid arguments. Stack use is under 2 KB, with no recursion. */
size_t cq_work_size(unsigned width, unsigned height, unsigned max_version);

/* Format primitives, exposed so a port can be checked against the golden vectors. */
uint32_t cq_xorshift32(uint32_t x);
unsigned cq_crc4(unsigned v12);
int cq_parse_header(unsigned word, int *profile, int *rate_index);
/* Fills order with (row, col) pairs. Returns the module count, or a negative value on error. */
long cq_shuffled_modules(unsigned version, uint16_t *order, size_t max, void *work, size_t work_size);
/* Writes n stream bits, one per byte, from k information bits, one per byte. */
int cq_ra_encode(const uint8_t *info, uint32_t k, uint8_t *stream, uint32_t n, void *work, size_t work_size);

#ifdef __cplusplus
}
#endif
#endif
