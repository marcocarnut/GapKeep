#
# Builds libsecp256k1 (third_party/secp256k1, pinned release) as a static
# library for Circle; see secp256k1.mk.
#
# SPDX-License-Identifier: GPL-3.0-or-later
#

CIRCLEHOME = ../../circle
ROOT       = ../..

include secp256k1.mk

vpath %.c $(SECP_DIR)/src

OBJS	= secp256k1.o precomputed_ecmult.o precomputed_ecmult_gen.o

EXTRAINCLUDE = -I $(SECP_DIR) $(SECP_INCLUDE)
DEFINE += $(SECP_DEFINES)
WARNINGS = -Wall -Wno-unused-function

libsecp256k1.a: $(OBJS)
	@echo "  AR    $@"
	@rm -f $@
	@$(AR) cr $@ $(OBJS)

include $(CIRCLEHOME)/Rules.mk

# hosted C (newlib's <string.h>, <stdlib.h>), as lib/quickjs
CFLAGS := $(filter-out -ffreestanding,$(CFLAGS))

-include $(DEPS)
