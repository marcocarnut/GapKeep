#
# Builds the Mbed TLS subset (third_party/mbedtls, pinned release) as a
# static library for Circle; see mbedtls.mk.
#
# SPDX-License-Identifier: GPL-3.0-or-later
#

CIRCLEHOME = ../../circle
ROOT       = ../..

include mbedtls.mk

vpath %.c $(MBEDTLS_DIR)/library

OBJS	= $(MBEDTLS_SOURCES:.c=.o)

EXTRAINCLUDE = $(MBEDTLS_INCLUDE) -I $(MBEDTLS_DIR)/library
DEFINE += $(MBEDTLS_DEFINES)
WARNINGS = -Wall

libmbedtls.a: $(OBJS)
	@echo "  AR    $@"
	@rm -f $@
	@$(AR) cr $@ $(OBJS)

include $(CIRCLEHOME)/Rules.mk

# hosted C (newlib's <string.h>, <stdlib.h>), as lib/secp256k1; each
# function in its own section, so the link (--gc-sections) keeps only those
# GapKeep calls
CFLAGS := $(filter-out -ffreestanding,$(CFLAGS)) -std=gnu99 -ffunction-sections -fdata-sections

-include $(DEPS)
