# Firmware tests (run on a PC)

These check the OSC and Art-Net code without an ESP32. They are not part of `npm test`.

```
cd firmware/test
pip install python-osc
python3 gen_packets.py packets.txt          # packets shaped like Companion, grandMA3 and QLab send
pip install stupidArtnet
python3 gen_artnet.py artnet_packets.txt    # ArtDmx packets built by a third-party sender
g++ -std=c++17 -o osc_core_test osc_core_test.cpp && ./osc_core_test
g++ -std=c++17 -o output_test output_test.cpp && ./output_test        # gamma, brightness, dithering
g++ -std=c++17 -w -I <Arduino libraries>/ArduinoJson/src -o osc_logic_test osc_logic_test.cpp && ./osc_logic_test
```

`osc_core_test` covers the OSC parser, wildcard matching and message building.
`osc_logic_test` runs `osc.ino` itself through a small Arduino shim (`shim.h`): built-in
addresses, custom triggers, the button, OSC ack-out, modes, storage limits, looks from LXFlow,
and (1.4) pixel count, colour order, Art-Net universe/address mapping, hold, late packets and
the ArtPollReply.
