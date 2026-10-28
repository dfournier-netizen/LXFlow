# Firmware tests (run on a PC)

These check the OSC code without an ESP32. They are not part of `npm test`.

```
cd firmware/test
pip install python-osc
python3 gen_packets.py packets.txt          # packets shaped like Companion, grandMA3 and QLab send
g++ -std=c++17 -o osc_core_test osc_core_test.cpp && ./osc_core_test
g++ -std=c++17 -w -I <Arduino libraries>/ArduinoJson/src -o osc_logic_test osc_logic_test.cpp && ./osc_logic_test
```

`osc_core_test` covers the OSC parser, wildcard matching and message building.
`osc_logic_test` runs `osc.ino` itself through a small Arduino shim (`shim.h`): built-in
addresses, custom triggers, the button, OSC ack-out, modes, storage limits and looks from LXFlow.
