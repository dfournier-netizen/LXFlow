# LXFlow Cue Light — firmware 1.0.1

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

| Light | Meaning |
|---|---|
| Red, flashing | Standby, not yet acked (flash style) |
| Red, steady | Standby (acked, or steady style) |
| Green | GO, off after 3 s |
| One dim white LED | Connected, nothing pending |
| White spinning | Identify (from LXFlow Settings) |
| Blue breathing | On Wi-Fi but lost LXFlow, so any cue on it is stale and has been cleared |
| Purple breathing | No Wi-Fi |
| Cyan | Setup portal open |

**Button:** short press acks a standby: it stops this light flashing and marks the operators at its position as acknowledged in LXFlow (in either standby style). Hold 5 s for setup.

## Host laptop

Windows Firewall must allow Node/LXFlow on the Wi-Fi network: TCP 7390 (the app) and UDP 7391 (auto-find).
If auto-find doesn't work at a venue, enter the host IP in the light's setup page.
