#
# Builds colorqr (see colorqr.mk) as a static library for Circle.
#
# SPDX-License-Identifier: MIT
#

CIRCLEHOME = ../../circle
ROOT       = ../..

include colorqr.mk

vpath %.c $(CQ_DIR)/src

OBJS	= cq_qr.o cq_ra.o cq_decode.o

EXTRAINCLUDE = $(CQ_INCLUDE) -I $(CQ_DIR)/src
DEFINE += $(CQ_DEFINES)
WARNINGS = -Wall

libcolorqr.a: $(OBJS)
	@echo "  AR    $@"
	@rm -f $@
	@$(AR) cr $@ $(OBJS)

include $(CIRCLEHOME)/Rules.mk

# C99 with <string.h> from newlib, as lib/secp256k1
CFLAGS := $(filter-out -ffreestanding,$(CFLAGS)) -std=gnu99

-include $(DEPS)
