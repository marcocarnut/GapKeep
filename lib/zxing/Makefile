#
# Builds zxing-cpp's QR code reader (third_party/zxing-cpp, pinned, with
# patches/zxing-cpp/ applied) as a static library for Circle, with
# src/runtime/qrdecode.cpp, which calls it: the decoder behind ui.Scanner's
# "qr" (docs/CAMERA.md). Readers only, QR codes only (Version.h); the
# sources are listed in zxing.mk.
#
# zxing-cpp is C++20 and uses the C++ standard library, which the rest of
# the kernel does not (Circle builds C++ freestanding, -nostdinc++). Here
# only, for these files:
#
#  - C++20 and the toolchain's libstdc++ headers, as a hosted program
#    (newlib's C headers, as for QuickJS);
#  - still no exceptions and no RTTI: what zxing-cpp would throw calls
#    ZXing::Fatal() (qrdecode.cpp), which stops the kernel with a message;
#  - the few compiled pieces of the C++ library that this needs come from
#    cxxrt.cpp and from libstdc++'s tree.o and list.o (std::map's and
#    std::list's node functions, 3 KiB), taken out of the toolchain's
#    libstdc++.a, neither depends on anything else. Not
#    libstdc++.a itself:
#    it would bring the exception runtime (unwinder, personality,
#    typeinfo) and the I/O streams. Circle's sources are not touched.
#
# The ARM1176 flags (-mcpu=arm1176jzf-s -marm -mfpu=vfp, hard float),
# optimisation and stack protector are Circle's (Rules.mk, Config.mk), as
# for the rest of the kernel.
#
# The library holds one object, zxing.o: everything linked together, then
# only what GkDecodeQR and GkDecodeQRWipe reach kept (ld -r
# --gc-sections, from the functions' and data's own sections). zxing-cpp's other code (text
# conversion, structured append merging, JSON, ...) mostly is not, which
# saves about 80 KiB. The kernel itself is linked as before.
#
# SPDX-License-Identifier: GPL-3.0-or-later
#

CIRCLEHOME = ../../circle
ZXDIR      = ../../third_party/zxing-cpp/core/src
RUNTIME    = ../../src/runtime

include zxing.mk

vpath %.cpp $(ZXDIR) $(ZXDIR)/qrcode $(RUNTIME)

OBJS	= $(notdir $(ZXING_SOURCES:.cpp=.o)) qrdecode.o cxxrt.o

EXTRAINCLUDE = -I . -I $(ZXDIR) -I $(RUNTIME)
DEFINE  += $(ZXING_DEFINES) -DGK_HAVE_ZXING
STANDARD = -std=c++20
WARNINGS = -Wall -Wno-sign-compare -Wno-unused-parameter

libzxing.a: $(OBJS) tree.o list.o
	@echo "  LD    zxing.o"
	@$(LD) -r --gc-sections -o zxing.o \
		$$($(PREFIX)nm qrdecode.o | sed -n 's/^.* T \(.*GkDecodeQR.*\)$$/-u \1/p') \
		$(OBJS) tree.o list.o
	@echo "  AR    $@"
	@rm -f $@
	@$(AR) cr $@ zxing.o

include $(CIRCLEHOME)/Rules.mk

# hosted, with the C++ library's headers (see above)
CFLAGS   := $(filter-out -ffreestanding,$(CFLAGS))
CPPFLAGS := $(filter-out -nostdinc++,$(CPPFLAGS)) -ffunction-sections -fdata-sections

# libstdc++'s tree and list node functions, from the toolchain (as pinned
# by tools/toolchain.sh), for the ARM1176 hard-float multilib
LIBSTDCXX = $(shell $(CPP) $(ARCHCPU) -print-file-name=libstdc++.a)

tree.o list.o: $(LIBSTDCXX)
	@echo "  AR x  $@"
	@$(AR) x $(LIBSTDCXX) $@
	@touch $@

-include $(DEPS)
