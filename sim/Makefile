#
# The zerogap simulator: src/runtime, the keyboard device, LVGL and QuickJS
# compiled for a host instead of the Pi, with sim/ standing in for Circle.
#
#   make                 build/gksim, native, for scripts, tests and agents
#   make web             build/web/gksim.{js,wasm}, for the browser IDE
#                        (Emscripten: emcc on PATH, or EMSDK=~/emsdk)
#
# Built-in apps, as the kernel's build modes (../src/Makefile):
#   (default)            the launcher only; apps come from the "SD card"
#                        (gksim --card DIR: DIR/apps)
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
MODEDEF  := -DGK_TEST
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

# The QR decoder: zxing-cpp's QR code reader (third_party/zxing-cpp and
# ../lib/zxing/zxing.mk). Without it, scanners report "this build has no
# QR decoder".
ZXING    := $(ROOT)/third_party/zxing-cpp/core/src
HAVEZX   := $(wildcard $(ZXING)/ReadBarcode.cpp)

# (with the QR decoder or without: objects apart, so adding it rebuilds)
OBJDIR   := build/$(TARGET)-$(MODE)$(if $(HAVEZX),-zxing)

# JavaScript work per second on a Pi Zero (see ZeroEstimate in
# src/runtime/apphost.cpp), measured on the hardware: dice39's self-test
# did 67 units in 2.0 s, QuickJS's test suite 155 in 3.9 s.
ZERO_WORK_PER_SECOND := 36

DEFS     := -DGK_SIM $(MODEDEF) -DGK_ZERO_WORK_PER_SECOND=$(ZERO_WORK_PER_SECOND) -DLV_CONF_PATH="<gk_lv_conf.h>" \
	    -DQJS_VERSION=\"$(shell cat $(QJS)/VERSION)\" \
	    -DCONFIG_VERSION=\"$(shell cat $(QJS)/VERSION)\" -D_GNU_SOURCE
INCS     := -I include -I src -I $(ROOT)/lib/lvgl -I $(QJS) -I $(ROOT)/lib/colorqr/include -idirafter $(ROOT)/circle/addon
# Circle's patches: the simulator compiles its keymaps (patches/circle/0005)
$(shell $(ROOT)/tools/apply_patches.sh circle >&2)
ifneq ($(HAVEZX),)
$(shell $(ROOT)/tools/apply_patches.sh zxing-cpp >&2)
include $(ROOT)/lib/zxing/zxing.mk
ZXSRC    := $(addprefix $(ZXING)/,$(ZXING_SOURCES))
DEFS     += -DGK_HAVE_ZXING
endif
CFLAGS   := $(OPT) $(DEFS) $(INCS) -fno-strict-aliasing -Wall -Wno-unused-parameter \
	    -Wno-sign-compare -Wno-format-truncation -Wno-array-bounds -Wno-unknown-warning-option
CXXFLAGS := $(CFLAGS) -std=gnu++17 -fno-exceptions -fno-rtti
# zxing-cpp, and qrdecode.cpp that calls it: C++20 (lib/zxing/zxing.mk)
ZXFLAGS  := $(CFLAGS) -std=c++20 -fno-exceptions -fno-rtti $(ZXING_DEFINES) -I $(ROOT)/lib/zxing -I $(ZXING) \
	    -Wno-missing-braces -Wno-unused-template

RUNTIME  := $(ROOT)/src/runtime/apphost.cpp $(ROOT)/src/runtime/appstore.cpp \
	    $(ROOT)/src/runtime/js_ui.cpp $(ROOT)/src/runtime/js_sys.cpp \
	    $(ROOT)/src/runtime/js_crypto.cpp $(ROOT)/src/runtime/gk_bridge.cpp \
	    $(ROOT)/src/runtime/lv_mem_wipe.c $(ROOT)/src/runtime/cursor.c \
	    $(ROOT)/src/runtime/cursor_install.c \
	    $(ROOT)/src/runtime/scanner.cpp $(ROOT)/src/runtime/qrdecode.cpp \
	    $(ROOT)/src/runtime/synthcam.cpp $(ROOT)/src/runtime/clock.cpp $(ROOT)/src/runtime/settings.cpp \
	    $(ROOT)/src/runtime/js_clock.cpp $(ROOT)/src/runtime/session.cpp \
	    $(ROOT)/src/runtime/js_session.cpp $(ROOT)/src/runtime/i18n.cpp $(ROOT)/src/runtime/markup.cpp $(ROOT)/src/runtime/ttfstyles.cpp $(ROOT)/src/runtime/wheel.cpp \
	    $(ROOT)/src/runtime/keylayout.cpp \
	    $(ROOT)/src/crypto/sha1.c $(ROOT)/src/crypto/sha256.c $(ROOT)/src/crypto/sha512.c \
	    $(ROOT)/src/crypto/hmac.c $(ROOT)/src/crypto/hwrng.cpp \
	    $(ROOT)/src/crypto/ripemd160.c $(ROOT)/src/crypto/pbkdf2.c $(ROOT)/src/crypto/secp.c \
	    $(ROOT)/src/kbdindev.cpp \
	    $(wildcard $(ROOT)/src/runtime/fonts/gk_*.c)
SIM      := src/platform.cpp src/sim.cpp src/png.c src/ff_host.c src/hostdir.c
# libsecp256k1, configured as for the kernel (lib/secp256k1/secp256k1.mk)
include $(ROOT)/lib/secp256k1/secp256k1.mk
SECPSRC  := $(addprefix $(SECP_DIR)/,$(SECP_SOURCES))
# colorqr, the experimental colour QR layer (lib/colorqr/colorqr.mk)
include $(ROOT)/lib/colorqr/colorqr.mk
CQSRC    := $(addprefix $(CQ_DIR)/,$(CQ_SOURCES))
QJSSRC   := $(QJS)/quickjs.c $(QJS)/dtoa.c $(QJS)/libregexp.c $(QJS)/libunicode.c $(QJS)/cutils.c
LVGLSRC  := $(shell find $(LVGL)/src -name '*.c')


ifeq ($(TARGET),web)
FRONT    := src/web.cpp
else
FRONT    := src/main.cpp
endif

# every source to an object under OBJDIR, by its path
obj = $(addprefix $(OBJDIR)/,$(addsuffix .o,$(subst ../,up/,$(1))))
OBJS     := $(call obj,$(RUNTIME) $(SIM) $(FRONT) $(QJSSRC) $(LVGLSRC) $(ZXSRC) $(SECPSRC) $(CQSRC)) $(OBJDIR)/apps_bundle.c.o $(OBJDIR)/i18n_js.c.o
ZXOBJS   := $(call obj,$(ZXSRC) $(ROOT)/src/runtime/qrdecode.cpp)
$(ZXOBJS): CXXFLAGS := $(ZXFLAGS)
SECPOBJS := $(call obj,$(SECPSRC) $(ROOT)/src/crypto/secp.c)
$(SECPOBJS): CFLAGS += $(SECP_DEFINES) $(SECP_INCLUDE) -I $(SECP_DIR) -Wno-unused-function
CQOBJS   := $(call obj,$(CQSRC))
$(CQOBJS): CFLAGS += -std=gnu99 -I $(CQ_DIR)/src $(CQ_DEFINES)

.PHONY: all web clean FORCE
all: build/gksim$(if $(filter test,$(MODE)),-test)

build/gksim build/gksim-test: $(OBJS)
	@echo "  LINK  $@"
	@$(CXX) $(OPT) -o $@ $(OBJS) -lm

web: build/web/gksim$(if $(filter test,$(MODE)),-test).js

WEBFLAGS := -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=1GB -sSTACK_SIZE=2MB \
	    -sMODULARIZE=1 -sEXPORT_NAME=createGapkeep -sEXPORT_ES6=1 -sENVIRONMENT=web,worker,node \
	    -sEXPORTED_RUNTIME_METHODS=FS,HEAPU8,HEAPU16,UTF8ToString,stringToNewUTF8 \
	    -sEXPORTED_FUNCTIONS=_malloc,_free,_gk_sim_boot,_gk_sim_set_builtin_dir,_gk_sim_key_down_qemu,_gk_sim_key_down_dom,_gk_sim_key_up,_gk_sim_pointer,_gk_sim_wheel,_gk_sim_launch,_gk_sim_frame_serial,_gk_sim_camera,_gk_sim_camera_qr,_gk_sim_camera_picture,_gk_sim_camera_push,_gk_sim_camera_picture_rgb,_gk_sim_camera_push_rgb,_gk_web_run,_gk_web_frame,_gk_web_width,_gk_web_height \
	    -sFORCE_FILESYSTEM=1 --no-entry -sEXIT_RUNTIME=0

build/web/gksim.js build/web/gksim-test.js: $(OBJS)
	@mkdir -p build/web
	@echo "  LINK  $@"
	@$(CXX) $(OPT) $(WEBFLAGS) -o $@ $(OBJS)

$(OBJDIR)/apps_bundle.c: FORCE
	@mkdir -p $(dir $@)
ifeq ($(strip $(TEST)),1)
	@python3 $(ROOT)/tools/make_qjstests.py $(QJS) $(ROOT)/tests/apps/qjstests/suites.js
endif
	@python3 $(ROOT)/tools/bundle_apps.py $@ $(BUNDLE)

# gk:i18n's JavaScript
$(OBJDIR)/i18n_js.c: $(ROOT)/src/runtime/i18n.js $(ROOT)/tools/embed_js.py
	@mkdir -p $(dir $@)
	@python3 $(ROOT)/tools/embed_js.py $@ gk_i18n_js $<

$(OBJDIR)/i18n_js.c.o: $(OBJDIR)/i18n_js.c
	@$(CC) $(CFLAGS) -c -o $@ $<

$(OBJDIR)/apps_bundle.c.o: $(OBJDIR)/apps_bundle.c
	@$(CC) $(CFLAGS) -I $(ROOT)/src/runtime -c -o $@ $<

# QuickJS asks the C library for the time: in the simulator too, that is
# zerogap's clock (src/runtime/clock.cpp), not the host's (platform.cpp).
$(call obj,$(QJS)/quickjs.c): CFLAGS += -Dgettimeofday=gk_gettimeofday -Dlocaltime_r=gk_localtime_r
$(call obj,$(QJS)/quickjs.c): Makefile		# flags above: rebuild when they change

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
