# LXFlow Cue Light — firmware 1.2.0

One ESP32 + LED ring + button per light. Each light joins the show Wi-Fi, finds LXFlow, and shows
standby / GO for the position the host assigns it to in LXFlow Settings.

## Bill of materials (per light, about $21 from Adafruit / Grid Connect, prices 2026-10-22)

| Qty | Part | Example source | Unit |
|---|---|---|---|
| 1 | ESP32-DevKitC-32E (any ESP32-WROOM-32 "ESP32 Dev Module" board works) | [Grid Connect](https://gridconnect.com/products/esp32-devkitc-32e-wroom-module-development-kit) | $9.95 |
| 1 | NeoPixel Ring, 12 × WS2812 5050 RGB, 36.8 mm | [Adafruit #1643](https://www.adafruit.com/products/1643) | $8.95 |
| 1 | 16 mm panel-mount momentary pushbutton (ack) | [Adafruit #1502](https://adafruit.com/product/1502) | $0.95 |
| 1 | 330 Ω ¼ W resistor (ring data line) | any | ~$0.10 |
| 1 | 470–1000 µF 10 V electrolytic across ring 5V/GND (optional, protects the ring at power-up) | any | ~$0.30 |
| 1 | USB cable (micro-USB or USB-C to match the board) + 5 V USB supply | on hand | — |
| — | Hookup wire, 3D-printed housing with a diffuser over the ring | on hand | — |

Generic ESP32 boards and WS2812 rings from Amazon/AliExpress bring it to roughly $8–12 a light.
Prices are list price for one; Adafruit discounts at 10+. The CP2102 or CH340 USB chip on
the board may need its Windows driver before the COM port appears.

## Wiring

```
ESP32 GPIO 16 ──[330 Ω]── ring DIN
ESP32 VIN (5 V) ───────── ring 5V / VCC
ESP32 GND ─────────────── ring GND
ESP32 GPIO 27 ──── button ──── GND
```

The on-board BOOT button also works as the ack button, so you can bench-test with nothing wired except the ring.

## Flashing (once per board, from Chrome or Edge)

1. Plug the ESP32 into USB.
2. Open https://espressif.github.io/esptool-js/
3. Baud rate 921600, click **Connect**, pick the board's COM port.
4. Flash address `0x0`, file `LXFlowCueLight.merged.bin`, click **Program**.
   (The .bin is not kept in git; use the firmware zip, or build it as below and use
   `build/esp32.esp32.esp32/LXFlowCueLight.ino.merged.bin`.)
5. When it finishes, press the board's EN/RST button.

Building from source: `arduino-cli compile --fqbn esp32:esp32:esp32:PartitionScheme=min_spiffs --export-binaries firmware/LXFlowCueLight`, or Arduino IDE, board "ESP32 Dev Module" (esp32 by Espressif 3.x),
Partition Scheme "Minimal SPIFFS", libraries WiFiManager 2.0.17, WebSockets 2.7.x, Adafruit NeoPixel 1.15.x, ArduinoJson 7.x.

## First setup (and whenever you change venue)

1. Power the light. If it can't find a known network it turns **cyan** and opens its own Wi-Fi.
2. On a phone, join **LXFlow-CueLight-XXXX**. The setup page should pop up; if not, browse to `192.168.4.1`.
3. **Configure WiFi**: pick the network LXFlow's host laptop is on (2.4 GHz only).
4. Leave **LXFlow host IP** blank to find LXFlow automatically, or enter the host's Wi-Fi IP if auto-find is blocked.
5. Enter the room code if LXFlow uses one. Save.

The light restarts, connects, and appears in LXFlow → Settings → Cue Lights, where the host names it and assigns a position.
To change settings later, **hold the button 5 seconds**.

## What the light shows

Firmware 1.1 shows whatever look LXFlow sends. These are the built-in looks; change any of
them in LXFlow Settings → Cue lights → Looks, globally or for one position.

| Condition | Built-in look | When |
|---|---|---|
| STOP | Red strobe | Caller or host presses **STOP**; every light; until released |
| GO | Green solid | Caller's GO onto a cue sent to this position; 3 s |
| Countdown | Orange, ring drains | To the cue's Time, N seconds from standby, or started by hand |
| Standby | Red flash | Standby waiting for ack (flash style) |
| Call | White spin | Anyone calls this position; until the light's button or the screen ACK answers it |
| Hold | Amber solid | Caller or host holds this position; until released |
| Standby (acked) | Red solid | Acked, or steady style |
| Missed ack | Dim red double blink | GO came before the ack; 10 s |
| Warning | Amber pulse | N cues before the standby (set per cue) |
| Places | Blue pulse | Caller or host presses **Places**; every light; until released |
| Idle | One dim white LED | Connected, nothing pending |

Shown by the light itself, even with LXFlow down:

| Light | Meaning |
|---|---|
| Blue breathing (default) | On Wi-Fi but lost LXFlow; any cue on it has been cleared |
| Purple breathing (default) | No Wi-Fi |
| White spinning | Identify (from LXFlow Settings) |
| Cyan | Setup portal open |

**Button:** short press = ack. It answers a standby first (stops the flash and marks the
operators at this position acknowledged), otherwise a Call to this position. Hold 5 s for setup.

## OSC (firmware 1.2)

The light can also be driven by OSC from Companion, grandMA3, QLab or anything else, with or
without LXFlow. Everything is set on the **light's own page**: open `http://<light IP>/` or
`http://lxflow-cuelight-xxxx.local/` from any computer on the same network. LXFlow's
Settings → Cue lights links to it.

**Mode** (on the light's page; changing it restarts the light):

| Mode | What it does |
|---|---|
| LXFlow and OSC (default) | Both work. An OSC look wins while it's active, then LXFlow shows again. |
| LXFlow only | OSC is ignored. |
| OSC only | The light never looks for LXFlow, so no blue lost-link breathing. It idles on one dim LED. |

**Listening:** UDP port 8000 by default. Send to the light's IP, or broadcast to the network
so one message reaches every light.

**Built-in addresses.** `<name>` is the light's OSC name (set on its page), its 4-character
ID, or `all`. Looks match LXFlow's once the light has been connected to LXFlow.

| Address | Does |
|---|---|
| `/cuelight/<name>/standby` | Flashes until the button acks it, then steady |
| `/cuelight/<name>/go [seconds]` | GO, 3 s by default |
| `/cuelight/<name>/hold`, `/places`, `/stop`, `/warning`, `/acked` | Stays on; an argument of `0` turns it off |
| `/cuelight/<name>/call` | Spins until the button answers it |
| `/cuelight/<name>/countdown <seconds>` | The ring drains over that time |
| `/cuelight/<name>/look r g b [pattern] [speed ms] [level %] [seconds]` | Any look |
| `/cuelight/<name>/off` | Clears the OSC look |
| `/cuelight/<name>/ident [seconds]` | Spins white |

**Custom triggers** (the light's page): an OSC address (`*` and `?` wildcards), an optional
first-argument value to match (`1` also matches `1.0` and True), a colour, pattern, speed and
level, a duration (0 = until replaced or cleared), and whether the button clears it. The
pattern **Clear** ends any OSC look. Triggers are checked first, top to bottom, and the first
match wins. **Recent OSC received** lists the last 12 messages; **Make trigger** turns one into
a row. **Test** shows a row's look without saving.

**Button sends OSC:** the button sends one message to an IP and port you set. `{name}` in
the address is replaced by the light's OSC name. A whole-number argument is sent as an int,
a decimal as a float, anything else as text. Examples: Companion `/location/1/0/1/press`,
grandMA3 `/cmd` with `Go+ Sequence 5`, QLab `/cue/5/go`. In LXFlow-and-OSC mode the button
also acks in LXFlow.

The light's page has no password; anyone on the same network can change it. Keep lights on
a closed show network.

## Host laptop

Windows Firewall must allow Node/LXFlow on the Wi-Fi network: TCP 7390 (the app) and UDP 7391 (auto-find).
If auto-find doesn't work at a venue, enter the host IP in the light's setup page.
