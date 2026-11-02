#
# Makefile for the zerogap kernel (Raspberry Pi Zero, bare metal on Circle)
#
# Prerequisites (built once, see README.md):
#   ../circle            Circle libraries (./makeall)
#   ../lib/lvgl          LVGL with zerogap's configuration
#   ../lib/quickjs       QuickJS engine
#

CIRCLEHOME = ../circle
QJSDIR     = ../third_party/quickjs
APPSDIRS   = ../apps

# "make TEST=1" also bundles the test-only apps in ../tests/apps
ifeq ($(strip $(TEST)),1)
APPSDIRS  += ../tests/apps
endif

OBJS	= main.o kernel.o kbdindev.o \
	  runtime/apphost.o runtime/js_ui.o runtime/js_sys.o runtime/js_crypto.o \
	  crypto/sha256.o crypto/hwrng.o \
	  runtime/zg_bridge.o runtime/libc_shim.o runtime/lv_mem_wipe.o \
	  generated/apps_bundle.o

LIBS	= ../lib/lvgl/liblvgl.a \
	  ../lib/quickjs/libquickjs.a \
	  $(CIRCLEHOME)/lib/usb/libusb.a \
	  $(CIRCLEHOME)/lib/input/libinput.a \
	  $(CIRCLEHOME)/lib/fs/libfs.a \
	  $(CIRCLEHOME)/lib/libcircle.a

# every file including LVGL headers must see the same configuration
DEFINE += -DLV_CONF_PATH="<zg_lv_conf.h>"
DEFINE += -DQJS_VERSION=\"$(shell cat $(QJSDIR)/VERSION)\"
EXTRAINCLUDE = -I ../lib/lvgl -I $(QJSDIR)

include $(CIRCLEHOME)/Rules.mk

# Apps are bundled into the image. The script only rewrites its output when
# something changed, so this runs every time but rebuilds only when needed.
generated/apps_bundle.c: FORCE
ifeq ($(strip $(TEST)),1)
	@python3 ../tools/make_qjstests.py $(QJSDIR) ../tests/apps/qjstests/suites.js
endif
	@python3 ../tools/bundle_apps.py $@ $(APPSDIRS)

FORCE:

EXTRACLEAN += generated/*.o generated/*.d runtime/*.o runtime/*.d crypto/*.o crypto/*.d

-include $(DEPS)
