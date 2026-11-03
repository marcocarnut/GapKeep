#
# The zerogap simulator: src/runtime, the keyboard device, LVGL and QuickJS
# compiled for a host instead of the Pi, with sim/ standing in for Circle.
#
#   make                 build/zgsim, native, for scripts, tests and agents
#   make web             build/web/zgsim.{js,wasm}, for the browser IDE
#                        (Emscripten: emcc on PATH, or EMSDK=~/emsdk)
#
# Built-in apps, as the kernel's build modes (../src/Makefile):
#   (default)            the launcher only; apps come from the "SD card"
#                        (zgsim --card DIR: DIR/apps)
#   TEST=1               every app in ../apps and ../tests/apps
#
# Objects go to build/<native|web>-<mode>/, so builds don't mix.
#

ROOT     := ..
LVGL     := $(ROOT)/circle/addon/lvgl/lvgl
QJS      := $(ROOT)/third_party/quickjs

ifeq ($(strip $(TEST)),1)
MODE     := test
BUNDLE   := $(ROOT)/apps $(ROOT)/tests/apps
MODEDEF  := -DZG_TEST
else
MODE     := production
BUNDLE   := --only launcher $(ROOT)/apps
MODEDEF  :=
endif

ifeq ($(MAKECMDGOALS),web)
TARGET   := web
EMBIN    := $(if $(EMSDK),$(EMSDK)/upstream/emscripten/,)
CC       := $(EMBIN)emcc
CXX      := $(EMBIN)em++
OPT      := -O2
else
TARGET   := native
CC       := gcc
CXX      := g++
OPT      := -O2 -g
endif

OBJDIR   := build/$(TARGET)-$(MODE)

# JavaScript work per second on a Pi Zero (see ZeroEstimate in
# src/runtime/apphost.cpp), measured on the hardware: dice39's self-test
# did 67 units in 2.0 s, QuickJS's test suite 155 in 3.9 s.
ZERO_WORK_PER_SECOND := 36

DEFS     := -DZG_SIM $(MODEDEF) -DZG_ZERO_WORK_PER_SECOND=$(ZERO_WORK_PER_SECOND) -DLV_CONF_PATH="<zg_lv_conf.h>" \
	    -DQJS_VERSION=\"$(shell cat $(QJS)/VERSION)\" \
	    -DCONFIG_VERSION=\"$(shell cat $(QJS)/VERSION)\" -D_GNU_SOURCE
INCS     := -I include -I src -I $(ROOT)/lib/lvgl -I $(QJS) -idirafter $(ROOT)/circle/addon
CFLAGS   := $(OPT) $(DEFS) $(INCS) -fno-strict-aliasing -Wall -Wno-unused-parameter \
	    -Wno-sign-compare -Wno-format-truncation -Wno-array-bounds -Wno-unknown-warning-option
CXXFLAGS := $(CFLAGS) -std=gnu++17 -fno-exceptions -fno-rtti

RUNTIME  := $(ROOT)/src/runtime/apphost.cpp $(ROOT)/src/runtime/appstore.cpp \
	    $(ROOT)/src/runtime/js_ui.cpp $(ROOT)/src/runtime/js_sys.cpp \
	    $(ROOT)/src/runtime/js_crypto.cpp $(ROOT)/src/runtime/zg_bridge.cpp \
	    $(ROOT)/src/runtime/lv_mem_wipe.c $(ROOT)/src/runtime/cursor.c \
	    $(ROOT)/src/runtime/cursor_install.c \
	    $(ROOT)/src/crypto/sha256.c $(ROOT)/src/crypto/hwrng.cpp \
	    $(ROOT)/src/kbdindev.cpp
SIM      := src/platform.cpp src/sim.cpp src/png.c src/ff_host.c src/hostdir.c
QJSSRC   := $(QJS)/quickjs.c $(QJS)/dtoa.c $(QJS)/libregexp.c $(QJS)/libunicode.c $(QJS)/cutils.c
LVGLSRC  := $(shell find $(LVGL)/src -name '*.c')

ifeq ($(TARGET),web)
FRONT    := src/web.cpp
else
FRONT    := src/main.cpp
endif

# every source to an object under OBJDIR, by its path
obj = $(addprefix $(OBJDIR)/,$(addsuffix .o,$(subst ../,up/,$(1))))
OBJS     := $(call obj,$(RUNTIME) $(SIM) $(FRONT) $(QJSSRC) $(LVGLSRC)) $(OBJDIR)/apps_bundle.c.o

.PHONY: all web clean FORCE
all: build/zgsim$(if $(filter test,$(MODE)),-test)

build/zgsim build/zgsim-test: $(OBJS)
	@echo "  LINK  $@"
	@$(CXX) $(OPT) -o $@ $(OBJS) -lm

web: build/web/zgsim$(if $(filter test,$(MODE)),-test).js

WEBFLAGS := -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=1GB -sSTACK_SIZE=2MB \
	    -sMODULARIZE=1 -sEXPORT_NAME=createZerogap -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node \
	    -sEXPORTED_RUNTIME_METHODS=FS,HEAPU8,HEAPU16,UTF8ToString,stringToNewUTF8 \
	    -sEXPORTED_FUNCTIONS=_malloc,_free,_zg_sim_boot,_zg_sim_key_down_qemu,_zg_sim_key_down_dom,_zg_sim_key_up,_zg_sim_pointer,_zg_sim_launch,_zg_sim_frame_serial,_zg_web_run,_zg_web_frame,_zg_web_width,_zg_web_height \
	    -sFORCE_FILESYSTEM=1 --no-entry -sEXIT_RUNTIME=0

build/web/zgsim.js build/web/zgsim-test.js: $(OBJS)
	@mkdir -p build/web
	@echo "  LINK  $@"
	@$(CXX) $(OPT) $(WEBFLAGS) -o $@ $(OBJS)

$(OBJDIR)/apps_bundle.c: FORCE
	@mkdir -p $(dir $@)
	@python3 $(ROOT)/tools/bundle_apps.py $@ $(BUNDLE)

$(OBJDIR)/apps_bundle.c.o: $(OBJDIR)/apps_bundle.c
	@$(CC) $(CFLAGS) -I $(ROOT)/src/generated -c -o $@ $<

$(OBJDIR)/up/%.c.o: ../%.c
	@mkdir -p $(dir $@)
	@echo "  CC    $<"
	@$(CC) $(CFLAGS) -std=gnu11 -MMD -c -o $@ $<

$(OBJDIR)/up/%.cpp.o: ../%.cpp
	@mkdir -p $(dir $@)
	@echo "  CXX   $<"
	@$(CXX) $(CXXFLAGS) -MMD -c -o $@ $<

$(OBJDIR)/%.c.o: %.c
	@mkdir -p $(dir $@)
	@echo "  CC    $<"
	@$(CC) $(CFLAGS) -std=gnu11 -MMD -c -o $@ $<

$(OBJDIR)/%.cpp.o: %.cpp
	@mkdir -p $(dir $@)
	@echo "  CXX   $<"
	@$(CXX) $(CXXFLAGS) -MMD -c -o $@ $<

FORCE:

clean:
	rm -rf build

-include $(shell find $(OBJDIR) -name '*.d' 2>/dev/null)
