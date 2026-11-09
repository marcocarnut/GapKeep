# Pi Camera Module v2.1 (IMX219) on the Pi Zero v1.3: functional specification

This document states the facts needed to write, in C++ on Circle, a driver that
powers the Raspberry Pi Camera Module v2.1, configures its Sony IMX219 sensor,
receives frames through the BCM2835's CSI-2 receiver ("Unicam", instance 1) into
memory, and stops cleanly. It contains facts only (addresses, bit positions,
values, orderings, timings) and no code. Where each fact comes from is recorded
in [PROVENANCE.md](PROVENANCE.md). The tags in square brackets say how much a
fact can be trusted:

- **[DS]**: documented in a public datasheet or schematic (Sony IMX219 datasheet,
  Raspberry Pi schematics, BCM2835 ARM Peripherals).
- **[RPI]**: published by Raspberry Pi as configuration data (dt-blob.dts, Linux
  device trees, firmware headers).
- **[GPL-FACT]**: found only in GPL-2.0 driver sources (Linux `bcm2835-unicam.c`,
  `vc4-regs-unicam.h`, `imx219.c`, or rsta2/libcamera), with no public document;
  restated here as bare facts. Expect less certainty about meaning.
- **[CIRCLE]**: available in the Circle tree vendored in this repository (GPLv3,
  the same licence as GapKeep), so it can be used directly.
- **[UNCERTAIN]**: inferred; check on hardware.

All addresses are ARM physical addresses on the BCM2835 (peripheral base
0x20000000), unless written as a VideoCore bus address (0x7Exxxxxx for
peripherals, or 0x4xxxxxxx / 0xCxxxxxxx for SDRAM).

---

## 1. Recommended mode

**640 x 480, RAW8, 2 CSI-2 data lanes, 2x2 analogue ("special") binning of a
centred 1280 x 960 crop, about 30 frame/s.**

Why:

- It is a mode the Raspberry Pi firmware itself uses (its "mode 7"). Its window
  and binning values were captured from the firmware's I2C traffic, so they are
  proven on this hardware [GPL-FACT]. The PLL, lane and link settings are those
  used for every 2-lane IMX219 mode on the Pi [GPL-FACT], and they match the
  datasheet's 2-lane clock example (912 Mbit/s per lane) [DS].
- RAW8 gives one byte per pixel and needs no unpacking. Unicam writes the
  pixels as they arrive, so a line is 640 bytes and a frame is 307 200 bytes.
  The QR decoder needs 8-bit grey, so 10 bits buys nothing. RAW8 is a plain
  sensor output format, data type 0x2A, CSI_DATA_FORMAT 0x0808 [DS]. Linux
  offers it for this mode with the same binning [GPL-FACT].
- Averaging each 2x2 Bayer block gives a 320 x 240 grey image, the size of the
  default scanner preview (docs/CAMERA.md), at very low CPU cost.
- The trade-off: the field of view is the central 1280 x 960 of the
  3280 x 2464 array, about 39 % of the width. That is a modest zoom: QR codes
  fill more pixels, but must be held more squarely in front of the lens. A
  full-field alternative (1640 x 1232 binned, then 2x2 averaged to 820 x 616
  grey) costs about 6.6 times the memory bandwidth and CPU per frame. It is
  listed in section 6.7 as an option.

RAW10 is the fallback if RAW8 misbehaves. Section 6.6 lists the differences:
CSI_DATA_FORMAT 0x0A0A, OPPXCK_DIV 10, data type 0x2B, packed 5 bytes per 4
pixels.

---

## 2. Board facts (Pi Zero v1.3 and Camera Module v2.1)

### 2.1 Pins

| Function | BCM2835 GPIO | Setting | Source |
| --- | --- | --- | --- |
| Camera power enable ("CAM_GPIO0", "CAMERA_0_SHUTDOWN") | **GPIO 41** | output; high = camera powered | dt-blob `pins_pi0`: `pin@p41` "Camera shutdown", `CAMERA_0_SHUTDOWN = 41` [RPI]; Linux `bcm2708-rpi-zero.dts`: `cam1_reg` uses GPIO 41, active high; GPIO line name "CAM_GPIO0" [RPI] |
| Camera LED ("CAM_GPIO1", "CAMERA_0_LED") | **GPIO 32** | output, pull-down; high = on | dt-blob `pin@p32` "Camera LED", `CAMERA_0_LED = 32` [RPI]; line name "CAM_GPIO1" [RPI] |
| Sensor I2C SDA | **GPIO 28** | ALT0 = SDA0 (BSC0), pull-up | dt-blob `CAMERA_0_SDA_PIN = 28`, `CAMERA_0_I2C_PORT = 0` [RPI]; BCM2835 ARM Peripherals table 6-31: GPIO28 ALT0 = SDA0 [DS] |
| Sensor I2C SCL | **GPIO 29** | ALT0 = SCL0 (BSC0), pull-up | dt-blob `CAMERA_0_SCL_PIN = 29` [RPI]; GPIO29 ALT0 = SCL0 [DS] |
| CSI-2 port | Unicam instance 1 ("CAM1", "csi1") | 2 data lanes + clock lane | dt-blob `CAMERA_0_UNICAM_PORT = 1` [RPI]; `bcm283x-rpi-csi1-2lane.dtsi`: `brcm,num-data-lanes = 2` [RPI] |

Notes:

- The firmware's default state for GPIO 41 and 32 is output, inactive (low). The
  camera is therefore unpowered at boot [RPI].
- GPIO 28/29 and GPIO 0/1 (the HAT ID EEPROM pins on the header) can **both** be
  routed to BSC0 with ALT0. Linux switches between them with a pin multiplexer
  (`i2c0mux`, pinctrl states `i2c0_gpio0` / `i2c0_gpio28`) [RPI]. Only one pair
  may be in ALT0 at a time. Otherwise both pin pairs drive the same controller.
- Circle: `CI2CMaster` device 0, configuration 1 selects GPIO 28/29 ALT0 with
  pull-ups [CIRCLE]. rsta2/libcamera uses exactly I2C 0 configuration 1, power
  GPIO 41 and LED GPIO 32 for the "Zero (v1.3 only)" [GPL-FACT].
- BSC0 is at 0x20205000 (bus 0x7E205000) [DS].
- The Zero's camera connector has 22 pins (0.5 mm pitch) and the camera has
  15 (1 mm): a Zero-specific adapter cable is needed. The Zero v1.2 has no
  camera connector at all. On the Zero's connector, CAM_GPIO0 is pin 17,
  CAM_GPIO1 pin 18, SCL0 pin 20 and SDA0 pin 21 (Pi Zero reduced schematic)
  [DS].

### 2.2 The Camera Module v2.1 board (Raspberry Pi schematic "Raspberry Pi Camera V2.1", rev 2.1, 2018) [DS]

| Connector pin (15-way) | Signal |
| --- | --- |
| 2/3, 5/6, 8/9 | CSI data lane 0 N/P, data lane 1 N/P, clock N/P |
| 11 | ENABLE: drives the enable inputs of all three regulators (1.8 V AP7331-18, 2.8 V AP7331-28, 1.2 V PAM2301) |
| 12 | not connected |
| 13/14 | SCL/SDA, level-shifted (DMG1024UV) to the sensor's 1.8 V I2C |
| 15 | 3.3 V |

- The sensor's clock (INCK/MCLK) is a **24 MHz oscillator on the module**,
  powered from the 1.8 V rail with its output enable tied high. The Pi provides
  no clock.
- The sensor's XCLR (/PWDN) pin appears tied to the 1.8 V rail. Asserting
  ENABLE (GPIO 41) therefore powers the rails, starts the oscillator and
  releases reset, all at once. The tie is read from the schematic drawing
  [UNCERTAIN in detail, but it has no consequence for the driver].
- **The v2.1 module has no LED**: pin 12 (CAM_GPIO1 / GPIO 32) is unconnected.
  Driving GPIO 32 is harmless, and it lights the LED of a Camera Module v1.
  camera.h's "the LED goes on" will not be visible with a v2.
- An **ATSHA204A** authentication chip shares the I2C bus, on the 3.3 V side.
  Its usual 7-bit address is 0x64 (Microchip default) [UNCERTAIN]. Ignore it.
- Linux describes the module as `rotation = <180>` [RPI]. The sensor is
  mounted so that its native readout is upside down relative to the module's
  "up". See section 4.8.

### 2.3 Sensor I2C

- 7-bit slave address **0x10** (datasheet Fig. 10: address bits [7:1] =
  0010000) [DS]; Linux DT `imx219@10` [RPI].
- Registers use 16-bit addresses (sent MSB first) and 8-bit data. Writes
  auto-increment, so a 16-bit register is written as a 4-byte transfer: address
  high, address low, value high, value low [DS].
- Reads: a write of the 2-byte address, then a read. The datasheet describes a
  "dummy write" of the index followed by a read, and says the index is retained
  between transfers. A STOP between the write and the read is therefore
  acceptable, and a repeated start is not required [DS]. Reads auto-increment.
- The interface is CCI, compatible with I2C fast mode / fast mode plus [DS]:
  100 kHz and 400 kHz both work. The level shifter's 2.2 kOhm pull-ups favour
  400 kHz or less.

---

## 3. Power, clocks and firmware

### 3.1 Firmware

- The SD card boots `start.elf` (not `start_x.elf`). GapKeep's config.txt does
  not set `start_x`, `camera_auto_detect` or `gpu_mem` for the camera. The GPU
  firmware therefore does not drive the camera or I2C0, and the ARM owns both.
  Keep it that way: with `start_x.elf` the GPU's own camera stack may access
  I2C0 and Unicam [RPI, general knowledge].

### 3.2 Mailbox property tags (channel 8)

| Purpose | Tag | Request | Notes |
| --- | --- | --- | --- |
| Power the Unicam1 domain on/off | **0x00038030** SET_DOMAIN_STATE | u32 domain = **14**, u32 state (1 on, 0 off) | Linux DT index RPI_POWER_DOMAIN_UNICAM1 = 13, and the firmware domain number is the DT index + 1 = 14 [GPL-FACT, RPI]; Circle names it `DOMAIN_ID_UNICAM1 = 14` and `PROPTAG_SET_DOMAIN_STATE` [CIRCLE]. rsta2/libcamera issues this tag before using Unicam [GPL-FACT]. Not in the public mailbox wiki. |
| Read the VPU ("core") clock | 0x00030002 GET_CLOCK_RATE | clock id **4** (CORE) | [DS: mailbox wiki] |
| Raise the VPU clock if needed | 0x00038002 SET_CLOCK_RATE | clock id 4, rate in Hz, skip-turbo u32 | [DS: mailbox wiki] |

- Linux requires the VPU clock to be **at least 250 MHz** while Unicam streams
  (`MIN_VPU_CLOCK_RATE`) [GPL-FACT]. On the Pi Zero the firmware's default
  core_freq is 400 MHz and core_freq_min is 250 MHz [general knowledge,
  UNCERTAIN], so no change is normally needed. Read it once and log it.
- Whether old firmware supports tag 0x00038030 is unknown [UNCERTAIN]. A
  practical check that the block is powered and clocked: after power-on, and
  before writing anything, UNICAM_ANA should read its reset value **0x00000777**
  and UNICAM_CLK should read **0x00000002** (section 5.2). All-zero reads suggest
  the block is unpowered.

### 3.3 CAM1 clock (the Unicam "lp" clock), Clock Manager

| Register | ARM address | Bus address |
| --- | --- | --- |
| CM_CAM1CTL | 0x20101048 | 0x7E101048 |
| CM_CAM1DIV | 0x2010104C | 0x7E10104C |

- The layout is the same as the documented general-purpose clocks (BCM2835 ARM
  Peripherals 6.3) [DS for GP clocks; CAM1 offsets: Linux clk-bcm2835 and
  Circle `ARM_CM_CAM1CTL/DIV` [GPL-FACT, CIRCLE]]:
  - CTL: password 0x5A in bits 31:24, MASH 10:9, BUSY 7, KILL 5, ENAB 4,
    SRC 3:0.
  - DIV: password 0x5A in bits 31:24, DIVI 23:12, DIVF 11:0.
- For CAM1, Linux declares only **4 integer bits** and **8 fraction bits** in the
  divider [GPL-FACT]. Use an integer divider of at most 15.
- Required rate: **100 MHz** (Linux sets the lp clock to 100 MHz before
  streaming) [GPL-FACT]. Source **6 = PLLD_PER, 500 MHz on Pi 1/Zero**, DIVI = 5,
  DIVF = 0, MASH 0 [DS for the source numbering; CIRCLE gives PLLD = 500 MHz].
- Circle: `CGPIOClock (GPIOClockCAM1 /* = 9 */, GPIOClockSourcePLLD)` with
  `Start (5, 0, 0)`, or `StartRate (100000000)`, does exactly this
  (control register at CM base + 9 x 8 = 0x48) [CIRCLE]. rsta2/libcamera calls
  `StartRate(100 MHz)` on Pi 1-3 [GPL-FACT].
- Stop it on shutdown: clear ENAB, then wait for BUSY to clear.

### 3.4 CSI lane clock gate

| Register | ARM address | Bus address |
| --- | --- | --- |
| CAM1 lane clock gate ("clk_gate_base" of csi1) | **0x20802004** | 0x7E802004 |

(CAM0's gate is at 0x7E802000 [RPI].) This register is not documented
publicly; all facts here are [GPL-FACT]:

- Every write carries the password **0x5A000000** OR'ed with the value.
- The value is a 2-bit field per lane, clock lane in bits 1:0, then data lane 0
  in bits 3:2, data lane 1 in bits 5:4, and so on. Each enabled lane's field
  is 01.
- **Clock lane + 2 data lanes: write 0x5A000015.** Disable all: write
  0x5A000000.

### 3.5 Interrupt

- Unicam1 raises GPU (VideoCore) peripheral interrupt **39** (bank 2, bit 7).
  Linux DT: `interrupts = <2 7>` [RPI]. Circle: `ARM_IRQ_CAM1`, and
  `ARM_FIQ_CAM1 = 39` [CIRCLE].
- The line is level-like: it stays asserted until the status bits are cleared
  in UNICAM_STA and UNICAM_ISTA (write-1-to-clear, section 5.4).

---

## 4. The IMX219 sensor

### 4.1 Identity and constants

| Item | Value | Source |
| --- | --- | --- |
| MODEL_ID, 0x0000-0x0001 (read only) | **0x02, 0x19** (0x0219) | [DS] |
| INCK on the module | 24 MHz (allowed 6-27 MHz) | [DS] |
| Active array | 3280 x 2464 (effective 3296 x 2480; active area starts 8 pixels in from the effective edges) | [DS] |
| ADC | 10 bits; black level clamped to **64** (RAW10) / **16** (RAW8) | [DS] |
| Max data rate | 912 Mbit/s per lane in 2-lane mode | [DS] |

### 4.2 Power-up and standby (datasheet section 8) [DS]

- Supplies may rise in any order. XCLR must go high only after all supplies are
  up (t3 >= 0.5 us). On the v2.1 module all of this follows from GPIO 41
  (section 2.2).
- The internal reset releases within t4 <= 200 us after supplies and XCLR. The
  sensor must not leave software standby until **t5 >= 6 ms** after XCLR rises
  (and t6 <= 32 000 INCK clocks, 1.33 ms at 24 MHz, for silicon init). Linux
  waits **6.2 ms** after power-on before touching the sensor [GPL-FACT]. Allow
  more for the module's regulators: 10-20 ms after setting GPIO 41 is a safe
  start [UNCERTAIN margin].
- After streaming starts, data begins after 1.2 ms + exposure time (t9). D-PHY
  power-up and init take t7 about 1 ms and t8 about 100 us.
- **mode_select 0x0100**: 0 = software standby, 1 = streaming. software_reset
  0x0103 bit 0 exists. Linux does not use it [GPL-FACT], and neither should we
  unless needed [UNCERTAIN: no wait time is documented].
- Stop: write 0x0100 = 0. If the write lands between frame start and frame end,
  the current frame is completed first and the sensor then enters standby. If
  it lands in frame blanking, standby is immediate. Allow one frame time before
  removing power [DS]. Optional fast standby: 0x0106 = 1, then 0x0100 = 0, and
  standby follows after the current line [DS].
- Power-off: XCLR may fall immediately after standby, and supplies may fall in
  any order [DS]. In practice: standby, wait one frame, GPIO 41 low.
- **Lane state quirk:** the sensor does not drive its CSI lanes to LP-11 after
  power-up until streaming has been started once. Linux therefore starts
  streaming (0x0100 = 1), waits about 100 us and goes back to standby
  (0x0100 = 0, then about 100 us) right after detecting the chip, before Unicam
  is started [GPL-FACT]. Do the same, or Unicam may not synchronise to the
  first frame.

### 4.3 Register write list for the recommended mode

Write in this order. The datasheet's own order is: PLL parameters, basic
(operation-critical) settings, readout mode, MIPI parameters, then
mode_select = 1 [DS]. The order below is the one Linux uses, which also works
[GPL-FACT]. All registers in the 0x01xx group are "frame bank A" registers,
latched at vertical sync [DS]. Multi-byte values are MSB at the lower address.

**A. Standby and access to manufacturer registers**

| Address | Value | Meaning | Source |
| --- | --- | --- | --- |
| 0x0100 | 0x00 | mode_select = software standby | [DS] |
| 0x30EB | 0x05 | access sequence step 1 of 6 for the 0x3000-0x5FFF area | [DS] (table 11) |
| 0x30EB | 0x0C | step 2 | [DS] |
| 0x300A | 0xFF | step 3 | [DS] |
| 0x300B | 0xFF | step 4 | [DS] |
| 0x30EB | 0x05 | step 5 | [DS] |
| 0x30EB | 0x09 | step 6 | [DS] |

**B. Undocumented "required" values** (not in the datasheet). They are part of
every Raspberry Pi mode, recorded from the Pi firmware's I2C traffic, and the
same values appear in MediaTek's IMX219 reference settings. They are thought to
be Sony's recommended analogue tuning. Meaning unknown [GPL-FACT]:

| Address | Value |
| --- | --- |
| 0x455E | 0x00 |
| 0x471E | 0x4B |
| 0x4767 | 0x0F |
| 0x4750 | 0x14 |
| 0x4540 | 0x00 |
| 0x47B4 | 0x14 |
| 0x4713 | 0x30 |
| 0x478B | 0x10 |
| 0x478F | 0x10 |
| 0x4793 | 0x10 |
| 0x4797 | 0x0E |
| 0x479B | 0x0E |

**C. Output and clocks**

| Address | Value | Register | Meaning | Source |
| --- | --- | --- | --- | --- |
| 0x0114 | 0x01 | CSI_LANE_MODE | 2 lanes (3 = 4 lanes, the default). Set before leaving standby | [DS] |
| 0x0128 | 0x00 | DPHY_CTRL | D-PHY timing automatic (default 1 = manual) | [DS], value [GPL-FACT] |
| 0x012A-0x012B | 0x18, 0x00 | EXCK_FREQ | INCK = 24 MHz (integer MHz in the high byte, fraction/256 in the low byte) | [DS] |
| 0x0301 | 0x05 | VTPXCK_DIV | video timing pixel clock divider 5 | [DS reg], value [GPL-FACT] |
| 0x0303 | 0x01 | VTSYCK_DIV | 1 | [DS] |
| 0x0304 | 0x03 | PREPLLCK_VT_DIV | 3, for INCK 24-27 MHz (auto-set from EXCK_FREQ anyway) | [DS] |
| 0x0305 | 0x03 | PREPLLCK_OP_DIV | 3 | [DS] |
| 0x0306-0x0307 | 0x00, 0x39 | PLL_VT_MPY | 57: 24 MHz / 3 x 57 = 456 MHz | [DS reg], value [GPL-FACT] |
| 0x030B | 0x01 | OPSYCK_DIV | 1 | [DS] |
| 0x030C-0x030D | 0x00, 0x72 | PLL_OP_MPY | 114: 24 / 3 x 114 = 912 MHz = 912 Mbit/s per lane | [DS reg], value [GPL-FACT] |
| 0x0309 | **0x08** | OPPXCK_DIV | 8 for RAW8 (10 for RAW10) | [DS] |
| 0x018C-0x018D | **0x08, 0x08** | CSI_DATA_FORMAT_A | RAW8 (0x0A0A = RAW10; 0x0A08 = 10-to-8 compressed "COMP8", not wanted) | [DS] |

Resulting rates: VT pixel clock 456 / 5 = 91.2 MHz. The pixel rate is 2 x
91.2 = **182.4 Mpixel/s** (the datasheet's line-time formula has a factor 2:
time per line = line_length_pck / (2 x pix clock)). The CSI-2 link frequency
(DDR clock lane) is **456 MHz**, which is 912 Mbit/s per lane [DS, GPL-FACT].
The datasheet's own 2-lane example lists vt_pix_clk_div = 10 for the same
182.4 Mpixel/s. Raspberry Pi uses 5 and that is proven, so use 5. The
discrepancy is [UNCERTAIN] and probably a datasheet error.

**D. Readout window, binning, orientation** (values for this mode [GPL-FACT];
register meanings [DS])

| Address | Value | Register | Meaning |
| --- | --- | --- | --- |
| 0x0162-0x0163 | 0x0D, 0x78 | LINE_LENGTH_A | 3448 pixel clocks per line (see 4.5) |
| 0x0164-0x0165 | 0x03, 0xE8 | X_ADD_STA_A | x start 1000 |
| 0x0166-0x0167 | 0x08, 0xE7 | X_ADD_END_A | x end 2279 (1280 wide) |
| 0x0168-0x0169 | 0x02, 0xF0 | Y_ADD_STA_A | y start 752 |
| 0x016A-0x016B | 0x06, 0xAF | Y_ADD_END_A | y end 1711 (960 tall) |
| 0x016C-0x016D | 0x02, 0x80 | x_output_size | 640 |
| 0x016E-0x016F | 0x01, 0xE0 | y_output_size | 480 |
| 0x0170 | 0x01 | X_ODD_INC_A | 1 (no subsampling) |
| 0x0171 | 0x01 | Y_ODD_INC_A | 1 |
| 0x0172 | 0x03 | IMG_ORIENTATION_A | bit 0 = horizontal mirror, bit 1 = vertical flip; see 4.8 |
| 0x0174 | 0x03 | BINNING_MODE_H_A | 0 none, 1 x2, 2 x4, **3 = x2 analogue ("special")** |
| 0x0175 | 0x03 | BINNING_MODE_V_A | same encoding |
| 0x0624-0x0625 | 0x06, 0x68 | TP_WINDOW_WIDTH | 1640: the test-pattern window, as the firmware sets it for this mode |
| 0x0626-0x0627 | 0x04, 0xD0 | TP_WINDOW_HEIGHT | 1232 |

(0x0176/0x0177, BINNING_CAL_MODE: 0 = average (default), 1 = sum. Leave at
default [DS].) The crop is centred: (1000 + 2279) / 2 = 1640 and
(752 + 1711) / 2 = 1232 approximately, matching the 3280 x 2464 array centre.

**E. Frame length, exposure, gains, test pattern**

| Address | Value | Register | Meaning |
| --- | --- | --- | --- |
| 0x0160-0x0161 | 0x06, 0xE3 | FRM_LENGTH_A | 1763: about 30 frame/s (see 4.5) |
| 0x015A-0x015B | e.g. 0x03, 0x20 | COARSE_INTEGRATION_TIME_A | exposure in line units, 1 .. FRM_LENGTH_A - 4 (800 shown, about 15 ms) |
| 0x0157 | 0x00 | ANA_GAIN_GLOBAL_A | analogue gain code 0..232 (see 4.6) |
| 0x0158-0x0159 | 0x01, 0x00 | DIG_GAIN_GLOBAL_A | digital gain 1.0 (see 4.6) |
| 0x0600-0x0601 | 0x00, 0x00 (or 0x00, 0x02) | test_pattern_mode | 0 = off, 2 = 100 % colour bars (see 4.7) |

**F. Start**

| Address | Value | Meaning |
| --- | --- | --- |
| 0x0100 | 0x01 | streaming |

Start Unicam (section 5.3) **before** writing 0x0100 = 1, as Linux does
[GPL-FACT].

### 4.4 CSI-2 output [DS]

- Short packets: Frame Start data type 0x00, Frame End 0x01. Long packets:
  **RAW8 data type 0x2A**, **RAW10 0x2B**, **embedded data 0x12**. The virtual
  channel is set by CSI_CH_ID (0x0110, default 0). Use VC 0.
- The sensor sends **two embedded-data lines** (DT 0x12) after Frame Start,
  before the image lines. They hold register values in a tagged format. Unicam
  filters by data type (section 5.3), so with only DT 0x2A selected they are
  not written to the image buffer.
- Between lines and frames the lanes go to LP-11. The clock lane stops in
  blanking: the IMX219's clock is **non-continuous**. Linux DT says
  `clock-noncontinuous` [RPI], and rsta2/libcamera comments "non-continous
  clock" [GPL-FACT]. This decides the Unicam lane settings in section 5.3.
- Lanes on the module: connector D0 is the sensor's MD0 and D1 is MD1 [DS].
  Linux DT: clock lane 0, data lanes 1 and 2 [RPI]. No lane swapping is needed.

### 4.5 Frame timing

- Time per line = LINE_LENGTH_A / 182.4 MHz = 3448 / 182.4e6 = **18.90 us**
  [DS formula, values GPL-FACT].
- Frame period = FRM_LENGTH_A x line time. With FRM_LENGTH_A = 1763:
  33.33 ms, **30.0 frame/s**.
- In analogue binning mode (BINNING_MODE = 3), the datasheet says
  FRM_LENGTH_A counts in **units of 2 lines** [DS]. Linux models this as a
  doubled pixel rate (364.8 Mpixel/s) and halves the values it writes to
  FRM_LENGTH_A and COARSE_INTEGRATION_TIME_A [GPL-FACT]. The two descriptions
  agree when one register unit is taken as LINE_LENGTH_A / 182.4 MHz of real
  time. An older Raspberry Pi driver wrote 1763 for this mode and called it
  30 frame/s; current ones write about 853-881 and call it 60 frame/s
  [GPL-FACT]. Both fit the rule above. **Verify by timing frame-start
  interrupts.** If the measured rate is 15 frame/s, halve FRM_LENGTH_A.
- Mainline Linux raises the minimum LINE_LENGTH_A to **3560 (0x0DE8)** in
  analogue binning, because 3448 "can cause artefacts with RAW10" (the ADC
  works on two lines together) [GPL-FACT]. With RAW8, 3448 is what the Pi
  firmware used. If artefacts (horizontal banding) appear, use 3560 and
  FRM_LENGTH_A 1708 for 30.0 frame/s (line time 19.52 us).
- The exposure must stay at most FRM_LENGTH_A - 4. If it is larger, the frame
  stretches to exposure + 4 lines [DS].
- Changes to gain and exposure take effect at the next or the following frame
  without blanking glitches. Changes to binning, vertical flip, vertical window
  or subsampling cause a longer "no data" gap [DS]. Set those only in standby.

### 4.6 Exposure and gain [DS]

| Control | Register | Range | Law |
| --- | --- | --- | --- |
| Exposure (coarse integration time) | 0x015A-0x015B (16 bits) | 1 .. FRM_LENGTH_A - 4 (Linux uses minimum 4) | T = coarse x line time + fine offset. fine_integration_time (0x0388-0x0389, read only) = 500 pixel clocks, and the offset is fine / 2 pixel-clock periods (negligible) |
| Analogue gain | 0x0157 (8 bits) | **0 .. 232** | gain = 256 / (256 - code): 0 = 1.0x, 128 = 2.0x, 192 = 4.0x, 224 = 8.0x, 232 = 10.67x |
| Digital gain | 0x0158 (bits 3:0) + 0x0159 | **0x0100 .. 0x0FFF** | 4.8 fixed point: gain = high byte + low byte / 256, 1.0x .. 15.996x |

Use analogue gain before digital gain: digital gain only scales, and coarsens,
the numbers. Write each 16-bit value in one auto-incrementing I2C transfer so
that the two bytes are latched at the same V-sync.

### 4.7 Test patterns [DS]

| Address | Meaning |
| --- | --- |
| 0x0600-0x0601 | test_pattern_mode: 0 none, **1 solid colour**, **2 100 % colour bars**, 3 fade-to-grey colour bars, 4 PN9, 5 16-split colour bars, 6 inverted 16-split, **7 column counter**, 8 inverted column counter, 9 PN31 |
| 0x0602-0x0603 | test_data_red (10 bits) |
| 0x0604-0x0605 | test_data_greenR |
| 0x0606-0x0607 | test_data_blue |
| 0x0608-0x0609 | test_data_greenB |
| 0x0620-0x0627 | test-pattern window x/y offset, width, height |

- The pattern generator sits after the analogue chain and **before digital gain
  and black-level adjust** (datasheet section 6 data-flow figure). Keep digital
  gain at 1.0x when checking exact values.
- The pattern can be switched on and off while streaming. Registers may be set
  in any order [DS].
- Colour bars appear as vertical bands of constant value. In grey they show as
  about 8 bands of different brightness. The exact colour order is drawn in the
  datasheet figure but not given as text [UNCERTAIN].
- For exact verification of the data path, two patterns are better:
  - Solid colour (mode 1) with all four test_data values set to the same
    10-bit value V. In RAW8 every pixel should then be V >> 2, possibly offset
    by the black-level stage [UNCERTAIN].
  - The column counter (mode 7), which shows byte order and line stride errors
    immediately.

### 4.8 Orientation and Bayer order

- IMG_ORIENTATION_A 0x0172: bit 0 = horizontal mirror, bit 1 = vertical flip
  [DS]. Set it in standby. The vertical flip causes a no-data gap if changed
  while streaming [DS].
- The module is mounted rotated by 180 degrees (Linux DT `rotation = <180>`
  [RPI]). An upright image therefore needs **both** flips: **0x0172 = 0x03**
  [UNCERTAIN: confirm with a real scene]. A 180 degree rotation does not stop
  QR decoding, but a single mirror does (quirc needs an explicit flip), so
  never set only one bit.
- Bayer order of the first pixel of the image for this window [GPL-FACT, from
  Linux's format table]:

| 0x0172 | Order |
| --- | --- |
| 0x00 | RGGB |
| 0x01 (H mirror) | GRBG |
| 0x02 (V flip) | GBRG |
| 0x03 (both) | **BGGR** |

The 2x2 average used for grey (section 6) does not depend on the order.

---

## 5. Unicam (CSI-2 receiver), instance 1

### 5.1 Base and access

- Unicam1 registers: **0x20801000-0x208017FF** (bus 0x7E801000, size 0x800).
  Unicam0 is at 0x7E800000 [RPI].
- 32-bit registers. Use read-modify-write where noted.
- No public Broadcom documentation exists. The register **offsets and reset
  values** are corroborated by an independent register list ("rpi-internal-
  registers", Region CAM1), which names them CAM1_CAMCTL, CAM1_CAMSTA and so
  on. The **bit fields** come only from Linux's `vc4-regs-unicam.h`, which says
  they were taken from Broadcom's code drops for the BCM21553 and the
  Rhea/Hawaii/Java Android kernels [GPL-FACT]. Meanings in the tables below
  that go beyond the bit name are inferred [UNCERTAIN].

### 5.2 Register map

| Offset | Name | Reset value [list] | Purpose |
| --- | --- | --- | --- |
| 0x000 | CTRL | 0x00000000 | receiver control |
| 0x004 | STA | 0 | receiver status, write 1 to clear |
| 0x008 | ANA | **0x00000777** | analogue (D-PHY) control |
| 0x00C | PRI | 0 | AXI bus priority / QoS |
| 0x010 | CLK | **0x00000002** | clock lane control |
| 0x014 | CLT | 0 | clock lane timing |
| 0x018 | DAT0 | 0x00000002 | data lane 0 control |
| 0x01C | DAT1 | 0x00000002 | data lane 1 control |
| 0x020 | DAT2 | 0x00000002 | data lane 2 (only on 4-lane-capable instances) |
| 0x024 | DAT3 | 0x00000002 | data lane 3 |
| 0x028 | DLT | 0 | data lane timing |
| 0x02C | CMP0 | 0 | packet compare 0 |
| 0x030 | CMP1 | 0 | packet compare 1 |
| 0x034 | CAP0 | 0 | captured packet 0 |
| 0x038 | CAP1 | 0 | captured packet 1 |
| 0x0F0-0x0FC | DBG0-3 | 0 | debug |
| 0x100 | ICTL | 0 | image control |
| 0x104 | ISTA | 0 | image status, write 1 to clear |
| 0x108 | IDI0 | 0 | image data identifiers (VC/DT) 0 |
| 0x10C | IPIPE | 0 | image pipeline (unpack/pack) |
| 0x110 | IBSA0 | 0 | image buffer start address 0 (bus address) |
| 0x114 | IBEA0 | 0 | image buffer end address 0 (bus address) |
| 0x118 | IBLS | 0 | image buffer line stride (bytes) |
| 0x11C | IBWP | 0 | image buffer write pointer (read: current DMA address) |
| 0x120 | IHWIN | 0 | horizontal window (0 = off) |
| 0x124 | IHSTA | 0 | horizontal status |
| 0x128 | IVWIN | 0 | vertical window (0 = off) |
| 0x12C | IVSTA | 0 | vertical status |
| 0x130 | ICC | 0 | image compression control (DPCM) |
| 0x134 | ICS | 0 | image compression status |
| 0x138 | IDC | 0 | image data control |
| 0x13C | IDPO | 0 | image data pixel offset |
| 0x140 | IDCA | 0 | |
| 0x144 | IDCD | 0 | |
| 0x148 | IDS | 0 | image data status |
| 0x200 | DCS | 0 | embedded ("data") channel control and status |
| 0x204 | DBSA0 | 0 | data buffer start 0 |
| 0x208 | DBEA0 | 0 | data buffer end 0 |
| 0x20C | DBWP | 0 | data buffer write pointer |
| 0x300 | DBCTL | 0 | double-buffer control |
| 0x304 | IBSA1 | 0 | image buffer start 1 (double-buffer mode) |
| 0x308 | IBEA1 | 0 | image buffer end 1 |
| 0x30C | IDI1 | 0 | image data identifiers 1 |
| 0x310 | DBSA1 | 0 | |
| 0x314 | DBEA1 | 0 | |
| 0x400 | MISC | 0 | miscellaneous |

**Bit fields** [GPL-FACT]:

CTRL (0x000)

| Bits | Name | Meaning |
| --- | --- | --- |
| 0 | CPE | peripheral enable |
| 1 | MEM | set at initialisation, presumably "output to memory" [UNCERTAIN] |
| 2 | CPR | peripheral reset (pulse 1 then 0) |
| 3 | CPM | mode: 0 = CSI-2, 1 = CCP2 |
| 4 | SOE | stop output engine (1 = stop) |
| 5 | DCM | data clock mode, CCP2 only: 0 strobe, 1 data. 0 for CSI-2 |
| 6 | SLS | (unused) |
| 11:8 | PFT | packet framer timeout |
| 20:12 | OET | output engine timeout |

STA (0x004), write 1 to clear. The names are from the header and the
expansions are guesses [UNCERTAIN]:

| Bit | Name | Bit | Name |
| --- | --- | --- | --- |
| 0 | SYN (synchronised) | 13 | PS (packet status) |
| 1 | CS (clock status) | 14 | **IS** (image status: an ISTA bit is set) |
| 2 | SBE (single-bit ECC error, corrected) | 15 | **PI0** (packet compare 0 matched) |
| 3 | PBE (packet/multi-bit ECC error) | 16 | PI1 |
| 4 | HOE (header overflow error) | 17 | FSI_S (frame start, mirror) |
| 5 | PLE (packet length error) | 18 | FEI_S (frame end, mirror) |
| 6 | SSC (sync short-packet error) | 19 | LCI_S (line count, mirror) |
| 7 | CRCE (CRC error) | 20 | BUF0_RDY |
| 8 | OES (output engine stopped) | 21 | BUF0_NO |
| 9 | IFO (input FIFO overflow) | 22 | BUF1_RDY |
| 10 | OFO (output FIFO overflow) | 23 | BUF1_NO |
| 11 | BFO (buffer overflow) | 24 | DI |
| 12 | DL (data lane...) | | |

The "clear all" mask Linux writes at start is bits 2, 3, 4, 5, 6, 7, 9, 10, 12,
13, 15, 16 = **0x0001B6FC**.

ANA (0x008)

| Bits | Name | Meaning |
| --- | --- | --- |
| 0 | APD | analogue power down (reset 1) |
| 1 | BPD | bias power down (reset 1) |
| 2 | AR | analogue reset (reset 1) |
| 3 | DDL | disable data lanes (1 = disabled) |
| 7:4 | CTATADJ | (reset 7) |
| 11:8 | PTATADJ | (reset 7) |

PRI (0x00C): bit 0 PE (panic enable?), bits 2:1 PT (panic threshold?), bits
7:4 NP (normal priority?), bits 11:8 PP (panic priority?), bits 15:12 BS
(burst size?), bits 17:16 BL (burst length?). Expansions [UNCERTAIN].

CLK (0x010): bit 0 CLE (clock lane enable), 1 CLPD (power down, reset 1),
2 CLLPE (low-power receiver enable), 3 CLHSE (high-speed enable), 4 CLTRE
(termination enable), 8:5 CLAC, 29 CLSTE (status/error).

CLT (0x014): bits 7:0 CLT1 = tclk_term_en, bits 15:8 CLT2 = tclk_settle.

DAT0..3 (0x018..0x024): bit 0 DLE (lane enable), 1 DLPD (power down, reset 1),
2 DLLPE, 3 DLHSE, 4 DLTRE, 5 DLSM (sync matching?), 28 DLFO (FIFO overflow),
29 DLSTE.

DLT (0x028): bits 7:0 DLT1 = td_term_en, 15:8 DLT2 = ths_settle, 23:16 DLT3 =
trx_enable.

CMP0/1 (0x02C/0x030): bit 31 PCE (compare enable), 9 GI (generate interrupt),
8 CPH (capture header into CAPn), 7:6 PCVC (virtual channel), 5:0 PCDT (data
type).

ICTL (0x100)

| Bits | Name | Meaning |
| --- | --- | --- |
| 0 | FSIE | frame-start interrupt enable |
| 1 | FEIE | frame-end interrupt enable |
| 2 | IBOB | image buffer overflow behaviour (set by Linux; presumably "don't wrap / stop at end address") [UNCERTAIN] |
| 3 | FCM | frame capture mode |
| 4 | TFC | trigger frame capture |
| 6:5 | LIP | load image pointers (write 1 to load IBSA0/IBEA0 now) |
| 28:16 | LCIE | line-count interrupt every N lines (0 = off) |

ISTA (0x104), write 1 to clear: bit 0 FSI (frame start), 1 FEI (frame end),
2 LCI (line count).

IDI0/IDI1 (0x108/0x30C): four 8-bit identifiers ID0 7:0, ID1 15:8, ID2 23:16,
ID3 31:24. In CSI-2 mode each is (VC << 6) | DT. Packets whose VC/DT match go
to the image buffer.

IPIPE (0x10C)

| Bits | Name | Values |
| --- | --- | --- |
| 2:0 | PUM (unpack) | 0 none, 1 unpack6, 2 unpack7, 3 unpack8, 4 unpack10, 5 unpack12, 6 unpack14, 7 unpack16 |
| 6:3 | DDM | (decode/DPCM mode) |
| 9:7 | PPM (pack) | 0 none, 1 pack8, 2 pack10, 3 pack12, 4 pack14, 5 pack16 |
| 11:10 | DEM | |
| 14:12 | DEBL | |
| 16:15 | ICM | |
| 17 | IDM | |

ICC (0x130): ICFL 4:0, ICFH 9:5, ICST 12:10, ICLT 15:13, ICLL 31:16 (DPCM
compression; leave 0).

DCS (0x200): bit 0 DIE, 1 DIM, 3 DBOB, 4 FDE, 5 LDP (load data pointers),
15:8 EDL (embedded data lines). Leave 0, so embedded data is not captured.

DBCTL (0x300): bit 0 DBEN (double-buffer enable), 1 BUF0_IE, 2 BUF1_IE. Not
used by Linux. Leave 0.

MISC (0x400): bit 6 FL0, bit 9 FL1. Linux sets both before enabling, with no
stated meaning [GPL-FACT, UNCERTAIN].

### 5.3 Bring-up sequence (CSI-2, 2 lanes, non-continuous clock, RAW8)

Preconditions: Unicam1 power domain on, CAM1 clock running at 100 MHz, VPU
clock at least 250 MHz, sensor powered and configured but in standby with its
lanes in LP-11 (section 4.2). The values are those Linux writes [GPL-FACT].
The resulting register values are worked out in the right-hand column.

| Step | Action | Resulting value |
| --- | --- | --- |
| 1 | Lane clock gate: enable clock lane + 2 data lanes | 0x20802004 = 0x5A000015 |
| 2 | CTRL = MEM only | CTRL = 0x00000002 |
| 3 | ANA = AR with CTATADJ = 7, PTATADJ = 7 (analogue on, held in reset) | ANA = 0x00000774 |
| 4 | Wait 1-2 ms | |
| 5 | Clear ANA.AR | ANA = 0x00000770 |
| 6 | Pulse CTRL.CPR: set, then clear | |
| 7 | Clear CTRL.CPE | |
| 8 | CTRL read-modify-write: CPM = 0 (CSI-2), DCM = 0, PFT = 0xF, OET = 128 | CTRL = 0x00080F02 |
| 9 | IHWIN = 0, IVWIN = 0 (no windowing) | |
| 10 | PRI read-modify-write: BL = 0, BS = 0, PP = 0xE, NP = 8, PT = 2, PE = 1 | PRI = 0x00000E85 |
| 11 | Clear ANA.DDL (enable data lanes) | ANA = 0x00000770 |
| 12 | ICTL = FSIE + FEIE + IBOB, LCIE = N (Linux: max(height / 4, 128); 128 for 480 lines) | ICTL = 0x00800007 |
| 13 | Clear status: STA = 0x0001B6FC, ISTA = 0x00000007 | |
| 14 | CLT: tclk_term_en = 2, tclk_settle = 6 | CLT = 0x00000602 |
| 15 | DLT: td_term_en = 2, ths_settle = 6, trx_enable = 0 | DLT = 0x00000602 |
| 16 | Clear CTRL.SOE | |
| 17 | CMP0: PCE = 1, GI = 1, CPH = 1, PCVC = 0, PCDT = 0x01 (Frame End short packet). Linux: "required to avoid missing frame ends" | CMP0 = 0x80000301 |
| 18 | CLK = CLE + CLLPE (for a non-continuous clock, **not** CLHSE/CLTRE) | CLK = 0x00000005 |
| 19 | DAT0 = DLE + DLLPE (non-continuous: not DLHSE/DLTRE); DAT1 = same | DAT0 = DAT1 = 0x00000005 |
| 20 | DAT2/DAT3: Linux writes them only when the DT allows more than 2 lanes. On the Zero (2 lanes) leave them alone | |
| 21 | IBLS = line stride in bytes | 640 |
| 22 | IBSA0 = bus address of the first buffer; IBEA0 = IBSA0 + stride x height (end is exclusive) | |
| 23 | IPIPE: PUM = 0, PPM = 0 (store as received) | IPIPE = 0 |
| 24 | IDI0 = (VC 0 << 6) \| 0x2A | IDI0 = 0x0000002A |
| 25 | MISC read-modify-write: set FL0 (bit 6) and FL1 (bit 9) | MISC \|= 0x240 |
| 26 | Set CTRL.CPE | CTRL = 0x00080F03 |
| 27 | ICTL.LIP = 1: load the image pointers | ICTL = 0x00800027 |
| 28 | Sensor: 0x0100 = 1 (streaming) | |

About the timing values: CLT and DLT are counts of an internal clock, most
likely the 100 MHz CAM1 clock (10 ns units) [UNCERTAIN]. With values 2 and 6,
Linux and the Pi capture every IMX219 mode at 912 Mbit/s per lane [GPL-FACT].

### 5.4 Frames, interrupts and buffer switching [GPL-FACT, behaviour inferred from Linux's interrupt handling]

- On each interrupt: read STA and write the value back (clears it). Read ISTA
  and write it back. If neither STA.IS nor STA.PI0 is set, there is nothing to
  do.
- **Frame end** = ISTA.FEI **or** STA.PI0 (the packet-compare match on the FE
  short packet). **Frame start** = ISTA.FSI.
- **The buffer address is latched at frame start.** IBSA0/IBEA0 act as
  "next frame" registers: whatever they hold when a frame starts is where that
  frame is written. LIP forces a load at start-up.
- Therefore program the *next* buffer **after** a frame start (and, as a
  fallback, on a line-count interrupt), never at frame end. Linux says the
  hardware may not take the new address if a new frame has already started
  [GPL-FACT].
- If FE and FS arrive in one interrupt, handle FE first.
- A frame is complete at FE, in the buffer that was latched at the preceding FS.
- The receiver cannot be paused while the sensor streams. When no free buffer is
  available at FS, Linux points IBSA0/IBEA0 at a **dummy buffer** with
  end = start (size 0), so the hardware keeps writing into a harmless place
  [GPL-FACT; exactly how the hardware behaves at end = start is UNCERTAIN, so
  give the dummy buffer one page of real memory]. A simpler scheme for us:
  three buffers in rotation (being written, being latched next, owned by the
  consumer). If the consumer still holds a buffer, reprogram the same "next"
  buffer, which drops that frame.
- Line-count interrupts (LCIE) arrive every N lines. They are not needed for
  correctness. LCIE = 0 turns them off [UNCERTAIN], or ignore them.
- IBWP reads the current write address: (IBWP - IBSA) / stride = lines written
  so far.
- Error indications worth logging (not clearing as errors): STA.IFO, OFO and
  BFO (FIFO overflows: bus or VPU clock too slow), SBE/PBE/CRCE/PLE (link
  errors: timing settle values or signal integrity).

### 5.5 Alignment and memory

- Line stride (IBLS): Linux rounds bytes-per-line up to a multiple of **32**
  [GPL-FACT]. 640 already is.
- Start addresses: use at least 32-byte (cache-line) alignment. Page (4 KiB)
  alignment is what Linux's allocator gives [GPL-FACT for Linux usage; the
  hardware minimum is UNCERTAIN, at least 16 bytes].
- IBSA/IBEA are **VideoCore bus addresses**. On the Pi 1/Zero with the GPU L2
  cache enabled for the ARM (Circle's default), SDRAM is seen by devices at the
  **0x40000000** alias. Circle's `BUS_ADDRESS()` produces the right alias for
  the build configuration [CIRCLE].
- Frame size RAW8 640 x 480 = 307 200 bytes (300 KiB). Three buffers take about
  900 KiB.
- Bandwidth: 640 x 480 x 30 = 9.2 MB/s, trivial for the bus.

### 5.6 Stop sequence [GPL-FACT]

| Step | Action |
| --- | --- |
| 1 | Sensor: 0x0100 = 0 (standby). The current frame completes, if one was in progress |
| 2 | ANA.DDL = 1 (disable data lanes) |
| 3 | CTRL.SOE = 1 (stop output engine) |
| 4 | DAT0 = 0, DAT1 = 0 (and DAT2/DAT3 = 0 on 4-lane instances) |
| 5 | Pulse CTRL.CPR: set, wait 50-100 us, clear |
| 6 | Clear CTRL.CPE |
| 7 | DCS = 0 |
| 8 | Lane clock gate 0x20802004 = 0x5A000000 |
| 9 | Disable the IRQ; stop the CAM1 clock; release any VPU clock request; domain 14 off (optional) |
| 10 | Wait one frame time after step 1, then GPIO 41 low (camera off), GPIO 32 low |

Only after step 6 may the frame buffers be freed or reused for other data.

---

## 6. Data format and grey conversion

### 6.1 RAW8 in memory

- One byte per pixel, pixels in sensor order left to right, lines top to
  bottom, each line starting at IBSA + line x IBLS. With 640 pixels and stride
  640 there is no padding.
- Values are the top 8 bits of the 10-bit ADC result after digital gain, with
  the black level at **16** [DS].

### 6.2 RAW10 in memory (the fallback; IPIPE = 0)

- MIPI CSI-2 RAW10 packing: every **5 bytes hold 4 pixels**. Bytes 0-3 are
  bits 9:2 of pixels 0-3. Byte 4 holds the 2 low bits: pixel 0 in bits 1:0,
  pixel 1 in bits 3:2, pixel 2 in bits 5:4, pixel 3 in bits 7:6 [MIPI CSI-2
  RAW10 definition, public in V4L2 documentation of the packed 10-bit Bayer
  formats].
- A 640-pixel line is 800 bytes (a multiple of 32). For 8-bit grey, ignoring
  every fifth byte is enough.
- The black level is 64 (in 10-bit units) [DS].
- Alternatively, Unicam can expand to 16 bits per pixel: IPIPE PUM = 4
  (unpack10), PPM = 5 (pack16). The line is then 2 x width bytes [GPL-FACT].

### 6.3 Bayer to grey

- The image is a Bayer mosaic, 2 x 2 tiles of one red, two green, one blue
  (section 4.8 gives the order). For one grey pixel per tile, take the
  **average of the four values** (sum >> 2). That is roughly luminance and
  independent of the order, so flips do not need special cases. A
  640 x 480 RAW8 frame becomes **320 x 240 grey**.
- Optional: subtract the black level (16 in RAW8), clamping at 0, and stretch,
  so that black reads as 0.
- A more luma-like weighting (for example R x 0.3, G x 0.59, B x 0.11) needs
  the Bayer order and gains nothing for QR codes. Under strongly coloured light
  the plain average is the more robust choice.
- Read the buffer only after FE and after the cache maintenance in section 8.

### 6.4 Colour bars through this path

In grey, bars appear as vertical bands of constant value 320 / 8 = 40 pixels
wide, if the pattern spans the whole output [UNCERTAIN: the TP_WINDOW
registers are set to 1640 x 1232 for this mode].

### 6.5 Embedded data

Not captured: IDI0 selects only DT 0x2A, and DCS = 0.

### 6.6 RAW10 differences in brief

| Item | RAW8 | RAW10 |
| --- | --- | --- |
| 0x018C-0x018D | 0x08, 0x08 | 0x0A, 0x0A |
| 0x0309 | 0x08 | 0x0A |
| IDI0 data type | 0x2A | 0x2B |
| Stride for 640 pixels | 640 | 800 (packed) or 1280 (unpack10 + pack16) |
| Black level | 16 | 64 |

### 6.7 Other modes (for reference, values [GPL-FACT])

| Mode | X start-end | Y start-end | Output | Binning 0x0174/0x0175 | Typical FRM_LENGTH_A |
| --- | --- | --- | --- | --- | --- |
| Full field, binned | 0-3279 | 0-2463 | 1640 x 1232 | 0x01 (x2, RAW10) or 0x03 (analogue, RAW8 in Linux) | 1763 (30 frame/s) |
| 1080p crop | 680-2599 | 692-1771 | 1920 x 1080 | 0x00 | 1763 |
| Full resolution | 0-3279 | 0-2463 | 3280 x 2464 | 0x00 | 3526 (15 frame/s) |

The datasheet also lists x4 binning (BINNING_MODE = 2, "digital"), which would
give 820 x 616 over the full field. No Raspberry Pi software uses it, so it is
untested on this board [UNCERTAIN].

---

## 7. Auto-exposure (the sensor has none)

Controls: exposure lines E (1 .. FRM_LENGTH_A - 4), analogue gain code A
(0..232, gain 256 / (256 - A)), digital gain D (1.0..16). Total brightness is
roughly proportional to E x gainA x gainD, minus the black level. New values
take effect one or two frames after they are written [DS], so measure, change,
and then skip two frames before measuring again.

Suggested algorithm, in prose:

1. **Measure** on the grey image you already compute: the mean over a central
   region (for example the middle half), excluding the black level, plus a
   bright-percentile estimate (for example the 95th percentile from a
   64-bucket histogram) to catch clipping. Sub-sampling every 4th pixel is
   plenty.
2. **Target**: mean grey about 0.4-0.5 of full scale. If more than about 2 % of
   pixels are at 255, lower the target. QR codes need contrast, not
   brightness, so slight underexposure is better than clipping.
3. **Correct** the total exposure product by target / measured, limited per
   step (for example between x0.5 and x2) and damped (move about half-way in
   log terms) to avoid oscillation. Treat a measurement of almost nothing as
   "multiply by 2".
4. **Distribute** the product in this order:
   - Exposure time first, up to a motion-blur cap. A handheld code wants
     10-15 ms, about 530-800 lines at 18.9 us.
   - Then analogue gain up to about 8x (code 224).
   - Then exposure up to the frame limit.
   - Digital gain last.
   - Going darker, reduce in the reverse order.
5. **Write** exposure and gains right after a frame-end interrupt (in frame
   blanking), each 16-bit value in one I2C transfer, so that all values are
   latched at the same V-sync.
6. Optionally, in very dark scenes, lengthen FRM_LENGTH_A (lower frame rate) to
   allow longer exposures. FRM_LENGTH_A may change while streaming because it
   is a frame-bank register, but changes take effect with a delay.

Start values: E = 800 lines, A = 0, D = 1.0. Convergence then takes a few
frames.

---

## 8. Known pitfalls

1. **Cache coherency (ARM1176, 32-byte L1 lines).** Unicam writes SDRAM behind
   the CPU's data cache.
   - Align buffers to 32 bytes and size them in whole cache lines.
   - Before handing a buffer to Unicam, clean and invalidate its range. Then
     never write it from the CPU while Unicam may.
   - After FE, before reading, invalidate its range again (Circle's
     `CleanAndInvalidateDataCacheRange` is the available primitive on the
     Pi 1 [CIRCLE]). Reading a buffer with no dirty lines makes this safe.
   - Alternatively, use non-cached (coherent) memory, which is slow for the
     CPU's 2x2 pass. Circle's coherent region is small and shared, so cached
     buffers with maintenance are preferable.
   - Use DataSyncBarrier/DataMemBarrier around register writes that publish
     buffer addresses.
2. **Bus addresses.** IBSA/IBEA take VideoCore bus addresses, not ARM
   physical addresses: use Circle's `BUS_ADDRESS()`.
3. **LP-11 at start-up.** The IMX219 does not enter LP-11 until it has
   streamed once. Do the stream-on/stream-off toggle after power-up
   (section 4.2), or the receiver may not sync.
4. **Non-continuous clock.** Do not enable HS termination (CLHSE/CLTRE,
   DLHSE/DLTRE) for this sensor. Linux enables those only for
   continuous-clock sensors [GPL-FACT].
5. **Missing frame ends.** Without the CMP0 packet-compare on the FE short
   packet, frame-end interrupts can be missed [GPL-FACT]. Treat STA.PI0 as a
   frame end.
6. **Buffer switch timing.** Program the next address after FS, not at FE. A
   new address written too late is silently not used for the following frame.
7. **Never leave Unicam without a valid buffer** while the sensor streams. It
   cannot be paused and will write wherever IBSA points.
8. **Stop order.** Stop the sensor first, then Unicam (section 5.6). Do not
   free buffers before CPE is cleared.
9. **VPU clock.** Below 250 MHz, Unicam's FIFOs may overflow (STA.IFO/OFO)
   [GPL-FACT].
10. **I2C pin mux.** Do not leave GPIO 0/1 in ALT0 while using GPIO 28/29 for
    BSC0.
11. **Wrong firmware.** `start_x.elf`, or `camera_auto_detect=1` / `start_x=1`
    in config.txt, lets the GPU firmware talk to the camera.
12. **Power-up time.** Talking to the sensor sooner than about 6 ms after
    GPIO 41 rises fails (NAKs, or a chip ID of 0).
13. **16-bit register tearing.** Write MSB and LSB in one transfer. Values
    straddling a V-sync give a one-frame glitch.
14. **Orientation.** Set 0x0172 before streaming. A single mirror makes QR
    codes unreadable.
15. **Hardware variants.** Some third-party "v2" modules (clones) differ: other
    oscillators, an LED on pin 12. The chip-ID check (0x0219) catches
    non-IMX219 modules, such as a v1 (OV5647, address 0x36) or a v3 (IMX708,
    unsupported).
16. **Unpowered block.** If register reads return 0 instead of the reset values
    (ANA 0x777, CLK 0x2), the power domain or clock is off.

---

## 9. Main uncertainties

- Meanings of several Unicam bits (MEM, IBOB, MISC FL0/FL1, the PRI fields,
  the units of the CLT/DLT timing values). The values to write are known
  [GPL-FACT]; the reasons are not.
- The real frame rate for a given FRM_LENGTH_A in analogue-binned mode
  (30 vs 60 frame/s for 1763 lines; section 4.5). Measure it.
- Whether tag 0x00038030 is needed or supported on the firmware in use.
  Detect with the reset-value check.
- Which flip makes the image upright on a real module (expected 0x03).
- The test-pattern window registers in this mode (copied from the firmware
  trace) and the exact bar order.
- The 12 undocumented 0x4xxx register values: required by convention, with
  unknown effect.
