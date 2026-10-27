/*
  LXFlow Cue Light — ESP32 firmware
  ---------------------------------
  One cue light per ESP32. Connects to LXFlow over Wi-Fi (WebSocket, path /cuelight)
  and shows the "look" LXFlow sends: a colour, a pattern, a speed and a level. Pattern
  timing runs here, so the network only carries changes. Every look (standby, GO, hold,
  call, countdown, places, stop...) is set in LXFlow Settings -> Cue lights.

  Hardware (ESP32-WROOM-32 DevKit, 38- or 30-pin):
    WS2812 ring DIN  -> GPIO 16 (through a 330 ohm resistor)
    WS2812 ring 5V   -> VIN (USB 5V)       WS2812 GND -> GND
    Ack button       -> GPIO 27 to GND (internal pull-up). The on-board BOOT button also works.

  Button:
    Short press  = ack: LXFlow decides what it answers (a standby first, else a CALL)
    Hold 5 s     = open the Wi-Fi setup portal (ring turns cyan)

  Shown by the light itself (colours can be set from LXFlow; saved on the light):
    Lost LXFlow  default blue breathing     <- the last cue is cleared, never stale
    No Wi-Fi     default purple breathing
    Setup portal cyan steady: join "LXFlow-CueLight-XXXX" and browse to 192.168.4.1
    Identify     white spin (from LXFlow Settings)

  Patterns: solid, flash, pulse, dblink (double blink), spin, strobe, countdown
  (the ring drains to zero), dot (one LED), off. LXFlow 1.0.x-era messages are not used.

  Libraries (Arduino Library Manager): WiFiManager (tzapu) 2.0.17, WebSockets (Markus Sattler) 2.7.x,
  Adafruit NeoPixel 1.15.x, ArduinoJson 7.x. Board: esp32 by Espressif 3.x, "ESP32 Dev Module".
*/

#include <WiFi.h>
#include <WiFiUdp.h>
#include <WiFiManager.h>
#include <WebSocketsClient.h>
#include <Adafruit_NeoPixel.h>
#include <ArduinoJson.h>
#include <Preferences.h>

#define FW_VERSION      "1.1.0"
#define LED_PIN         16
#define BTN_PIN         27
#define ACK_BOOT_PIN        0
#define MAX_LEDS        64
#define DISCOVERY_PORT  7391
#define DEFAULT_PORT    7390
#define HOLD_PORTAL_MS  5000
#define REDISCOVER_MS   10000   // auto mode: if the link stays down this long, look for LXFlow again

// A look from LXFlow (declared up here so Arduino's generated prototypes can see it).
enum Pat : uint8_t { P_SOLID, P_FLASH, P_PULSE, P_DBLINK, P_SPIN, P_STROBE, P_COUNTDOWN, P_DOT, P_OFF };
struct Look { uint8_t r, g, b; uint8_t pat; uint16_t rate; uint8_t lvl; };

// ---------- config (persisted) ----------
Preferences prefs;
char cfgHost[64]  = "";          // blank = auto-discover LXFlow on the network
char cfgPort[8]   = "7390";
char cfgCode[32]  = "";          // LXFlow room code, if one is set
char cfgLeds[4]   = "12";
char cfgBright[4] = "80";        // 0-255

uint16_t ledCount = 12;
uint8_t  bright   = 80;

void loadConfig() {
  prefs.begin("cuelight", true);
  prefs.getString("host",   cfgHost,   sizeof(cfgHost));
  prefs.getString("port",   cfgPort,   sizeof(cfgPort));
  prefs.getString("code",   cfgCode,   sizeof(cfgCode));
  prefs.getString("leds",   cfgLeds,   sizeof(cfgLeds));
  prefs.getString("bright", cfgBright, sizeof(cfgBright));
  prefs.end();
  if (!cfgPort[0])   strcpy(cfgPort, "7390");
  if (!cfgLeds[0])   strcpy(cfgLeds, "12");
  if (!cfgBright[0]) strcpy(cfgBright, "80");
  ledCount = constrain(atoi(cfgLeds), 1, MAX_LEDS);
  bright   = constrain(atoi(cfgBright), 5, 255);
}

void saveConfig() {
  prefs.begin("cuelight", false);
  prefs.putString("host", cfgHost);
  prefs.putString("port", cfgPort);
  prefs.putString("code", cfgCode);
  prefs.putString("leds", cfgLeds);
  prefs.putString("bright", cfgBright);
  prefs.end();
}

// ---------- hardware ----------
Adafruit_NeoPixel ring(MAX_LEDS, LED_PIN, NEO_GRB + NEO_KHZ800);
WebSocketsClient ws;
WiFiUDP udp;
WiFiManager wm;

String deviceId;     // MAC without colons
String apName;       // LXFlow-CueLight-XXXX

// ---------- looks ----------
const Look IDLE_LOOK = { 255, 255, 255, P_DOT, 1000, 25 };
Look cur      = IDLE_LOOK;                          // what LXFlow last asked for
Look lostLook = { 0, 0, 255, P_PULSE, 2400, 89 };   // no link to LXFlow
Look wifiLook = { 255, 0, 255, P_PULSE, 2400, 89 }; // no Wi-Fi
uint32_t cdEnd = 0, cdTotal = 0;                    // countdown pattern
uint32_t identUntil = 0;

uint8_t patFromName(const char *p) {
  static const char *names[] = { "solid", "flash", "pulse", "dblink", "spin", "strobe", "countdown", "dot", "off" };
  for (uint8_t i = 0; i < 9; i++) if (!strcmp(p, names[i])) return i;
  return P_SOLID;
}
void loadLocalLooks() {
  prefs.begin("cuelight", true);
  if (prefs.getBytesLength("lost") == sizeof(Look)) prefs.getBytes("lost", &lostLook, sizeof(Look));
  if (prefs.getBytesLength("nowifi") == sizeof(Look)) prefs.getBytes("nowifi", &wifiLook, sizeof(Look));
  prefs.end();
}

bool     wsStarted = false;
bool     linked = false;
uint32_t linkLostAt = 0;
IPAddress serverIp;
uint16_t serverPort = DEFAULT_PORT;
uint32_t lastDiscover = 0;

// ---------- LEDs ----------
void fill(uint32_t c, uint16_t n = 0xFFFF) {
  ring.clear();
  for (uint16_t i = 0; i < ledCount && i < n; i++) ring.setPixelColor(i, c);
}

uint8_t breathe(uint32_t now, uint16_t periodMs) {   // 0..255 triangle-ish breathe
  uint16_t p = now % periodMs;
  uint16_t half = periodMs / 2;
  uint16_t v = p < half ? (p * 255UL) / half : ((periodMs - p) * 255UL) / half;
  return (uint8_t)((v * v) / 255);                    // ease
}

uint32_t col(const Look &L, uint16_t k) {           // k = 0..255 intensity within the look
  uint32_t s = (uint32_t)L.lvl * k;
  return ring.Color(L.r * s / 65025, L.g * s / 65025, L.b * s / 65025);
}

void paint(const Look &L, uint32_t now) {
  ring.clear();
  uint16_t rate = L.rate < 100 ? 100 : L.rate;
  uint32_t ph = now % rate;
  switch (L.pat) {
    case P_SOLID:  fill(col(L, 255)); break;
    case P_FLASH:  if (ph < rate / 2) fill(col(L, 255)); break;
    case P_PULSE:  fill(col(L, breathe(now, rate))); break;
    case P_DBLINK: if (ph < rate * 12 / 100 || (ph >= rate * 25 / 100 && ph < rate * 37 / 100)) fill(col(L, 255)); break;
    case P_STROBE: if (ph < max<uint32_t>(30, rate * 15 / 100)) fill(col(L, 255)); break;
    case P_SPIN: {
      uint16_t head = (now / max<uint32_t>(1, rate / ledCount)) % ledCount;
      for (uint8_t k = 0; k < 3 && k < ledCount; k++) ring.setPixelColor((head + ledCount - k) % ledCount, col(L, 255 >> k));
      break;
    }
    case P_COUNTDOWN: {
      if (!cdTotal) { fill(col(L, 255)); break; }
      int32_t left = (int32_t)(cdEnd - now);
      if (left <= 0) break;                                  // ran out: dark until LXFlow moves on
      uint32_t n = ((uint32_t)left * ledCount + cdTotal - 1) / cdTotal;
      fill(col(L, 255), n > ledCount ? ledCount : n);
      break;
    }
    case P_DOT: ring.setPixelColor(0, col(L, 255)); break;
    default: break;                                          // P_OFF
  }
}

void render() {
  uint32_t now = millis();
  ring.setBrightness(bright);

  if (identUntil && (int32_t)(identUntil - now) > 0) {
    ring.clear();
    uint16_t head = (now / 60) % ledCount;
    for (uint8_t k = 0; k < 3 && k < ledCount; k++)
      ring.setPixelColor((head + ledCount - k) % ledCount, ring.Color(255 >> k, 255 >> k, 255 >> k));
    ring.show();
    return;
  }
  identUntil = 0;

  if (WiFi.status() != WL_CONNECTED) paint(wifiLook, now);
  else if (!linked)                  paint(lostLook, now);
  else                               paint(cur, now);
  ring.show();
}

// ---------- WebSocket ----------
void sendJson(JsonDocument &d) {
  String s; serializeJson(d, s);
  ws.sendTXT(s);
}

void sendHello() {
  JsonDocument d;
  d["t"] = "hello";
  d["id"] = deviceId;
  d["fw"] = FW_VERSION;
  d["leds"] = ledCount;
  d["code"] = cfgCode;
  sendJson(d);
}

Look lookFrom(JsonVariantConst v) {                 // {c:[r,g,b], p, r, b}
  Look L = IDLE_LOOK;
  L.r = v["c"][0] | 0; L.g = v["c"][1] | 0; L.b = v["c"][2] | 0;
  L.pat = patFromName(v["p"] | "solid");
  L.rate = constrain((int)(v["r"] | 1000), 100, 5000);
  L.lvl = constrain((int)(v["b"] | 255), 1, 255);
  return L;
}

void saveLocal(const char *key, const Look &L, Look &slot) {
  if (!memcmp(&L, &slot, sizeof(Look))) return;      // unchanged: spare the flash
  slot = L;
  prefs.begin("cuelight", false);
  prefs.putBytes(key, &slot, sizeof(Look));
  prefs.end();
}

void handleMessage(const char *txt, size_t len) {
  JsonDocument d;
  if (deserializeJson(d, txt, len)) return;
  const char *t = d["t"] | "";
  if (!strcmp(t, "look")) {
    cur = lookFrom(d.as<JsonVariantConst>());
    if (cur.pat == P_COUNTDOWN && d["cd"].is<JsonObjectConst>()) {
      cdTotal = d["cd"]["t"] | 0;
      cdEnd = millis() + (uint32_t)(d["cd"]["l"] | 0);
    } else { cdTotal = 0; }
    Serial.printf("look %s\n", (const char *)(d["p"] | "?"));
  } else if (!strcmp(t, "local")) {
    if (d["lost"].is<JsonObjectConst>())   saveLocal("lost", lookFrom(d["lost"]), lostLook);
    if (d["nowifi"].is<JsonObjectConst>()) saveLocal("nowifi", lookFrom(d["nowifi"]), wifiLook);
  } else if (!strcmp(t, "ident")) {
    identUntil = millis() + (uint32_t)(d["ms"] | 3000);
  } else if (!strcmp(t, "cfg")) {
    if (d["bright"].is<int>()) bright = constrain((int)d["bright"], 5, 255);
  }
}

void onWs(WStype_t type, uint8_t *payload, size_t len) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.println("ws connected");
      linked = true;
      sendHello();
      break;
    case WStype_DISCONNECTED:
      if (linked) { Serial.println("ws disconnected"); linkLostAt = millis(); }
      linked = false;
      cur = IDLE_LOOK;        // never hold a stale cue
      break;
    case WStype_TEXT:
      handleMessage((const char *)payload, len);
      break;
    default: break;
  }
}

void startWs(IPAddress ip, uint16_t port) {
  if (wsStarted) ws.disconnect();
  serverIp = ip; serverPort = port;
  Serial.printf("connecting to LXFlow at %s:%u\n", ip.toString().c_str(), port);
  ws.begin(ip, port, "/cuelight");
  ws.onEvent(onWs);
  ws.setReconnectInterval(2000);
  ws.enableHeartbeat(2000, 1500, 2);    // lost link detected in ~5-7 s
  wsStarted = true;
  linkLostAt = millis();
}

// Auto-discovery: broadcast "LXFLOW_DISCOVER" on UDP 7391; LXFlow answers "LXFLOW <port>".
void discover() {
  uint32_t now = millis();
  if (now - lastDiscover < 2000) {
    int n = udp.parsePacket();
    if (n > 0) {
      char buf[48] = {0};
      udp.read(buf, sizeof(buf) - 1);
      if (!strncmp(buf, "LXFLOW ", 7)) {
        uint16_t p = atoi(buf + 7);
        startWs(udp.remoteIP(), p ? p : DEFAULT_PORT);
      }
    }
    return;
  }
  lastDiscover = now;
  udp.beginPacket(IPAddress(255, 255, 255, 255), DISCOVERY_PORT);
  udp.print("LXFLOW_DISCOVER");
  udp.endPacket();
}

// ---------- setup portal ----------
WiFiManagerParameter pHost("host", "LXFlow host IP (blank = find automatically)", cfgHost, 63);
WiFiManagerParameter pPort("port", "LXFlow port", cfgPort, 7);
WiFiManagerParameter pCode("code", "Room code (if LXFlow uses one)", cfgCode, 31);
WiFiManagerParameter pLeds("leds", "LED count", cfgLeds, 3);
WiFiManagerParameter pBright("bright", "Brightness 5-255", cfgBright, 3);

void onSaveParams() {
  strlcpy(cfgHost, pHost.getValue(), sizeof(cfgHost));
  strlcpy(cfgPort, pPort.getValue(), sizeof(cfgPort));
  strlcpy(cfgCode, pCode.getValue(), sizeof(cfgCode));
  strlcpy(cfgLeds, pLeds.getValue(), sizeof(cfgLeds));
  strlcpy(cfgBright, pBright.getValue(), sizeof(cfgBright));
  saveConfig();
  Serial.println("settings saved");
}

void showCyan() { ring.setBrightness(bright); fill(ring.Color(0, 160, 160)); ring.show(); }

void openPortal() {
  Serial.println("opening setup portal");
  showCyan();
  if (wsStarted) { ws.disconnect(); wsStarted = false; linked = false; }
  wm.setConfigPortalTimeout(300);
  wm.startConfigPortal(apName.c_str());
  ESP.restart();                        // apply new settings cleanly
}

// ---------- button ----------
uint32_t pressStart = 0;
bool     wasDown = false;

void pollButton() {
  bool down = digitalRead(BTN_PIN) == LOW || digitalRead(ACK_BOOT_PIN) == LOW;
  uint32_t now = millis();
  if (down && !wasDown) pressStart = now;
  if (down && now - pressStart >= HOLD_PORTAL_MS) openPortal();
  if (!down && wasDown) {
    uint32_t held = now - pressStart;
    if (held >= 40 && held < 1000 && linked) {   // LXFlow decides what the ack answers
      JsonDocument d; d["t"] = "ack"; sendJson(d);
      Serial.println("ack");
    }
  }
  wasDown = down;
}

// ---------- main ----------
void setup() {
  Serial.begin(115200);
  pinMode(BTN_PIN, INPUT_PULLUP);
  pinMode(ACK_BOOT_PIN, INPUT_PULLUP);
  loadConfig();
  loadLocalLooks();
  pHost.setValue(cfgHost, 63); pPort.setValue(cfgPort, 7); pCode.setValue(cfgCode, 31);
  pLeds.setValue(cfgLeds, 3);  pBright.setValue(cfgBright, 3);

  ring.begin();
  ring.updateLength(ledCount);
  showCyan();

  uint8_t mac[6];
  WiFi.mode(WIFI_STA);
  WiFi.macAddress(mac);
  char id[13], ap[32];
  snprintf(id, sizeof(id), "%02X%02X%02X%02X%02X%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  snprintf(ap, sizeof(ap), "LXFlow-CueLight-%02X%02X", mac[4], mac[5]);
  deviceId = id; apName = ap;
  Serial.printf("\nLXFlow Cue Light %s  id %s\n", FW_VERSION, id);

  WiFi.setHostname(ap);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(false);                 // lower latency
  wm.addParameter(&pHost); wm.addParameter(&pPort); wm.addParameter(&pCode);
  wm.addParameter(&pLeds); wm.addParameter(&pBright);
  wm.setSaveParamsCallback(onSaveParams);
  wm.setConnectTimeout(20);
  wm.setConfigPortalTimeout(300);
  if (!wm.autoConnect(ap)) ESP.restart();   // no network found and nobody configured it: retry

  udp.begin(DISCOVERY_PORT + 1);
  IPAddress ip;
  if (cfgHost[0] && ip.fromString(cfgHost)) startWs(ip, constrain(atoi(cfgPort), 1, 65535));
}

void loop() {
  pollButton();
  if (WiFi.status() == WL_CONNECTED) {
    bool manual = cfgHost[0] != 0;
    if (wsStarted) ws.loop();
    if (!manual && !linked) {
      if (!wsStarted || millis() - linkLostAt > REDISCOVER_MS) {
        if (wsStarted) { ws.disconnect(); wsStarted = false; }
        discover();
      }
    }
  } else if (linked) {
    linked = false; cur = IDLE_LOOK;
  }
  render();
  delay(10);
}
