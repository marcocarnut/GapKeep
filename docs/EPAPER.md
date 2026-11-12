# E-paper panels

An e-paper panel keeps its picture without power, for years. Wired to the
Pi Zero's GPIO header, it lets an app write something a person must keep,
a secret share above all, onto a thing that is then unplugged and put
away: the share never goes near a phone's camera or a printer, and each
panel holds one share. Apps draw on the panel with the same `gk:ui`
widgets as on the screen ([API.md, ui.epaper](API.md#uiepaper)); the
kernel turns that into the panel's black, white and red pixels, and drives
the panel.

Only the kernel talks to the panel, through a driver for the panels below,
and only apps with the `"epaper"` permission may ask it to. There is no
general GPIO or SPI access for apps: on an air-gapped machine that would be
a way out for data (a blinking pin, a radio made of a wire).

## Panels

| `epaper =` | Module | Controller | Pixels | Colours | Refresh |
| --- | --- | --- | --- | --- | --- |
| `weact-2.9-bwr` | WeAct 2.9" B/W/R | SSD1680 | 296 × 128 | black, white, red | about 18 s |
| `weact-2.13-bw` | WeAct 2.13" B/W | SSD1680 | 250 × 122 | black, white | about 3 s |
| `weact-4.2-bw` | WeAct 4.2" B/W | SSD1683 | 400 × 300 | black, white | about 3 s |

(Pixels as an app gets them by default, landscape; `portrait` turns them.)
The 2.9" B/W/R is the one GapKeep is developed with. The driver
(`src/runtime/epd.cpp`) comes from EPDPages' firmware (the same author's e-paper project),
where it is proven on these three modules; the 4.2" here has not
yet been tried on the device. Other panels of the SSD1680 family are a
table row; other controllers (a UC8176, a 384 × 640 B/W/R panel) a few
functions (below).

## Wiring

The Waveshare convention, which is also GapKeep's default: SPI0 with its
first chip select, and three more GPIOs. The WeAct modules' 8-pin header
(J2), its jumper (BS) on "4-line SPI":

| Module (J2) | Pi Zero header | GPIO |
| --- | --- | --- |
| 1 BUSY | pin 18 | GPIO 24 |
| 2 RES | pin 11 | GPIO 17 |
| 3 D/C | pin 22 | GPIO 25 |
| 4 CS | pin 24 | GPIO 8 (SPI0 CE0) |
| 5 SCL | pin 23 | GPIO 11 (SPI0 SCLK) |
| 6 SDA | pin 19 | GPIO 10 (SPI0 MOSI) |
| 7 GND | pin 20 (or 25, 9) | |
| 8 VCC | pin 17 (or 1): **3.3 V**, never 5 V | |

Pins 17 to 24 sit together on the header (pin 11 is a little apart), so a
2 × 4 or 2 × 5 connector on the Zero's side holds all but RES. None of these
are the test rig's (GND on pin 6, GPIO 14 and 15, the RUN pad, 5 V:
[RIG.md](RIG.md)).

**Plugging in and out while GapKeep runs** is the normal way of working
(one panel per share), on a live 3.3 V rail. GapKeep drives none of the
panel's lines between refreshes: SPI0's pins and DC, RST and BUSY are all
inputs then, so a panel half plugged in gets no current through its signal
pins into an unpowered controller. Still:

- Connect **GND first** and take it away last: a connector whose ground
  pin is longer than the others (or a separate ground wire, clipped on
  first), or plug in the ground row of a 2-row connector before the rest.
- **Series resistors** of 100 to 330 Ω in SCL, SDA, CS, D/C and RES, at the
  Zero's side, limit the current through a pin's protection diodes if a
  line touches before power does, and calm the edges on long wires. At
  4 MHz they don't matter to the signal. BUSY needs none.
- Plugging in a module charges its capacitors from the 3.3 V rail: a short
  dip, which a Zero with a good supply rides through. If it ever resets
  the Zero, add 10 to 47 µF across 3.3 V and GND at the connector, or power
  the panel through a switch (a P-MOSFET a GPIO turns on) so that it is
  only powered during a refresh: that is a later improvement.
- Never unplug a panel while it refreshes (the app says when it may be
  unplugged): a refresh cut short leaves the panel's pigments part way.

## gapkeep.txt

The card's `gapkeep.txt` (read at boot, [ARCHITECTURE.md](ARCHITECTURE.md))
says which panel is wired, and where; without `epaper` there is none.

```
epaper = weact-2.9-bwr     # the model, or none
epaper_cs = ce0            # SPI0's chip select: ce0 (GPIO 8) or ce1 (GPIO 7)
epaper_dc = 25             # GPIOs: 2 to 27, not 7 to 11 (SPI0) nor 14, 15 (serial)
epaper_rst = 17
epaper_busy = 24
epaper_spi_khz = 4000      # the SPI clock: 100 to 20000 kHz
```

The values shown are the defaults: only `epaper` is needed for the wiring
above. What is refused is logged (`gapkeep.txt:12: epaper_dc: a GPIO
number expected...`), and a panel whose DC, RST and BUSY aren't three
different GPIOs is dropped. The boot log says what was configured:
`epaper: WeAct 2.9" B/W/R (128x296, red) on SPI0 CE0 (GPIO 8), DC GPIO 25,
RST GPIO 17, BUSY GPIO 24, 4000 kHz`. Sealed kernels read no card: their
panel is built in (below).

### Sealed kernels

A sealed kernel (`SEALED=1`, [ARCHITECTURE.md](ARCHITECTURE.md)) reads no
card, so its panel is part of the build, with the same keys in capitals:

```sh
tools/build.sh pi SEALED=1 EPAPER=weact-2.9-bwr                     # Waveshare's pins
tools/build.sh pi SEALED=1 EPAPER=weact-2.9-bwr EPAPER_BUSY=23 EPAPER_CS=ce1
```

(`EPAPER_CS`, `EPAPER_DC`, `EPAPER_RST`, `EPAPER_BUSY`, `EPAPER_SPI_KHZ`.)
The build checks them with gapkeep.txt's rules (`tools/epaper_config.py`)
and stops on a bad one, saying why (`EPAPER: EPAPER_DC=9: a GPIO number
expected...`). They are compiled into the kernel, so the kernel's hash
covers them, as it covers built-in apps and data: two sealed kernels for
different wiring have different hashes. At boot the log says `epaper: the
panel is built in (EPAPER=weact-2.9-bwr)` and the configuration line
above. `EPAPER` is refused for other builds: they read `gapkeep.txt`.

Were a kernel to have both (the simulator can: `make -C sim
EPAPER=...`, `tests/epaper_builtin.txt`), the built-in panel wins and the
card's `epaper` keys are ignored, each with a warning in the log; a
sealed kernel has no card, so only its own configuration ever applies.

The keys have the device's name as their prefix so that more SPI devices
can come, each on its own chip select (a second panel, an SPI screen):
`epaper2`, `lcd`... with the same `_cs`, `_dc` keys.

## What a refresh does

`panel.refresh()` takes the picture the panel's widgets make, turns it
into the panel's planes (1 bit, and red), in the panel's own orientation,
and runs as a [long operation](API.md#long-operations): in slices of the
main loop, the screen and keyboard alive.

1. **A hardware reset, always** (RST low, then high): the panel may be
   another one than last time, and one in deep sleep hears nothing else.
   GapKeep never counts on a panel keeping any state.
2. Then BUSY must go low within a second. BUSY is pulled up at the Zero,
   so **without a panel it stays high**: the promise rejects with *"no
   panel answers: is one plugged in?"*. A soft reset (0x12), the same
   wait, then the controller's set-up (WeAct's sequence, from EPDPages):
   the gate lines, the RAM's addressing, the border, the temperature
   sensor on B/W panels.
3. Both planes, about 9.5 KB on the 2.9" (19 ms at 4 MHz).
4. **A full refresh with the panel's own waveform**, from its OTP memory:
   the maker's DC-balanced waveform, the one meant for a picture that
   must last. No partial refresh, no fast or custom waveform: the panel
   flashes, shows the picture, and on the B/W/R the red comes last (about
   18 s). BUSY must go high, and then low within 40 s (20 s for B/W);
   otherwise the refresh failed (*"the panel did not finish its refresh:
   was it unplugged?"*), and a BUSY that never goes high is no panel
   either.
5. **Deep sleep**, then the lines are let go. Only then does the promise
   resolve: the app can say "you can unplug the panel now".

Nothing is sent to a panel unless an app asked: opening a panel, or
drawing on it, sends nothing; boot sends nothing. When the app stops
during a refresh, the job is dropped (its planes wiped); the panel finishes
the waveform on its own, and the next refresh resets it anyway.

QEMU has no SPI controller: there, `ui.epaper.info()` is `null` and
`ui.epaper.open()` throws, whatever `gapkeep.txt` says (`src/spiprobe.cpp`
looks for SPI0 before anything uses it, since Circle's SPI driver would
wait for QEMU's forever).

What the panel shows is never logged, and the buffers that held it (the
off-screen display's, the planes) are wiped when freed.

## Keeping a panel

E-paper holds its picture with no power, as pigment particles that stay
where they were driven. But no maker promises that for decades, and the
pigments age: heat, light (UV), humidity and pressure speed it up, and a
red pigment is the one to watch first.
For a share kept on a panel:

- **Keep it dark, cool and dry**: in an envelope or a box, away from
  sunlight and heat (well under 30 °C; never a car or a window sill), in a
  bag with a desiccant where it is damp. Don't bend it, and don't press on
  the glass.
- **Check it once a year**, by looking at it: no power is needed. If it has
  faded or blurred where you can read the text and scan the QR code only
  with effort, write it again on a fresh panel, while you still can.
- **For decades, copy the share to metal** (stamped or engraved steel
  plates, as for seed words): the panel is the convenient copy, metal the
  lasting one.
- A panel that held a secret holds it still: store it as you would the
  share on paper, and wipe it (write a blank picture, a few times) before
  giving it away. Don't reuse a panel for another person's secret.

## Trying it without a panel: the simulator

The simulator has the panels, at the other end of its SPI and GPIO
stand-ins (`sim/include/circle/spimaster.h`, `gpiopin.h`): the same driver
sends its bytes to EPDPages' model of the SSD1680 (`sim/src/epd/`), which
keeps its RAM, plays the refresh and holds BUSY as the real controller
does, and ignores everything after deep sleep until a reset, so a driver
that forgot the reset shows up in the tests. The 2.9" B/W/R has its
pigments' physics too (`sim/src/epd/epbwr.c`, fitted to film of the real
panel): the flashing, the red coming up.

- `tools/gksim --epaper weact-2.9-bwr apps/myapp` configures the panel
  (over the card's `gapkeep.txt`), with panel "1" plugged in; `--epaper-ms
  1500` makes a refresh hold BUSY 1.5 s instead of the waveform's 18 s.
- Scenarios (`tools/qemu_harness.py --sim`): `epaper plug <name>
  [<model>]` plugs in a panel by name (a new one is white; one plugged in
  before still shows what it showed), `epaper unplug`, `epaper shot
  <name>` saves what the plugged-in panel shows as `<name>.png` (landscape,
  in the module's colours, with an 8-pixel white margin for QR readers),
  `epaper refresh-ms <ms>`. `tests/epaper.txt` writes two shares on two
  panels and checks the pictures (`tests/epaper/check_panel.py` decodes
  their QR codes with zbarimg).
- The browser IDE's **E-paper** bar: pick a model (the IDE's card then
  says so in `gapkeep.txt`), and the panel shows under the screen as its
  pigments look, the refresh as it happens; Unplug, Plug in and New panel
  as above.

## Adding a panel

A model of the SSD1680 family (another size, B/W or B/W/R): a row in
`Models[]` in `src/runtime/epd.cpp` (EPDPages' `panels[]` has the numbers:
size, the RAM X start, the landscape rotation), and in the simulator
`sim/src/epd/panels.c` and a `panel_model_t` in `panel_ssd1680.c`. Another
controller (the UC8176 of the Waveshare 4.2", a 384 × 640 B/W/R panel's): its
init sequence, RAM commands and BUSY polarity in `CGkEPD` (a family, as
`GkEPDSSD1683` is), and its model from EPDPages' `sim/panel_*.c`. Keep the
full refresh with the panel's OTP waveform, the reset before and deep
sleep after.

## Checking it on the device

The rig's Zero has no panel wired yet. When it has, the rig's camera,
pointed at the panel, can check a written share the way
`tests/epaper/check_panel.py` checks the simulator's pictures: decode its
QR code from a photo.
