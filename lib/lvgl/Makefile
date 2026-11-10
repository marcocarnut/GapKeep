#
# Builds LVGL (from Circle's addon submodule) plus Circle's CLVGL glue with
# GapKeep's own configuration (gk_lv_conf.h). Every file that includes LVGL
# headers must be compiled with the same LV_CONF_PATH: see ../../src/Makefile.
#
# SPDX-License-Identifier: GPL-3.0-or-later
#

CIRCLEHOME = ../../circle
ADDON      = $(CIRCLEHOME)/addon/lvgl
LVGL_PATH  = $(ADDON)/lvgl

CSRCS  := $(shell find $(LVGL_PATH)/src -type f -name '*.c')
OBJDIR  = obj
OBJS    = $(OBJDIR)/lvgl_glue.o $(patsubst $(LVGL_PATH)/%.c,$(OBJDIR)/%.o,$(CSRCS))

DEFINE += -DLV_CONF_PATH="<gk_lv_conf.h>"
EXTRAINCLUDE = -I $(CURDIR) -I $(LVGL_PATH)

liblvgl.a: $(OBJS)
	@echo "  AR    $@"
	@rm -f $@
	@$(AR) cr $@ $(OBJS)

include $(CIRCLEHOME)/Rules.mk

$(OBJDIR)/%.o: $(LVGL_PATH)/%.c
	@mkdir -p $(dir $@)
	@$(CC) $(CFLAGS) $(C_STANDARD) -c -o $@ $<

$(OBJDIR)/lvgl_glue.o: $(ADDON)/lvgl.cpp
	@mkdir -p $(dir $@)
	@echo "  CPP   $@"
	@$(CPP) $(CPPFLAGS) -c -o $@ $<

EXTRACLEAN += -r $(OBJDIR)

# every object depends on the configuration (which fonts are built in, ...)
$(OBJS): gk_lv_conf.h
