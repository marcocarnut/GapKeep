#
# colorqr (lib/colorqr, MIT): reads the data in a QR code's colours, for
# the scanner's experimental "qr-color" detector (src/runtime/scanner.cpp).
# Shared by lib/colorqr/Makefile (the kernel), sim/Makefile and the host
# tests (tests/colorqr). C99, no heap, no libm, no global state.
#
# SPDX-License-Identifier: MIT
#
CQ_DIR     = $(ROOT)/lib/colorqr
CQ_SOURCES = src/cq_qr.c src/cq_ra.c src/cq_decode.c
CQ_INCLUDE = -I $(CQ_DIR)/include
# its stages timed (cq_stage(), src/runtime/scanner.cpp: the log shows them)
CQ_DEFINES = -DCQ_PROFILE
