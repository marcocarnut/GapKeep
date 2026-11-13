#
# Builds Monocypher (third_party/monocypher, pinned release) as a static
# library for Circle; see monocypher.mk.
#
# SPDX-License-Identifier: GPL-3.0-or-later
#

CIRCLEHOME = ../../circle
ROOT       = ../..

include monocypher.mk

vpath %.c $(MONO_DIR)/src $(MONO_DIR)/src/optional

OBJS	= monocypher.o monocypher-ed25519.o

EXTRAINCLUDE = $(MONO_INCLUDE)
WARNINGS = -Wall

libmonocypher.a: $(OBJS)
	@echo "  AR    $@"
	@rm -f $@
	@$(AR) cr $@ $(OBJS)

include $(CIRCLEHOME)/Rules.mk

# hosted C99, as lib/secp256k1; each function in its own section, so the
# link (--gc-sections) keeps only those GapKeep calls
CFLAGS := $(filter-out -ffreestanding,$(CFLAGS)) -std=gnu99 -ffunction-sections -fdata-sections

-include $(DEPS)
