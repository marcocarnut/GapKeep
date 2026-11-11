#
# Monocypher (third_party/monocypher): what is built and how. Shared by
# lib/monocypher/Makefile (the kernel), sim/Makefile and tests/native (the
# host).
#
# Monocypher 4.0.3, CC0-1.0 OR BSD-2-Clause (third_party/monocypher/
# LICENCE.md), copied unchanged from
#   https://github.com/LoupVaillant/Monocypher/releases/download/4.0.3/monocypher-4.0.3.tar.gz
#   SHA-256 8cc9bc341a66249016db9bd70e9142d8d0aef9945973744b1ac05dbc55d8ee66
#   (as GitHub's release lists it)
# Only src/: the library and its optional Ed25519 (RFC 8032, with SHA-512;
# the library's own EdDSA uses BLAKE2b and is not what OpenPGP calls
# Ed25519). GapKeep uses Ed25519 (src/crypto/ed25519.c); X25519 and
# Argon2id, also in monocypher.c, are for later.
#
# SPDX-License-Identifier: GPL-3.0-or-later
#
MONO_DIR     = $(ROOT)/third_party/monocypher
MONO_SOURCES = src/monocypher.c src/optional/monocypher-ed25519.c
MONO_INCLUDE = -I $(MONO_DIR)/src -I $(MONO_DIR)/src/optional
