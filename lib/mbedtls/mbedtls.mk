#
# Mbed TLS (third_party/mbedtls): what is built and how. Shared by
# lib/mbedtls/Makefile (the kernel), sim/Makefile and tests/native (the
# host).
#
# A crypto-only subset of Mbed TLS 3.6.7 (LTS), Apache-2.0 OR
# GPL-2.0-or-later (third_party/mbedtls/LICENSE), copied unchanged from
#   https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-3.6.7/mbedtls-3.6.7.tar.bz2
#   SHA-256 a7e8bcbec0e6f761b4af24f25677626b35f762f68eef79c08677a363212d11f6
#   (as the release's mbedtls-3.6.7-sha256sum.txt says)
# Only the files this configuration compiles, and the headers they include.
#
# What GapKeep uses (src/crypto/rsa.c, src/crypto/aes.c): the RSA private
# operation (CRT, with base and exponent blinding and its own check of the
# result against the public key), the public operation, key import and
# validation (mbedtls_rsa_complete derives the CRT values), and AES with
# CFB128. PKCS#1 v1.5 encoding is GapKeep's own (rsa.c): Mbed TLS's needs
# its OID and ASN.1 modules, built only because RSA_C requires them; MD
# and SHA-256 likewise (MD_C wants a hash). gk_mbedtls_config.h is the
# whole configuration.
#
# SPDX-License-Identifier: GPL-3.0-or-later
#
MBEDTLS_DIR     = $(ROOT)/third_party/mbedtls
MBEDTLS_SOURCES = aes.c asn1parse.c asn1write.c bignum.c bignum_core.c constant_time.c \
		  md.c oid.c platform_util.c rsa.c rsa_alt_helpers.c sha256.c
MBEDTLS_DEFINES = -DMBEDTLS_CONFIG_FILE='"gk_mbedtls_config.h"'
MBEDTLS_INCLUDE = -I $(ROOT)/lib/mbedtls -I $(MBEDTLS_DIR)/include
