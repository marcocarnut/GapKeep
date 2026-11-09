# Provenance of docs/camera/SPEC.md (clean-room record)

**Process.** SPEC.md was written by the "spec writer" (the dirty-room side). It
is a statement of facts: addresses, bit positions, numeric values, orderings and
timings, in prose and tables. A separate implementer writes the driver from
SPEC.md alone, without reading the GPL-2.0 sources listed below.

All sources were accessed on **2026-11-04**. Commit hashes are the branch heads
at that time.

## Statement

SPEC.md contains **no code** copied or paraphrased from any source: no C, no
macros, no comments, no function or data-structure layouts. Where a GPL-2.0-only
driver was the only available source, these were extracted from it: register
offsets, bit positions, the numeric values written, the order in which a
receiver or sensor must be programmed, and timing constraints. They were then
restated in my own words and tables, next to independent sources wherever one
existed. Such facts are tagged **[GPL-FACT]** in SPEC.md. No identifiers were
carried over, except register and bit names that also appear in hardware
documentation or are needed to identify the hardware field. No comment text
was reproduced. No program structure (function decomposition, state handling,
buffer-queue logic) was copied. The buffer-switching description in SPEC.md 5.4
states hardware behaviour (when addresses are latched, which status bits mean
frame start and frame end), and leaves the design of the driver to the
implementer.

## Public documentation (preferred sources)

| # | Source | Version / location | Facts taken |
| --- | --- | --- | --- |
| P1 | Sony **IMX219PQH5-C datasheet** ("RASPBERRY PI CAMERA V2 DATASHEET IMX219PQH5_7.0.0_Datasheet_XXX.PDF"), a publicly circulated copy | https://github.com/rellimmot/Sony-IMX219-Raspberry-Pi-V2-CMOS, commit bb4a45eaad8b433c2f29aaa9c06592b4efd7552f | 7-bit I2C address 0x10; CCI protocol (16-bit index, auto-increment, dummy-write read); register map 0x0000-0x0627 (model ID 0x0219, mode_select, software_reset, CSI_LANE_MODE, DPHY_CTRL, EXCK_FREQ, frame bank A registers, PLL registers, test pattern registers, fine_integration_time); access sequence for 0x3000-0x5FFF (0x30EB/0x300A/0x300B); binning encodings incl. "units: 2 lines" for FRM_LENGTH in mode 3; data types 0x00/0x01/0x12/0x2A/0x2B and CSI_DATA_FORMAT values 0x0808/0x0A0A; embedded-data lines; frame-rate and storage-time formulas; black level 64/16; analogue gain law 256/(256-X), range 0-232; digital gain 4.8 format 1.0-15.99; test pattern modes 0-9; image orientation bits; power-on/off timing t3-t10 and standby behaviour; fast standby; clock tree and 2-lane example (456/912 MHz); INCK range 6-27 MHz. The document carries a Sony "use restriction notice". Only facts were taken from it. |
| P2 | **Raspberry Pi Camera V2.1 schematic** (RPI-CAM-V2_1 rev 2.1, 2018) | https://datasheets.raspberrypi.com/camera/camera-module-2-schematics.pdf (redirects to pip.raspberrypi.com RP-008150-DS) | Connector pinout; pin 11 ENABLE drives the three regulators; pin 12 not connected (no LED); 24 MHz oscillator on the module; I2C level shifter and 2.2 kOhm pull-ups; ATSHA204A on the bus; lane wiring D0/D1 to MD0/MD1; XCLR tied to the 1.8 V rail (read from the drawing). |
| P3 | **Raspberry Pi Zero reduced schematics** | https://datasheets.raspberrypi.com/rpizero/raspberry-pi-zero-reduced-schematics.pdf (RP-008366-DS) | 22-pin camera connector signals: CAM_GPIO0 pin 17, CAM_GPIO1 pin 18, SCL0 pin 20, SDA0 pin 21, CAM1 lanes. |
| P4 | **BCM2835 ARM Peripherals** | https://datasheets.raspberrypi.com/bcm2835/bcm2835-peripherals.pdf | GPIO28 ALT0 = SDA0, GPIO29 ALT0 = SCL0 (also GPIO0/1 and 44/45 on BSC0); BSC0 at 0x7E205000; general-purpose clock register layout (password, MASH, BUSY, KILL, ENAB, SRC; DIVI/DIVF); clock source numbering. |
| P5 | Raspberry Pi firmware **dt-blob.dts** | https://raw.githubusercontent.com/raspberrypi/firmware/master/extra/dt-blob.dts, commit ab5c7f86283ceb58b7adb269cae1d16092a31bf6 | Pi Zero (`pins_pi0`): camera shutdown GPIO 41, camera LED GPIO 32, I2C port 0 on GPIO 28/29 with pull-ups, Unicam port 1, one camera; default pin states. |
| P6 | **Mailbox property interface** wiki | https://github.com/raspberrypi/firmware/wiki/Mailbox-property-interface (raw: raw.githubusercontent.com/wiki/raspberrypi/firmware/Mailbox-property-interface.md) | Tags 0x00030002 get clock rate, 0x00038002 set clock rate, 0x00030007 get min rate; clock id 4 = CORE. |
| P7 | "RPi internal registers" register list, Region CAM1 | https://paulwratt.github.io/rpi-internal-registers-online/Region_CAM1.html | Independent list of Unicam1 register names, offsets (0x7E801000 + ...) and reset values (CAMANA 0x777, CAMCLK 0x2, CAMDATn 0x2). Its provenance is unstated, and it has no bit fields. Used only to corroborate offsets and reset values. |
| P8 | MIPI CSI-2 RAW10 packing, as documented in the Linux V4L2 user-space API documentation of packed 10-bit Bayer formats (kernel.org documentation) | general reference | 4 pixels in 5 bytes, low bits in the 5th byte. Also general knowledge of the CSI-2 standard. |

## Raspberry Pi configuration data (device trees and headers; facts only)

Linux tree raspberrypi/linux, branch rpi-6.6.y, commit
bba53a117a4a5c29da892962332ff1605990e17a, files fetched from
raw.githubusercontent.com:

| # | File | Facts taken |
| --- | --- | --- |
| R1 | arch/arm/boot/dts/broadcom/bcm270x.dtsi | csi1 at 0x7E801000 (size 0x800); lane clock gate at 0x7E802004 (csi0 0x7E802000); interrupts <2 7> (csi1) and <2 6> (csi0); clocks CAM1 ("lp") and firmware clock 4 ("vpu"); power domain UNICAM1; i2c0mux structure. |
| R2 | arch/arm/boot/dts/broadcom/bcm2708-rpi-zero.dts | cam1_reg on GPIO 41 active high; GPIO line names CAM_GPIO1 = GPIO32, CAM_GPIO0 = GPIO41; i2c_csi_dsi0 = i2c0. |
| R3 | arch/arm/boot/dts/broadcom/bcm283x-rpi-i2c0mux_0_28.dtsi | I2C0 muxed between GPIO 0 and GPIO 28. |
| R4 | arch/arm/boot/dts/broadcom/bcm283x-rpi-csi1-2lane.dtsi | csi1 has 2 data lanes. |
| R5 | arch/arm/boot/dts/overlays/imx219.dtsi (and imx219-overlay.dts) | I2C address 0x10; supplies; rotation 180; clock lane 0, data lanes 1 2; **clock-noncontinuous**; link frequency 456 MHz. |
| R6 | include/dt-bindings/power/raspberrypi-power.h | RPI_POWER_DOMAIN_UNICAM1 = 13 (DT index). |
| R7 | include/dt-bindings/clock/bcm2835.h | BCM2835_CLOCK_CAM1 identifier. |
| R8 | include/soc/bcm2835/raspberrypi-firmware.h | SET_DOMAIN_STATE tag 0x00038030 (GET 0x00030030). |

## GPL-2.0 sources consulted only to extract undocumented facts

Each fact taken from these is tagged [GPL-FACT] in SPEC.md. No code, comments
or structure were copied.

| # | Source | Version | Facts taken (only where no public document exists) |
| --- | --- | --- | --- |
| G1 | drivers/media/platform/bcm2835/**vc4-regs-unicam.h** (GPL-2.0-only) | raspberrypi/linux rpi-6.6.y bba53a11 | Unicam register offsets (corroborated by P7) and all bit-field positions and names of CTRL, STA, ANA, PRI, CLK, CLT, DATn, DLT, ICTL, ISTA, IDI, IPIPE (pack/unpack codes), ICC, DCS, DBCTL, CMPn, MISC. The header itself says these came from Broadcom code drops (BCM21553 graphics driver; Android kernels for Rhea/Hawaii/Java). |
| G2 | drivers/media/platform/bcm2835/**bcm2835-unicam.c** (GPL-2.0-only) | rpi-6.6.y bba53a11 | Lane clock gate password 0x5A000000 and 2-bit-per-lane encoding; the order and values of receiver bring-up (ANA reset values, 1-2 ms wait, CPR pulse, PFT 0xF, OET 128, PRI fields, ICTL bits, LCIE height/4 min 128, CLT/DLT 2 and 6, CMP0 on FE packet, CLK/DAT bits for non-continuous clock, MISC FL0/FL1, LIP); stop sequence and 50-100 us reset pulse; status write-back clearing; frame start/end detection (FEI or PI0); address latch at frame start, and the fact that the next address must be programmed after FS; dummy buffer of size 0; 32-byte line alignment; VPU minimum 250 MHz; lp clock 100 MHz; RAW8 data type 0x2A / RAW10 0x2B in its format table (also in P1). |
| G3 | drivers/media/i2c/**imx219.c** (GPL-2.0) | rpi-6.6.y bba53a11; also rpi-5.10.y 8e1110a580887f4b82303b9354c25d7e2ff5860e; and mainline torvalds/linux master 05441d697f7f9a927264f4058cbbc6a03dfcac9d | Values written for the 640x480 mode (window 1000-2279 / 752-1711, output 640x480, TP window 1640x1232, binning 0x03 for 8 and 10 bit), common values (LINE_LENGTH 3448, DPHY auto, EXCK 24 MHz), the 2-lane PLL values (5, 1, 3, 3, 57, 1, 114), OPPXCK_DIV 8/10 per format; the 12 undocumented 0x4xxx registers; 6.2 ms power-on wait; stream-on/standby toggle at probe for LP-11; default frame lengths (1763, 3526, 853-881); the rate-factor treatment of analogue binning; binned minimum line length 3560 (mainline); Bayer order versus flips; exposure maximum FLL-4; that the sensor is started after Unicam. |
| G4 | **rsta2/libcamera** (Circle port, GPL-2.0-only) | https://github.com/rsta2/libcamera, commit b8c1f2c040625438d1a0dbdcecb1b271a4cfbb92: lib/camerainfo.cpp, lib/csi2cameradevice.cpp, README.md | Confirmation for the Pi Zero v1.3 (I2C 0 config 1, power GPIO 41, LED GPIO 32; "Zero (v1.3 only)"); that it issues SET_DOMAIN_STATE for UNICAM1, starts the CAM1 clock at 100 MHz with Circle's CGPIOClock on Pi 1-3, uses ARM_IRQ_CAM1, writes lane-gate value 0b010101, and treats the IMX219 clock as non-continuous. |
| G5 | drivers/pmdomain/bcm/raspberrypi-power.c (GPL-2.0) | rpi-6.6.y bba53a11 | Firmware domain number = DT index + 1 (so UNICAM1 = 14). |
| G6 | drivers/clk/bcm/clk-bcm2835.c (GPL-2.0+) | rpi-6.6.y bba53a11 | CM_CAM1CTL 0x048 / CM_CAM1DIV 0x04C; CAM1 divider has 4 integer and 8 fraction bits; peripheral clock parent list (source 6 = PLLD_PER). |

## Corroborating vendor material

| # | Source | Facts |
| --- | --- | --- |
| V1 | MediaTek IMX219 sensor driver file imx219mipiraw_Sensor.c (no licence header in the file), in the same repository as P1, commit bb4a45ea | Contains the same 0x30EB/0x300A/0x300B access sequence and the same twelve 0x4xxx values as G3. Used only to support the statement that these are Sony reference values, not Raspberry Pi inventions. |

## Same-licence material (GapKeep's vendored Circle, GPLv3)

Circle, as vendored in /home/mac/claude/code/lvglzero/circle (commit
7a81e1b480fe7d19fc1fc695b89bff0a0848f44b), may be used directly by GapKeep. It
was consulted for: `ARM_CM_CAM1CTL/DIV`, `ARM_CM_PASSWD`; `ARM_IRQ_CAM1` and
`ARM_FIQ_CAM1 = 39`; `PROPTAG_SET_DOMAIN_STATE`, `DOMAIN_ID_UNICAM1 = 14`,
`CLOCK_ID_CORE = 4`; `CGPIOClock` with `GPIOClockCAM1 = 9` and PLLD = 500 MHz
on Pi 1-3; `CI2CMaster` device 0 config 1 = GPIO 28/29 ALT0; `BUS_ADDRESS()`
with the 0x40000000 alias when the GPU L2 cache is enabled; 32-byte cache lines
and `CleanAndInvalidateDataCacheRange` on the Pi 1. Also the repository's own
sdcard/config.txt (no start_x) and docs/CAMERA.md / src/runtime/camera.h for
context.

## Not used

The Raspberry Pi firmware's closed camera stack and the vc4/VideoCore firmware
sources (not public) were not used. No hardware was accessed.
