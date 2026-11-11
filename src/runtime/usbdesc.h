/*
 * usbdesc.h - the USB descriptors gk:usb reads from a claimed device (the
 * device, configuration and string descriptors), parsed with every length
 * checked: what a device sends is untrusted. Plain C, shared by the kernel
 * and the simulator, and fuzzed on the host (tools/fuzz_usbdesc.sh).
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#ifndef GK_USBDESC_H
#define GK_USBDESC_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* interfaces of a device gk:usb keeps (alternate setting 0 of each) */
#define GK_USB_MAX_INTERFACES	16

/* a configuration descriptor is read whole, up to this many bytes */
#define GK_USB_MAX_CONFIG_SIZE	1024

/* strings: a string descriptor holds at most 126 UTF-16 code units, at most
   3 bytes of UTF-8 each; this many bytes of UTF-8 are kept, with the NUL */
#define GK_USB_MAX_STRING	128

typedef struct
{
	uint16_t vid, pid, bcd_device;
	uint8_t device_class;
	uint8_t max_packet0;
	uint8_t i_manufacturer, i_product, i_serial;	/* string indexes, 0: none */
	uint8_t num_configurations;
}
gk_usb_device_desc_t;

typedef struct
{
	uint8_t number;
	uint8_t cls, subclass, protocol;
	uint8_t num_endpoints;
}
gk_usb_interface_t;

typedef struct
{
	uint8_t value;			/* bConfigurationValue */
	unsigned interface_count;
	gk_usb_interface_t interfaces[GK_USB_MAX_INTERFACES];	/* in the order found */
}
gk_usb_config_t;

/* A device descriptor of n bytes (18, as USB 2.0 9.6.1 says). 0 if it is
   one, -1 otherwise. */
int gk_usb_parse_device (const uint8_t *p, size_t n, gk_usb_device_desc_t *pDesc);

/* The total length a configuration descriptor's first 9 bytes say (n of
   them), or -1 if they are not a configuration descriptor's, or say less
   than 9 or more than GK_USB_MAX_CONFIG_SIZE. */
int gk_usb_config_total (const uint8_t *p, size_t n);

/* A whole configuration descriptor, n bytes with its interfaces, endpoints
   and class descriptors: every descriptor in it must fit, be 2 bytes or
   more, and an interface's 9 or more. Alternate settings other than 0 are
   skipped; an interface number twice, or more than GK_USB_MAX_INTERFACES
   interfaces, is refused. 0 if it is good, -1 otherwise. */
int gk_usb_parse_config (const uint8_t *p, size_t n, gk_usb_config_t *pConfig);

/* String descriptor 0, n bytes: the first language it lists, in *pLangID.
   0, or -1 if it isn't one or lists none. */
int gk_usb_parse_langid (const uint8_t *p, size_t n, uint16_t *pLangID);

/* A string descriptor of n bytes (UTF-16LE) as UTF-8 in pOut (nOutSize
   bytes with the NUL; at least 4), cut at a character if it is longer.
   What may not be shown (textcheck.h: control, bidi and invisible
   characters, lone surrogates, NUL) becomes '?'. Returns the length in
   pOut, or -1 if it isn't a string descriptor (pOut is then ""). */
int gk_usb_parse_string (const uint8_t *p, size_t n, char *pOut, size_t nOutSize);

#ifdef __cplusplus
}
#endif

#endif
