#
# Makefile for the GapKeep kernel (Raspberry Pi Zero, bare metal on Circle)
#
# Prerequisites (built once, see README.md):
#   ../circle            Circle libraries (./makeall)
#   ../lib/lvgl          LVGL with GapKeep's configuration
#   ../lib/quickjs       QuickJS engine
#   ../lib/fatfs         FatFs, read-only (not for SEALED=1)
#   ../lib/secp256k1     libsecp256k1 (third_party/secp256k1)
#   ../lib/mbedtls       Mbed TLS's bignum, RSA and AES (third_party/mbedtls)
#   ../lib/monocypher    Monocypher, for Ed25519 (third_party/monocypher)
#   ../lib/zxing         the QR decoder, if third_party/zxing-cpp is there
#                        (without it, QR scanners report "no QR decoder")
#   ../circle/addon/SDCard  SD card driver (not for SEALED=1)
#
# Which apps are built into the image:
#   make            the launcher only; the other apps come from the SD
#                   card's /apps folder (tools/make_sdcard.sh --standalone)
#   make SEALED=1   every app in ../apps, and no SD card code at all;
#                   DATA=dir (an absolute path, tools/build.sh makes it
#                   one) also builds in every folder of dir as a data
#                   folder (gk:data), EXTRA_APPS=dir the apps in dir
#                   (tests/sealed_data.txt)
#   make TEST=1     every app in ../apps and ../tests/apps, plus test
#                   features (serial screenshots); /apps is read too
#
# The keyboard layout before gapkeep.txt is read (the only one for SEALED=1,
# which reads no card): make KEYBOARD=br-abnt2 (runtime/keylayout.h);
# default us.
#
# The serial port (GPIO 14/15): test builds log to it (and answer serial
# screenshot requests). Other builds don't touch it, and keep no log
# anywhere, unless made with LOG=serial (tools/build.sh does that for QEMU,
# where the tests read the log). No build but TEST=1 ever reads from it.
#
# SPDX-License-Identifier: GPL-3.0-or-later
#

CIRCLEHOME = ../circle
QJSDIR     = ../third_party/quickjs

OBJS	= main.o kernel.o kbdindev.o \
	  runtime/apphost.o runtime/appstore.o runtime/stackguard.o \
	  runtime/js_ui.o runtime/js_sys.o runtime/js_crypto.o \
	  crypto/sha1.o crypto/sha256.o crypto/sha512.o crypto/hmac.o crypto/hwrng.o \
	  crypto/ripemd160.o crypto/pbkdf2.o crypto/secp.o crypto/wipe.o \
	  crypto/s2k.o crypto/aes.o crypto/ed25519.o crypto/rsa.o \
	  runtime/gk_bridge.o runtime/libc_shim.o runtime/lv_mem_wipe.o runtime/cursor.o runtime/cursor_install.o \
	  runtime/scanner.o runtime/clock.o runtime/settings.o runtime/js_clock.o \
	  usbclaim.o runtime/usb.o runtime/usbdesc.o runtime/js_usb.o \
	  runtime/session.o runtime/js_session.o runtime/js_data.o runtime/i18n.o runtime/markup.o generated/i18n_js.o runtime/keylayout.o runtime/wheel.o \
	  camera/picamera.o camera/imx219.o camera/unicam.o \
	  generated/apps_bundle.o

# the fonts (tools/make_fonts.py)
OBJS	+= $(patsubst %,runtime/fonts/gk_montserrat_%.o,12 14 16 18 20 22 24 28 32 40)
OBJS	+= $(patsubst %,runtime/fonts/gk_mono_%.o,12 14 16 18 20 24 28)
OBJS	+= runtime/fonts/gk_ttf_bold.o runtime/fonts/gk_ttf_italic.o runtime/fonts/gk_ttf_bolditalic.o runtime/ttfstyles.o

ifeq ($(strip $(TEST)),1)
BUNDLE	= ../apps ../tests/apps
OBJS	+= testshot.o testcrash.o runtime/synthcam.o generated/testpictures.o
DEFINE	+= -DGK_TEST
BUILDMODE = test
else ifeq ($(strip $(SEALED)),1)
BUNDLE	= $(if $(strip $(DATA)),--data $(strip $(DATA))) ../apps $(EXTRA_APPS)
DEFINE	+= -DGK_SEALED
BUILDMODE = sealed
else
BUNDLE	= --only launcher ../apps
BUILDMODE = production
endif

ifneq ($(strip $(SEALED)),1)
ifneq ($(strip $(DATA)$(EXTRA_APPS)),)
$(error DATA and EXTRA_APPS are for sealed builds (SEALED=1); others read data folders from the card)
endif
endif

# The language a build starts in (before gapkeep.txt; the only one for
# sealed builds): make LANGUAGE=pt-BR. Only from the command line: the
# shell's LANGUAGE (gettext's, "en_US:en") is something else.
ifeq ($(origin LANGUAGE),command line)
ifneq ($(strip $(LANGUAGE)),)
DEFINE	+= -DGK_LANGUAGE=\"$(strip $(LANGUAGE))\"
BUILDMODE := $(BUILDMODE)-$(strip $(LANGUAGE))
endif
endif

KEYBOARD ?= us
ifneq ($(filter-out us br-abnt2,$(strip $(KEYBOARD)))$(word 2,$(KEYBOARD)),)
$(error KEYBOARD=$(KEYBOARD): us or br-abnt2 expected)
endif
ifneq ($(strip $(KEYBOARD)),us)
DEFINE	+= -DGK_KEYBOARD=\"$(strip $(KEYBOARD))\"
BUILDMODE := $(BUILDMODE)-keyboard-$(strip $(KEYBOARD))
endif

ifeq ($(strip $(TEST)),1)
DEFINE	+= -DGK_SERIAL_LOG
else ifeq ($(strip $(LOG)),serial)
DEFINE	+= -DGK_SERIAL_LOG
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

LIBS	+= ../lib/secp256k1/libsecp256k1.a ../lib/colorqr/libcolorqr.a \
	  ../lib/mbedtls/libmbedtls.a ../lib/monocypher/libmonocypher.a \
	  ../lib/lvgl/liblvgl.a \
	  ../lib/quickjs/libquickjs.a \
	  $(CIRCLEHOME)/lib/usb/libusb.a \
	  $(CIRCLEHOME)/lib/input/libinput.a \
	  $(CIRCLEHOME)/lib/fs/libfs.a \
	  $(CIRCLEHOME)/lib/libcircle.a

# every file including LVGL headers must see the same configuration
DEFINE += -DLV_CONF_PATH="<gk_lv_conf.h>"
DEFINE += -DQJS_VERSION=\"$(shell cat $(QJSDIR)/VERSION)\"
EXTRAINCLUDE = -I ../lib/lvgl -I $(QJSDIR) -I ../lib/fatfs/src -I ../third_party/secp256k1/include \
	       -I ../lib/colorqr/include -I ../lib/mbedtls -I ../third_party/mbedtls/include \
	       -I ../third_party/monocypher/src -I ../third_party/monocypher/src/optional
DEFINE += -DMBEDTLS_CONFIG_FILE='"gk_mbedtls_config.h"'

include $(CIRCLEHOME)/Rules.mk

# Apps are bundled into the image. The script only rewrites its output when
# something changed, so this runs every time but rebuilds only when needed.
generated/apps_bundle.c: FORCE
ifeq ($(strip $(TEST)),1)
	@python3 ../tools/make_qjstests.py $(QJSDIR) ../tests/apps/qjstests/suites.js
endif
	@python3 ../tools/bundle_apps.py $@ $(BUNDLE)

# gk:i18n's JavaScript (src/runtime/i18n.js)
generated/i18n_js.c: runtime/i18n.js ../tools/embed_js.py
	@python3 ../tools/embed_js.py $@ gk_i18n_js runtime/i18n.js

# the synthetic camera's test pictures (test builds)
generated/testpictures.c: FORCE
	@python3 ../tools/make_test_pictures.py $@ $(wildcard ../tests/colorqr/*.png)

FORCE:

# Recompile what depends on GK_TEST / GK_SEALED / GK_LANGUAGE / GK_KEYBOARD when switching builds.
.buildmode: FORCE
	@[ "$$(cat $@ 2>/dev/null)" = "$(BUILDMODE)" ] || echo "$(BUILDMODE)" > $@
main.o kernel.o runtime/appstore.o runtime/i18n.o runtime/settings.o runtime/js_sys.o runtime/keylayout.o: .buildmode

EXTRACLEAN += generated/*.o generated/*.d runtime/*.o runtime/*.d runtime/fonts/*.o runtime/fonts/*.d crypto/*.o crypto/*.d \
	      camera/*.o camera/*.d

-include $(DEPS)
