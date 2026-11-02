# zerogap JavaScript API reference

Apps are ES modules running on QuickJS. They reach the system through the
modules below, imported by name:

| Module | Available to | Purpose |
| --- | --- | --- |
| [`zg:ui`](#zgui) | every app | Widgets, layout, input, alerts |
| [`zg:sys`](#zgsys) | every app | App info, versions, uptime, memory, exit |
| [`zg:crypto`](#zgcrypto) | every app | SHA-256, hardware random bytes |
| [`zg:apps`](#zgapps) | apps with the `"apps"` permission | List and launch apps (the launcher) |

Plus the [globals](#globals) `console`, `setTimeout`, `setInterval`,
`clearTimeout` and `clearInterval`, and the standard JavaScript library
(ES2023).

An app's own modules are imported with relative paths (`"./lib/x.js"`).
Paths are resolved inside the app's directory; `..` cannot leave it.

---

## zg:ui

```js
import * as ui from "zg:ui";
```

### Exports

| Name | Type | Description |
| --- | --- | --- |
| `Widget` | class | Base class of all widgets. Not constructible; use for `instanceof`. |
| `Container`, `Panel`, `Label`, `Button`, `TextArea`, `Checkbox`, `Switch`, `Dropdown`, `Slider`, `Bar`, `Table`, `QRCode`, `TabView` | classes | [Widgets](#widgets) |
| `screen` | Container | The app's root widget. A column with 16 px padding and 12 px gap. |
| `width`, `height` | number | Display size in pixels. |
| `fonts` | number[] | Available font sizes: 12, 14, 16, 18, 20, 22, 24, 28, 32, 40. |
| `symbols` | object | Icon glyphs usable in any text, e.g. `ui.symbols.ok`. [List](#symbols). |
| `alert(message, options?)` | function | Modal message. [Details](#uialert). |
| `onKey(handler)` | function | App-wide key handler. [Details](#uionkey). |
| `theme(options)` | function | Change colors. [Details](#uitheme). |

### Creating widgets

```js
new ui.Label(props?)            // child of ui.screen
new ui.Label(parent, props?)    // child of another widget
```

`props` is an object of [properties](#common-properties) and
[event handlers](#events). Unknown property names and invalid values throw a
`TypeError` naming the problem, both here and in `set()`, so typos don't
fail silently.

Widgets can be subclassed:

```js
class Title extends ui.Label {
  constructor(parent, text) {
    super(parent, { text, font: 28 });
  }
}
```

### Widget methods and properties (all widgets)

| Member | Description |
| --- | --- |
| `set(props)` | Apply several properties. Returns the widget (chainable). |
| `on(event, fn)` | Set the handler for an event (replaces any previous one). Chainable. |
| `off(event)` | Remove the handler. Chainable. |
| `focus()` | Give keyboard focus to the widget (if it is focusable). |
| `delete()` | Remove the widget and its children. Safe inside the widget's own handlers. Calling it twice is harmless. |
| `clear()` | Delete all children. Chainable. |
| `scrollIntoView()` | Scroll the parents so the widget is visible. |
| `parent` | Parent widget (read-only), `null` for the screen. |
| `children` | Array of child widgets (read-only, a new array each time). |
| `alive` | `false` once deleted (read-only). Any other use of a deleted widget throws. |
| `type` | `"Label"`, `"Button"`, ... (read-only). |

Every property in the tables below is also a JavaScript property:
`label.text = "hi"` is the same as `label.set({ text: "hi" })`. Properties
marked *readable* return their current value; the others are write-only.

### Common properties

Accepted by every widget.

**Geometry and layout**

| Property | Value | Notes |
| --- | --- | --- |
| `x`, `y` | size | Position. Relative to the `align` point if set. |
| `width`, `height` | size | *Readable* (returns pixels). |
| `minWidth`, `maxWidth`, `minHeight`, `maxHeight` | size | |
| `grow` | number | Flex grow factor inside a row/column parent. |
| `align` | `"default"`, `"center"`, `"top-left"`, `"top-mid"`, `"top-right"`, `"bottom-left"`, `"bottom-mid"`, `"bottom-right"`, `"left-mid"`, `"right-mid"` | Position within the parent. Ignored when the parent has a layout. |
| `layout` | `"none"`, `"row"`, `"column"`, `"row-wrap"`, `"column-wrap"` | How children are arranged. |
| `justify` | `"start"`, `"center"`, `"end"`, `"space-between"`, `"space-around"`, `"space-evenly"` | Main-axis placement of children. |
| `alignItems` | `"start"`, `"center"`, `"end"` | Cross-axis placement of children. |
| `gap` | number | Space between children, px. |
| `padding` | number, `[v, h]` or `[top, right, bottom, left]` | Inner spacing, px. |

A **size** is a number of pixels, a percentage of the parent as a string
(`"50%"`), or `"content"` (fit the children).

**Appearance**

| Property | Value | Notes |
| --- | --- | --- |
| `bg` | color | Background color (makes the background opaque). |
| `color` | color | Text color. |
| `font` | number | Font size, one of `ui.fonts`. |
| `textAlign` | `"left"`, `"center"`, `"right"` | |
| `radius` | number | Corner radius, px. |
| `borderWidth` | number | px. |
| `borderColor` | color | |
| `opacity` | number 0..1 | Whole widget, including children. |

A **color** is `0xRRGGBB`, `"#RRGGBB"` or `"#RGB"`.

**State**

| Property | Value | Notes |
| --- | --- | --- |
| `hidden` | boolean | *Readable*. Hidden widgets take no space in layouts. |
| `disabled` | boolean | *Readable*. Grayed out, ignores input. |
| `scrollable` | boolean | Whether content overflowing the widget can be scrolled. |
| `clickable` | boolean | Whether the widget receives clicks. |

### Events

| Event | Handler property | Fired when |
| --- | --- | --- |
| `"click"` | `onClick` | Clicked, or Enter/Space while focused. |
| `"change"` | `onChange` | The value changed (by the person or by code). |
| `"submit"` | `onSubmit` | Enter in a one-line TextArea. |
| `"focus"` | `onFocus` | Received keyboard focus. |
| `"blur"` | `onBlur` | Lost keyboard focus. |
| `"longpress"` | `onLongPress` | Pressed and held. |
| `"key"` | `onKey` | A key reached the focused widget (after `ui.onKey`). |

Handlers receive one event object and are called with `this` set to the
widget:

| Field | Description |
| --- | --- |
| `type` | Event name. |
| `target` | The widget. |
| `value` | For value-carrying widgets: TextArea text, Checkbox/Switch `checked`, Slider/Bar `value`, Dropdown `selected`, TabView `active`. |
| `key` | `"key"` events only: key name (see [key names](#key-names)). |

### Widgets

#### Container

An invisible box for layout: no background, border or padding, sized to its
content by default. Children's focus rings may draw outside it.

#### Panel

A box with the theme's "card" look: background, border, rounded corners,
padding, scrollbars when content overflows.

#### Label

| Property | Value | Notes |
| --- | --- | --- |
| `text` | string | *Readable*. May contain `\n` and `ui.symbols`. |
| `overflow` | `"wrap"`, `"clip"`, `"dots"`, `"scroll"`, `"scroll-circular"` | What happens when text is wider than the label (set a `width` for this to matter). |

#### Button

| Property | Value | Notes |
| --- | --- | --- |
| `text` | string | *Readable*. Creates a centered label inside the button. |

Buttons can also contain arbitrary children (give them a `layout`).

#### TextArea

| Property | Value | Notes |
| --- | --- | --- |
| `text` | string | *Readable*. |
| `placeholder` | string | Shown while empty. |
| `oneLine` | boolean | Single line; Enter fires `submit`. |
| `password` | boolean | Show bullets instead of characters. |
| `maxLength` | number | 0 = unlimited. |
| `accept` | string or `null` | Only these characters can be typed. |

#### Checkbox

| Property | Value | Notes |
| --- | --- | --- |
| `text` | string | *Readable*. Label next to the box. |
| `checked` | boolean | *Readable*. |

#### Switch

| Property | Value | Notes |
| --- | --- | --- |
| `checked` | boolean | *Readable*. |

#### Dropdown

| Property | Value | Notes |
| --- | --- | --- |
| `options` | string[] | |
| `selected` | number | *Readable*. Index of the selected option. |

#### Slider, Bar

| Property | Value | Notes |
| --- | --- | --- |
| `min`, `max` | number | *Readable*. Integer range (default 0..100). |
| `value` | number | *Readable*. Clamped to the range. |

A Slider can be changed by the person (arrow keys when focused); a Bar only
displays a value.

#### Table

| Property / method | Value | Notes |
| --- | --- | --- |
| `data` | string[][] | Replaces all cells; rows may have different lengths. |
| `rows`, `cols` | number | *Readable*. |
| `setCell(row, col, text)` | | Grows the table if needed. |
| `getCell(row, col)` | → string | `undefined` outside the table. |
| `setColumnWidth(col, px)` | | |

#### QRCode

| Property | Value | Notes |
| --- | --- | --- |
| `data` | string or `Uint8Array` | Encoded content. Text uses the most compact single mode (numeric for digits only, alphanumeric for `0-9 A-Z $%*+-./:` and space, otherwise byte mode with UTF-8); a `Uint8Array` is encoded as raw bytes. Throws `RangeError` if it doesn't fit. |
| `ecc` | `"L"`, `"M"`, `"Q"`, `"H"` | Error correction level (default `"M"`). Never raised automatically, so the symbol is exactly what was asked for. |
| `size` | number | Side length in px (default 160), including a 4-module quiet zone. Modules are drawn at an integer scale. |
| `dark`, `light` | color | Module colors (default black on white). |
| `modules` | number | *Read-only*. Modules per side of the current symbol (21 for version 1, +4 per version), 0 when empty. |

A rejected value (data too long, size too small) throws and leaves the code
unchanged. For example, a 24-word SeedQR (96 digits at `ecc: "L"`) is 29×29,
a Compact SeedQR (32 bytes at `"L"`) is 25×25.

#### TabView

| Property / method | Value | Notes |
| --- | --- | --- |
| `addTab(title)` | → Container | Adds a tab and returns its page. Put the tab's widgets in the page. |
| `active` | number | *Readable*. Index of the shown tab. |

### ui.alert

```js
const index = await ui.alert(message, { title, buttons });
```

Shows a modal dialog over the app. `buttons` is an array of labels (default
`["OK"]`). Resolves with the index of the button pressed, or -1 if the
person pressed Escape. While an alert is open, Tab moves only between its
buttons and `ui.onKey` handlers are not called. Alerts can be nested.

### ui.onKey

```js
ui.onKey((ev) => { ... return true; });   // or ui.onKey(null) to remove
```

Called for every key press before it reaches the focused widget. Return
`true` to consume the key. The event has:

| Field | Description |
| --- | --- |
| `key` | Key name (see below). |
| `shift`, `ctrl`, `alt` | Modifier state (booleans). |

With Ctrl or Alt held, keys are delivered to the handler only, not typed.

#### Key names

Printable characters are themselves (`"a"`, `"A"`, `"7"`, `" "`). Others:
`"Enter"`, `"Escape"`, `"Backspace"`, `"Delete"`, `"Tab"` (check `shift`
for Shift+Tab), `"ArrowUp"`, `"ArrowDown"`, `"ArrowLeft"`, `"ArrowRight"`,
`"Home"`, `"End"`, `"PageUp"`, `"PageDown"`, `"Insert"`, `"F1"`...`"F9"`.

The Windows/Super key is reserved: it always returns to the launcher.

### ui.theme

```js
ui.theme({ dark: true, primary: "#009688", secondary: "#ffc107" });
```

Changes the theme for widgets created afterwards; call it before building
the screen. The secondary color is also the focus ring. The system theme is
restored when the app exits.

### Symbols

Icon glyphs from the built-in font, usable inside any text:
`audio`, `video`, `list`, `ok`, `close`, `power`, `settings`, `home`,
`download`, `drive`, `refresh`, `mute`, `volume-mid`, `volume-max`, `image`,
`tint`, `prev`, `play`, `pause`, `stop`, `next`, `eject`, `left`, `right`,
`plus`, `minus`, `eye-open`, `eye-close`, `warning`, `shuffle`, `up`,
`down`, `loop`, `directory`, `upload`, `call`, `cut`, `copy`, `save`,
`bars`, `envelope`, `charge`, `paste`, `bell`, `keyboard`, `gps`, `file`,
`wifi`, `battery-full`, `battery-3`, `battery-2`, `battery-1`,
`battery-empty`, `usb`, `bluetooth`, `trash`, `edit`, `backspace`,
`sd-card`, `new-line`.

Names with dashes need bracket syntax: `ui.symbols["eye-open"]`. The same
names are valid for `icon` in `manifest.json`.

---

## zg:sys

```js
import * as sys from "zg:sys";
```

| Name | Description |
| --- | --- |
| `app` | This app's manifest data: `{ id, name, version, description, icon, permissions }`. |
| `version` | `{ zerogap, quickjs, lvgl, circle }` version strings. |
| `log(...args)` | Same as `console.log`. |
| `uptime()` | Milliseconds since boot (a float). |
| `memory()` | `{ used, limit, objects }`: this app's JS heap in bytes and its object count. |
| `gc()` | Run the garbage collector now. |
| `exit()` | Leave the app and return to the launcher (after the current handler returns). |

---

## zg:crypto

```js
import * as crypto from "zg:crypto";
```

| Name | Description |
| --- | --- |
| `sha256(data)` | SHA-256 of a typed array (its bytes), an `ArrayBuffer`, or a string (as UTF-8). Returns a `Uint8Array(32)`. Synchronous. |
| `randomBytes(n)` | `Uint8Array(n)` of random bytes, `n` ≤ 65536. |
| `getRandomValues(array)` | Fills a typed array in place and returns it, like WebCrypto's. ≤ 65536 bytes. |
| `rngStatus()` | `{ healthy, failure, rawBytes }`. |

**Where the randomness comes from.** The BCM2835's hardware random number
generator, treated as a noise source of unknown quality. Every raw byte
passes NIST SP 800-90B's continuous health tests (Repetition Count and
Adaptive Proportion, tuned for an assumed 1 bit of entropy per byte), 4096
bytes are tested at boot, and each 32 output bytes are SHA-256 of 256 raw
bytes. If a test ever fails, the generator shuts off until reboot:
`randomBytes` and `getRandomValues` then throw an `InternalError`, and never
return weak bytes.

The hardware RNG is undocumented. Apps handling secrets should treat it as a
supplement to entropy the person provides (dice, coins), not a replacement.

To run code written for WebCrypto unchanged, give it a small adapter:

```js
globalThis.crypto = {
  getRandomValues: zgcrypto.getRandomValues,
  subtle: { digest: async (alg, data) => zgcrypto.sha256(data).buffer },
};
```

---

## zg:apps

Requires `"permissions": ["apps"]` in the manifest; importing it otherwise
throws a `ReferenceError`. Used by the launcher.

| Name | Description |
| --- | --- |
| `list()` | Array of `{ id, name, version, description, icon, permissions }` for every app not marked `hidden`, sorted by id. |
| `launch(id)` | Stop the current app and start `id` (after the current handler returns). Throws if there is no such app. |

---

## Globals

| Name | Description |
| --- | --- |
| `console.log`, `info`, `warn`, `error`, `debug` | Write to the serial log as `app:<id>`. Strings are printed as-is, errors with their stack, other objects as JSON. |
| `setTimeout(fn, ms)`, `setInterval(fn, ms)` | Return a numeric id. Extra arguments are not passed on; use a closure. Interval minimum 1 ms. |
| `clearTimeout(id)`, `clearInterval(id)` | Unknown ids are ignored. |

Not available: `fetch`, `XMLHttpRequest`, `WebSocket`, `localStorage`,
`require`, `process`, the DOM, and the global `crypto` object (use
[`zg:crypto`](#zgcrypto)).

---

## Limits

| Limit | Value |
| --- | --- |
| JS heap per app | 96 MB |
| JS stack | 512 KB |
| One handler, timer or job | 10 s, then interrupted (the app keeps running) |
| Display | Whatever the HDMI output negotiates (640×480 in QEMU) |
