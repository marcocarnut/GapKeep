#!/bin/bash
#
# Turns the rig's USB-C port into a USB keyboard + mouse (boot protocol)
# for the Pi Zero, through Linux configfs. Run as root. Afterwards
# /dev/hidg0 is the keyboard (8-byte reports) and /dev/hidg1 the mouse
# (3-byte reports: buttons, dx, dy); gkrig.py writes them.
#
#   gadget.sh up | down
#
# bash, not sh: the descriptors below need printf's \x escapes, which
# dash (Debian's sh) does not have.
#
set -e
G=/sys/kernel/config/usb_gadget/gapkeep

down() {
	[ -d $G ] || return 0
	echo "" > $G/UDC 2>/dev/null || true
	rm -f $G/configs/c.1/hid.kbd $G/configs/c.1/hid.mouse
	rmdir $G/configs/c.1/strings/0x409 $G/configs/c.1 2>/dev/null || true
	rmdir $G/functions/hid.kbd $G/functions/hid.mouse 2>/dev/null || true
	rmdir $G/strings/0x409 $G 2>/dev/null || true
}

up() {
	modprobe libcomposite
	mountpoint -q /sys/kernel/config || mount -t configfs none /sys/kernel/config
	down
	mkdir -p $G
	echo 0x1d6b > $G/idVendor	# Linux Foundation
	echo 0x0104 > $G/idProduct	# Multifunction Composite Gadget
	echo 0x0100 > $G/bcdDevice
	echo 0x0200 > $G/bcdUSB
	mkdir -p $G/strings/0x409
	echo "GapKeep" > $G/strings/0x409/manufacturer
	echo "GapKeep test rig HID" > $G/strings/0x409/product
	echo "0001" > $G/strings/0x409/serialnumber

	F=$G/functions/hid.kbd
	mkdir -p $F
	echo 1 > $F/protocol; echo 1 > $F/subclass; echo 8 > $F/report_length
	# standard boot keyboard report descriptor
	printf '\x05\x01\x09\x06\xa1\x01\x05\x07\x19\xe0\x29\xe7\x15\x00\x25\x01\x75\x01\x95\x08\x81\x02\x95\x01\x75\x08\x81\x03\x95\x05\x75\x01\x05\x08\x19\x01\x29\x05\x91\x02\x95\x01\x75\x03\x91\x03\x95\x06\x75\x08\x15\x00\x25\x65\x05\x07\x19\x00\x29\x65\x81\x00\xc0' > $F/report_desc

	F=$G/functions/hid.mouse
	mkdir -p $F
	echo 2 > $F/protocol; echo 1 > $F/subclass; echo 3 > $F/report_length
	# standard boot mouse report descriptor: 3 buttons, relative X/Y
	printf '\x05\x01\x09\x02\xa1\x01\x09\x01\xa1\x00\x05\x09\x19\x01\x29\x03\x15\x00\x25\x01\x95\x03\x75\x01\x81\x02\x95\x01\x75\x05\x81\x03\x05\x01\x09\x30\x09\x31\x15\x81\x25\x7f\x75\x08\x95\x02\x81\x06\xc0\xc0' > $F/report_desc

	mkdir -p $G/configs/c.1/strings/0x409
	echo "keyboard + mouse" > $G/configs/c.1/strings/0x409/configuration
	echo 100 > $G/configs/c.1/MaxPower
	ln -s $G/functions/hid.kbd $G/configs/c.1/
	ln -s $G/functions/hid.mouse $G/configs/c.1/
	ls /sys/class/udc | head -1 > $G/UDC
	chmod 666 /dev/hidg0 /dev/hidg1
	echo "gadget: up on $(cat $G/UDC)"
}

case "$1" in
	up) up ;;
	down) down ;;
	*) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
