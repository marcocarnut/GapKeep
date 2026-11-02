#
# Builds Bellard's QuickJS (third_party/quickjs, pinned release) as a static
# library for Circle. Only the engine: no quickjs-libc (that is the OS/stdio
# layer for qjs on Unix, which we deliberately do not have).
#

CIRCLEHOME = ../../circle
QJSDIR     = ../../third_party/quickjs

vpath %.c $(QJSDIR)

OBJS	= quickjs.o dtoa.o libregexp.o libunicode.o cutils.o

EXTRAINCLUDE = -I compat -I $(QJSDIR)
# CONFIG_VERSION is required by quickjs.c; no Intl, no Temporal, no atomics
# (single core, no threads).
DEFINE += -DCONFIG_VERSION=\"$(shell cat $(QJSDIR)/VERSION)\" -D_GNU_SOURCE
# newlib exposes struct tm's GMT offset only under this name
DEFINE += -D__TM_GMTOFF=tm_gmtoff
DEFINE += -include compat/qjs_prelude.h
WARNINGS = -Wall -Wno-sign-compare -Wno-unused-parameter -Wno-array-bounds -Wno-format-truncation -Wno-format

libquickjs.a: $(OBJS)
	@echo "  AR    $@"
	@rm -f $@
	@$(AR) cr $@ $(OBJS)

include $(CIRCLEHOME)/Rules.mk

# QuickJS is a hosted C program: build it as such (newlib headers, full
# <inttypes.h>). The hosted pieces it needs come from newlib's libc/libm and
# from src/runtime/libc_shim.c.
CFLAGS := $(filter-out -ffreestanding,$(CFLAGS))

# On arm-none-eabi, uint32_t/int32_t are (unsigned) long, not int. QuickJS
# passes such variables through int pointers (e.g. string_getc(p, (int *)&idx)
# in the string iterator), which under strict aliasing GCC may - and at -O2
# does - miscompile: "for (const ch of str)" never ended. Type punning between
# int and long is fine with strict aliasing off.
CFLAGS += -fno-strict-aliasing

-include $(DEPS)
