/*
  Art-Net pixel control (firmware 1.4).

  In Art-Net mode (set on the light's web page) the light ignores LXFlow and OSC looks and
  follows ArtDmx on UDP 6454 instead:
    universe       0-32767 (the 15-bit Port-Address: Net << 8 | Sub-Net << 4 | Universe)
    start address  1-512; LED 1 = R, G, B at start..start+2, LED 2 = the next three, ...
                   (3 channels per LED: 36 for a 12-LED ring, 510 for 170 pixels of tape)
  Levels go through the output stage like every look (output.ino): gamma, optional
  dithering, then the light's brightness setting (Wi-Fi setup page).
  If ArtDmx stops, the last frame holds for the set seconds (1-60), then the light idles on
  one dim LED until data returns. Channels past the end of a short packet read as 0.
  Out-of-order packets (by the Sequence field) are dropped. Several senders are not merged:
  the last packet wins.
  The light answers ArtPoll with an ArtPollReply (unicast to the poller) so consoles and
  Art-Net tools can find it.
  The ack button still sends its OSC message, if one is set.
*/

#define ARTNET_PORT 6454

WiFiUDP artUdp;
bool artUp = false;
uint16_t artUni = 0, artAddr = 1;   // set on the web page (osc.ino stores them)
uint8_t artHold = 3;                // seconds to hold the last frame
uint8_t artPix[MAX_LEDS * 3];
bool artHave = false;
uint32_t artLastAt = 0, artPkts = 0, artPolls = 0;
uint8_t artSeq = 0;
IPAddress artFrom;
static const uint8_t ART_ID[8] = { 'A', 'r', 't', '-', 'N', 'e', 't', 0 };

void artPollReply(IPAddress to) {
  uint8_t p[239];
  memset(p, 0, sizeof p);
  memcpy(p, ART_ID, 8);
  p[8] = 0x00; p[9] = 0x21;                              // OpPollReply 0x2100, low byte first
  IPAddress ip = WiFi.localIP();
  for (uint8_t k = 0; k < 4; k++) { p[10 + k] = ip[k]; p[207 + k] = ip[k]; }   // IP, BindIp
  p[14] = 0x36; p[15] = 0x19;                            // port 6454, low byte first
  p[16] = 1; p[17] = 4;                                  // VersInfo = firmware 1.4
  p[18] = (artUni >> 8) & 0x7F;                          // NetSwitch
  p[19] = (artUni >> 4) & 0x0F;                          // SubSwitch
  p[20] = 0x00; p[21] = 0xFF;                            // OEM: unregistered
  p[23] = 0xD0;                                          // Status1: indicators normal, set locally
  snprintf((char *)p + 26, 18, "LXFlow CL %s", shortId());                         // ShortName
  snprintf((char *)p + 44, 64, "LXFlow Cue Light %s%s%s", shortId(), oscName[0] ? " " : "", oscName);   // LongName
  snprintf((char *)p + 108, 64, "#0001 [%04lu] %s", (unsigned long)(artPolls % 10000), artHave ? "Receiving" : "Ready");   // NodeReport
  p[173] = 1;                                            // NumPorts
  p[174] = 0x80;                                         // PortTypes[0]: output from Art-Net, DMX512
  p[182] = artHave ? 0x80 : 0x00;                        // GoodOutputA[0]: data being output
  p[190] = artUni & 0x0F;                                // SwOut[0]
  p[200] = 0x00;                                         // Style: StNode
  WiFi.macAddress(p + 201);                              // MAC
  p[211] = 1;                                            // BindIndex
  p[212] = 0x0F;                                         // Status2: web config, DHCP, DHCP-capable, 15-bit address
  artUdp.beginPacket(to, ARTNET_PORT);
  artUdp.write(p, sizeof p);
  artUdp.endPacket();
}

void artHandle(const uint8_t *b, int n, IPAddress from) {
  if (n < 12 || memcmp(b, ART_ID, 8)) return;
  uint16_t op = b[8] | (b[9] << 8);
  if (op == 0x2000) { artPolls++; artPollReply(from); return; }   // ArtPoll
  if (op != 0x5000 || n < 18) return;                              // only ArtDmx from here
  uint16_t uni = ((b[15] & 0x7F) << 8) | b[14];
  if (uni != artUni) return;
  uint8_t seq = b[12];
  uint32_t now = millis();
  if (seq && artSeq && artHave && now - artLastAt < 1000 && (int8_t)(seq - artSeq) < 0) return;   // late packet
  int len = (b[16] << 8) | b[17];
  if (len > 512) len = 512;
  if (18 + len > n) len = n - 18;
  for (uint16_t i = 0; i < ledCount * 3; i++) {
    int ch = artAddr - 1 + i;
    artPix[i] = ch < len ? b[18 + ch] : 0;
  }
  artSeq = seq; artLastAt = now; artHave = true; artPkts++; artFrom = from;
}

void artSetup() {
  if (lightMode != M_ARTNET) return;
  artUp = artUdp.begin(ARTNET_PORT);
  Serial.printf("Art-Net on UDP %u, universe %u, address %u: %s\n", ARTNET_PORT, artUni, artAddr, artUp ? "ok" : "failed");
}

void artLoop() {
  if (!artUp) return;
  static uint8_t buf[600];                               // ArtDmx is at most 530 bytes
  for (int guard = 0; guard < 16; guard++) {             // drain a burst, keep the newest
    int n = artUdp.parsePacket();
    if (n <= 0) return;
    if (n > (int)sizeof buf) { artUdp.clear(); continue; }
    IPAddress from = artUdp.remoteIP();
    int got = artUdp.read(buf, n);
    artHandle(buf, got, from);
  }
}

bool artPaint(uint32_t now) {                            // called from render()
  if (!artHave) return false;
  if (now - artLastAt > artHold * 1000UL) { artHave = false; return false; }
  ring.clear();
  for (uint16_t i = 0; i < ledCount; i++) ring.setPixelColor(i, ring.Color(artPix[i * 3], artPix[i * 3 + 1], artPix[i * 3 + 2]));
  return true;
}

const char *artShowing() {
  if (!artHave) return "idle (no Art-Net)";
  return millis() - artLastAt > 1000 ? "Art-Net (holding last frame)" : "Art-Net";
}

void artState(JsonDocument &d) {                         // for /api/state
  JsonObject a = d["art"].to<JsonObject>();
  a["uni"] = artUni; a["addr"] = artAddr; a["hold"] = artHold; a["leds"] = ledCount;
  a["up"] = artUp; a["pkts"] = artPkts; a["polls"] = artPolls;
  a["live"] = artHave ? (millis() - artLastAt > 1000 ? "holding" : "receiving") : "idle";
  a["from"] = artPkts ? artFrom.toString() : String("");
  a["ago"] = artPkts ? (millis() - artLastAt) / 1000 : 0;
}
