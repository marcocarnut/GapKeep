/*
 * gk_mbedtls_config.h - GapKeep's whole Mbed TLS configuration (mbedtls.mk):
 * bignum, RSA and AES (CFB), for src/crypto/rsa.c and src/crypto/aes.c.
 * Nothing else: no TLS, no X.509, no PSA, no entropy or DRBG (random bytes
 * come from GapKeep's health-checked generator), no file or network access.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_MBEDTLS_CONFIG_H
#define GK_MBEDTLS_CONFIG_H

/* the C library's calloc and free (Circle's heap zeroes freed blocks;
   Mbed TLS also wipes its numbers before freeing them) */
#define MBEDTLS_HAVE_ASM		/* bn_mul.h: UMAAL on the ARM1176 */
#define MBEDTLS_BIGNUM_C
#define MBEDTLS_RSA_C
#define MBEDTLS_PKCS1_V15
/* required by RSA_C (check_config.h), unused by GapKeep (mbedtls.mk) */
#define MBEDTLS_OID_C
#define MBEDTLS_ASN1_PARSE_C
#define MBEDTLS_ASN1_WRITE_C
#define MBEDTLS_MD_C
#define MBEDTLS_SHA256_C

#define MBEDTLS_AES_C
#define MBEDTLS_CIPHER_MODE_CFB
#define MBEDTLS_AES_ROM_TABLES		/* in .rodata, not built in RAM at first use */

/* mbedtls_platform_zeroize is gk_wipe (src/crypto/rsa.c), whose stores
   the compiler keeps (src/crypto/wipe.h) */
#define MBEDTLS_PLATFORM_ZEROIZE_ALT

#endif
