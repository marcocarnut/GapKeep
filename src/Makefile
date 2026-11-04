#
# Makefile for the zerogap kernel (Raspberry Pi Zero, bare metal on Circle)
#
# Prerequisites (built once, see README.md):
#   ../circle            Circle libraries (./makeall)
#   ../lib/lvgl          LVGL with zerogap's configuration
#   ../lib/quickjs       QuickJS engine
#   ../lib/fatfs         FatFs, read-only (not for SEALED=1)
#   ../lib/zxing         the QR decoder, if third_party/zxing-cpp is there
#                        (without it, QR scanners report "no QR decoder")
#   ../circle/addon/SDCard  SD card driver (not for SEALED=1)
#
# Which apps are built into the image:
#   make            the launcher only; the other apps come from the SD
#                   card's /apps folder (tools/make_sdcard.sh --standalone)
#   make SEALED=1   every app in ../apps, and no SD card code at all
#   make TEST=1     every app in ../apps and ../tests/apps, plus test
#                   features (serial screenshots); /apps is read too
#
# The serial port (GPIO 14/15): test builds log to it (and answer serial
# screenshot requests). Other builds don't touch it, and keep no log
# anywhere, unless made with LOG=serial (tools/build.sh does that for QEMU,
# where the tests read the log). No build but TEST=1 ever reads from it.
#

CIRCLEHOME = ../circle
QJSDIR     = ../third_party/quickjs

OBJS	= main.o kernel.o kbdindev.o \
	  runtime/apphost.o runtime/appstore.o runtime/stackguard.o \
	  runtime/js_ui.o runtime/js_sys.o runtime/js_crypto.o \
	  crypto/sha256.o crypto/hwrng.o \
	  runtime/zg_bridge.o runtime/libc_shim.o runtime/lv_mem_wipe.o runtime/cursor.o runtime/cursor_install.o \
	  runtime/scanner.o \
	  camera/picamera.o camera/imx219.o camera/unicam.o \
	  generated/apps_bundle.o

ifeq ($(strip $(TEST)),1)
BUNDLE	= ../apps ../tests/apps
OBJS	+= testshot.o testcrash.o runtime/synthcam.o
DEFINE	+= -DZG_TEST
BUILDMODE = test
else ifeq ($(strip $(SEALED)),1)
BUNDLE	= ../apps
DEFINE	+= -DZG_SEALED
BUILDMODE = sealed
else
BUNDLE	= --only launcher ../apps
BUILDMODE = production
endif

ifeq ($(strip $(TEST)),1)
DEFINE	+= -DZG_SERIAL_LOG
else ifeq ($(strip $(LOG)),serial)
DEFINE	+= -DZG_SERIAL_LOG
BUILDMODE := $(BUILDMODE)-log
endif

ifneq ($(strip $(SEALED)),1)
LIBS	+= ../lib/fatfs/libfatfs.a \
	   $(CIRCLEHOME)/addon/SDCard/libsdcard.a
endif

# The QR decoder: zxing-cpp, with src/runtime/qrdecode.cpp, built in
# ../lib/zxing (C++20, with the C++ library's headers). Without it,
# qrdecode.cpp is built here and has no decoder.
ifneq ($(wildcard ../third_party/zxing-cpp/core/src/ReadBarcode.cpp),)
LIBS	+= ../lib/zxing/libzxing.a
else
OBJS	+= runtime/qrdecode.o
endif

LIBS	+= ../lib/lvgl/liblvgl.a \
	  ../lib/quickjs/libquickjs.a \
	  $(CIRCLEHOME)/lib/usb/libusb.a \
	  $(CIRCLEHOME)/lib/input/libinput.a \
	  $(CIRCLEHOME)/lib/fs/libfs.a \
	  $(CIRCLEHOME)/lib/libcircle.a

# every file including LVGL headers must see the same configuration
DEFINE += -DLV_CONF_PATH="<zg_lv_conf.h>"
DEFINE += -DQJS_VERSION=\"$(shell cat $(QJSDIR)/VERSION)\"
EXTRAINCLUDE = -I ../lib/lvgl -I $(QJSDIR) -I ../lib/fatfs/src

include $(CIRCLEHOME)/Rules.mk

# Apps are bundled into the image. The script only rewrites its output when
# something changed, so this runs every time but rebuilds only when needed.
generated/apps_bundle.c: FORCE
ifeq ($(strip $(TEST)),1)
	@python3 ../tools/make_qjstests.py $(QJSDIR) ../tests/apps/qjstests/suites.js
endif
	@python3 ../tools/bundle_apps.py $@ $(BUNDLE)

FORCE:

# Recompile what depends on ZG_TEST / ZG_SEALED when switching builds.
.buildmode: FORCE
	@[ "$$(cat $@ 2>/dev/null)" = "$(BUILDMODE)" ] || echo "$(BUILDMODE)" > $@
main.o kernel.o runtime/appstore.o: .buildmode

EXTRACLEAN += generated/*.o generated/*.d runtime/*.o runtime/*.d crypto/*.o crypto/*.d \
	      camera/*.o camera/*.d

-include $(DEPS)
