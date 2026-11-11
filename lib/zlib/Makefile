#
# Builds zlib's inflate (third_party/zlib, pinned release) as a static
# library for Circle; see zlib.mk.
#
# SPDX-License-Identifier: GPL-3.0-or-later
#

CIRCLEHOME = ../../circle
ROOT       = ../..

include zlib.mk

vpath %.c $(ZLIB_DIR)

OBJS	= $(ZLIB_SOURCES:.c=.o)

EXTRAINCLUDE = $(ZLIB_INCLUDE)
DEFINE += $(ZLIB_DEFINES)
WARNINGS = -Wall

libz.a: $(OBJS)
	@echo "  AR    $@"
	@rm -f $@
	@$(AR) cr $@ $(OBJS)

include $(CIRCLEHOME)/Rules.mk

# hosted C (newlib's <string.h>, <stdlib.h>), as lib/secp256k1; each
# function in its own section
CFLAGS := $(filter-out -ffreestanding,$(CFLAGS)) -std=gnu99 -ffunction-sections -fdata-sections

-include $(DEPS)
