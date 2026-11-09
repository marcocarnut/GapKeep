# The clock

A Pi Zero has no battery-backed clock, and GapKeep has no network to ask
for the time. So the kernel keeps a clock in software, from the system
timer, and someone sets it after each boot: the **Clock** app
(`apps/clock`). Until then it counts from 1970-01-01 at boot.

The clock runs whatever app is open. Every app can read it (`Date.now()`,
`new Date()`, `gk:clock`); only apps with `"permissions": ["rtc"]` can set
it: in practice only the Clock app.

## Setting it

In the Clock app:

1. **UTC offset**, e.g. `-03:00`, Enter. Local time is UTC plus this
   offset; there are no time zone rules, so daylight saving time is a new
   offset, set by hand.
2. **Local time**: type a time a little ahead of a reference clock (a
   phone, a watch), `YYYY-MM-DD HH:MM:SS`, and press Enter when the
   reference shows it. Done carefully, that is right to a few tenths of a
   second.

## Drift and the trim

The system timer runs from the Pi's crystal, which is off by some parts per
million (ppm): typically tens, so a few seconds a day. The **trim** corrects
it: a trim of -21.4 ppm slows the clock by 21.4 µs per second.

To measure it, set the clock, and set it again days later. The second
time, the Clock app shows how far off the clock was, and the trim that
would have kept it right, with its uncertainty. Setting the clock by hand
is right to about half a second, so the measurement is as good as the time
between the two settings is long:

| Between settings | Trim measured to |
| --- | --- |
| 1 hour (the least it measures) | ±278 ppm: not useful |
| 1 day | ±12 ppm (about 1 s a day) |
| 1 week | ±1.7 ppm (about 1 s a week) |

**Apply measured trim** uses it. Measure over a day first, apply it, then
again over a week. The crystal's error also changes a little with
temperature, so a few ppm is about as good as it gets.

## gapkeep.txt: keeping the trim and offset

GapKeep never writes to the SD card, so the clock's settings can't be saved
by the device. Instead, put them in a text file at the top of the card,
`gapkeep.txt`, from another computer; the Clock app shows the lines to
copy:

```
# GapKeep's settings
clock_trim_ppm = -21.4
utc_offset = -03:00
```

GapKeep reads it at boot (the log shows each setting, and a warning for
anything it doesn't understand). The same file can turn on experimental
features: [EXPERIMENTAL.md](EXPERIMENTAL.md), and set the language and the
way numbers are written: [APPS.md](APPS.md#languages). The time itself can't be kept this way:
set it after each boot. Sealed builds have no SD card code and don't read
it.

GapKeep was called ZeroGap, and the file `zerogap.txt`. On a card made
before the rename, rename `zerogap.txt` to `gapkeep.txt`: the old name is
not read.

## For apps

```js
import * as clock from "gk:clock";

if (!clock.status().set) {
  // tell the person to set the clock in the Clock app
}
clock.every(30, ({ time, changed }) => redraw(time));   // at :00 and :30, and when it is set
```

- `Date.now()`, `new Date()`: UTC from this clock; `getHours()` and the
  other local-time methods use its UTC offset.
- `every(seconds, fn)` calls `fn` on the clock's marks (UTC multiples of the
  period) and at once when the clock is set or its trim or offset change,
  so codes that depend on the time (TOTP) are redrawn right away.
- The details: [API.md](API.md#gkclock).

## How it works

`src/runtime/clock.cpp` keeps a base time and the timer's count at that
moment; the time is the base plus the timer's count since, times
(1 + trim). A new trim first makes the current time the base, so the time
never jumps. Each setting after the first compares the time typed with the
timer's (untrimmed) count since the previous setting: their ratio is the
crystal's error.

In the simulator and the IDE, the same clock runs on the host's monotonic
timer: `Date` there also counts from 1970 until the Clock app sets it.
