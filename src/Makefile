#
# Makefile for the zerogap kernel (Raspberry Pi Zero, bare metal on Circle)
#

CIRCLEHOME = ../circle

OBJS	= main.o kernel.o kbdindev.o ui_test.o

LIBS	= $(CIRCLEHOME)/addon/lvgl/liblvgl.a \
	  $(CIRCLEHOME)/lib/usb/libusb.a \
	  $(CIRCLEHOME)/lib/input/libinput.a \
	  $(CIRCLEHOME)/lib/fs/libfs.a \
	  $(CIRCLEHOME)/lib/libcircle.a

include $(CIRCLEHOME)/Rules.mk

-include $(DEPS)
