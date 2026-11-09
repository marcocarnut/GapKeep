#
# libsecp256k1 (third_party/secp256k1, Bitcoin Core's, MIT): what is built
# and how. Shared by lib/secp256k1/Makefile (the kernel), sim/Makefile and
# tests/native (the host).
#
# One translation unit (src/secp256k1.c includes the rest) and the two
# precomputed tables. Modules: extrakeys (x-only keys, keypairs: BIP-340
# and Taproot tweaks) and schnorrsig (BIP-340). ECDSA is in the core.
#
# ECMULT_WINDOW_SIZE 8: the table for verifying and tweaking public keys is
# 16 KiB instead of the default 1 MiB (window 15), for verification about
# 30 % slower; GapKeep verifies little. Signing uses the separate comb
# table (default size, 22 KiB). The default callbacks (illegal argument,
# internal error) are GapKeep's: src/crypto/secp.c, which halts.
#
SECP_DIR     = $(ROOT)/third_party/secp256k1
SECP_SOURCES = src/secp256k1.c src/precomputed_ecmult.c src/precomputed_ecmult_gen.c
SECP_DEFINES = -DENABLE_MODULE_EXTRAKEYS=1 -DENABLE_MODULE_SCHNORRSIG=1 \
	       -DECMULT_WINDOW_SIZE=8 -DUSE_EXTERNAL_DEFAULT_CALLBACKS=1
SECP_INCLUDE = -I $(SECP_DIR)/include
