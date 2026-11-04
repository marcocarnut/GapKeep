#
# Builds Daniel Beer's quirc (third_party/quirc, pinned), the QR code
# decoder behind ui.QRScanner (src/runtime/qrdecode.cpp), as a static
# library for Circle. Only lib/: no demos, no tools.
#

CIRCLEHOME = ../../circle
QUIRCDIR   = ../../third_party/quirc/lib

vpath %.c $(QUIRCDIR)

OBJS	= decode.o identify.o quirc.o version_db.o

EXTRAINCLUDE = -I $(QUIRCDIR)
WARNINGS = -Wall -Wno-sign-compare -Wno-unused-parameter

libquirc.a: $(OBJS)
	@echo "  AR    $@"
	@rm -f $@
	@$(AR) cr $@ $(OBJS)

include $(CIRCLEHOME)/Rules.mk

# a hosted C library (malloc, math): newlib's headers, as for QuickJS
CFLAGS := $(filter-out -ffreestanding,$(CFLAGS))

-include $(DEPS)
