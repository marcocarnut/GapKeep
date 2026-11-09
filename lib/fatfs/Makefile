#
# Builds FatFs (from Circle's addon) read-only, with GapKeep's ffconf.h.
#
# ff.h includes "ffconf.h" relative to itself, so the sources are copied
# next to our ffconf.h (into src/) rather than compiled in place.
#

CIRCLEHOME = ../../circle
ADDON      = $(CIRCLEHOME)/addon/fatfs
SRCS       = ff.c ff.h diskio.cpp diskio.h ffsystem.cpp ffunicode.c

OBJS	= src/ff.o src/diskio.o src/ffsystem.o src/ffunicode.o

libfatfs.a: $(OBJS)
	@echo "  AR    $@"
	@rm -f $@
	@$(AR) cr $@ $(OBJS)

$(OBJS): src/.copied
$(addprefix src/,$(SRCS) ffconf.h): src/.copied ;

src/.copied: $(addprefix $(ADDON)/,$(SRCS)) ffconf.h
	@mkdir -p src
	@cp $(addprefix $(ADDON)/,$(SRCS)) ffconf.h src/
	@touch $@

include $(CIRCLEHOME)/Rules.mk

EXTRACLEAN += src/* src/.copied

-include $(DEPS)
