/*
  OSC, custom triggers, OSC ack-out and the light's own web page (firmware 1.2).

  Mode (set on the light's web page):
    lxflow  LXFlow only; OSC is not listened to.
    osc     OSC only; the light never looks for LXFlow and idles with one dim LED.
    both    LXFlow and OSC; an OSC look wins while it is active, then LXFlow shows again.

  Built-in addresses (<target> = this light's OSC name, its 4-character ID, or "all"):
    /cuelight/<target>/standby | acked | hold | call | places | stop | warning   (arg 0 = off)
    /cuelight/<target>/go [seconds]
    /cuelight/<target>/countdown <seconds>
    /cuelight/<target>/look r g b [pattern] [speed ms] [level %] [seconds]
    /cuelight/<target>/off           (clear: back to LXFlow, or idle in OSC mode)
    /cuelight/<target>/ident [seconds]
  Custom triggers (web page) are checked first: address with * and ? wildcards, optional
  first-argument match, a look, a duration (0 = until replaced or cleared) and whether
  the button clears it. The pattern "clear" ends any OSC look.

  The two contact inputs (trigger_inputs.ino, 1.3) are stored and served from here too.
*/

#define MAX_TRIG  24
#define OSC_LOG   12

// ---------- config ----------
char ackIp[40]    = "";
uint16_t ackPort  = 8000;
char ackAddr[96]  = "/cuelight/{name}/ack";
char ackArg[48]   = "";

Trig trigs[MAX_TRIG];
uint8_t nTrig = 0;

// Built-in looks for the /cuelight addresses; LXFlow keeps them in step with its own looks.
const char *BL_KEYS[B_N] = { "standby", "standbyAcked", "go", "hold", "call", "places", "stop", "warning", "countdown", "idle" };
Look blLooks[B_N] = {
  { 255, 0, 0, P_FLASH, 500, 255 },   { 255, 0, 0, P_SOLID, 1000, 255 }, { 0, 255, 0, P_SOLID, 1000, 255 },
  { 255, 160, 0, P_SOLID, 1000, 255 }, { 255, 255, 255, P_SPIN, 1000, 255 }, { 48, 96, 255, P_PULSE, 3000, 255 },
  { 255, 0, 0, P_STROBE, 250, 255 },  { 255, 160, 0, P_PULSE, 2000, 255 }, { 255, 80, 0, P_COUNTDOWN, 1000, 255 },
  { 255, 255, 255, P_DOT, 1000, 26 },
};
Look builtinLook(uint8_t k) { return blLooks[k < B_N ? k : B_IDLE]; }

// ---------- live state ----------
WebServer web(80);
WiFiUDP oscUdp;
bool webUp = false, oscUp = false;
struct OscState { bool on; Look look; uint32_t until; uint8_t ack; uint32_t cdEnd, cdTotal; char what[40]; } oscSt;
enum { ACK_NONE, ACK_CLEARS, ACK_STANDBY };
struct LogRow { uint32_t at; char addr[64]; char arg[24]; char from[16]; char did[24]; };
LogRow oscLog[OSC_LOG];
uint8_t logHead = 0, logCount = 0;
bool restartSoon = false;
uint32_t restartAt = 0;

// ---------- looks helpers ----------
const char *PAT_NAMES[] = { "solid", "flash", "pulse", "dblink", "spin", "strobe", "countdown", "dot", "off" };
bool hexColor(const char *s, Look &L) {
  if (!s || s[0] != '#' || strlen(s) != 7) return false;
  long v = strtol(s + 1, nullptr, 16);
  L.r = (v >> 16) & 255; L.g = (v >> 8) & 255; L.b = v & 255;
  return true;
}
void colorHex(const Look &L, char *out) { snprintf(out, 8, "#%02x%02x%02x", L.r, L.g, L.b); }
uint8_t pct255(int pct) { return (uint8_t)constrain((pct * 255 + 50) / 100, 1, 255); }
int pctOf(uint8_t lvl) { return (lvl * 100 + 127) / 255; }

void storeBuiltinLooks(JsonVariantConst v) {             // {standby:{c,p,r,b}, ...} from LXFlow
  bool changed = false;
  for (uint8_t k = 0; k < B_N; k++) {
    if (!v[BL_KEYS[k]].is<JsonObjectConst>()) continue;
    Look L = lookFrom(v[BL_KEYS[k]]);
    if (memcmp(&L, &blLooks[k], sizeof(Look))) { blLooks[k] = L; changed = true; }
  }
  if (!changed) return;                                  // spare the flash
  prefs.begin("cuelight", false);
  prefs.putBytes("bl", blLooks, sizeof(blLooks));
  prefs.end();
}

// ---------- config load/save ----------
bool parseTrigger(JsonVariantConst t, Trig &T) {
  memset(&T, 0, sizeof T);
  strlcpy(T.addr, t["a"] | "", sizeof T.addr);
  if (!T.addr[0]) return false;
  strlcpy(T.val, t["v"] | "", sizeof T.val);
  T.look = IDLE_LOOK;
  if (!hexColor(t["c"] | "#ffffff", T.look)) hexColor("#ffffff", T.look);
  const char *p = t["p"] | "solid";
  T.clear = !strcmp(p, "clear");
  T.look.pat = patFromName(p);
  T.look.rate = constrain((int)(t["r"] | 1000), 100, 5000);
  T.look.lvl = pct255(constrain((int)(t["l"] | 100), 1, 100));
  T.dur = constrain((int)(t["d"] | 0), 0, 3600);
  T.btnClears = t["k"] | false;
  return true;
}

void loadTriggers(const char *json) {
  nTrig = 0;
  JsonDocument d;
  if (deserializeJson(d, json)) return;
  for (JsonVariantConst t : d.as<JsonArrayConst>()) {
    if (nTrig >= MAX_TRIG) break;
    if (parseTrigger(t, trigs[nTrig])) nTrig++;
  }
}

String triggersJson() {
  JsonDocument d;
  JsonArray a = d.to<JsonArray>();
  for (uint8_t k = 0; k < nTrig; k++) {
    JsonObject t = a.add<JsonObject>();
    char hex[8]; colorHex(trigs[k].look, hex);
    t["a"] = trigs[k].addr; t["v"] = trigs[k].val; t["c"] = hex;
    t["p"] = trigs[k].clear ? "clear" : PAT_NAMES[trigs[k].look.pat];
    t["r"] = trigs[k].look.rate; t["l"] = pctOf(trigs[k].look.lvl); t["d"] = trigs[k].dur; t["k"] = trigs[k].btnClears;
  }
  String s; serializeJson(d, s);
  return s;
}

void loadOscConfig() {
  prefs.begin("cuelight", true);
  lightMode = prefs.getUChar("mode", M_BOTH);
  if (lightMode > M_BOTH) lightMode = M_BOTH;
  prefs.getString("oname", oscName, sizeof oscName);
  oscPort = prefs.getUShort("oport", 8000);
  prefs.getString("aip", ackIp, sizeof ackIp);
  ackPort = prefs.getUShort("aport", 8000);
  if (prefs.isKey("aaddr")) prefs.getString("aaddr", ackAddr, sizeof ackAddr);
  prefs.getString("aarg", ackArg, sizeof ackArg);
  if (prefs.getBytesLength("bl") == sizeof(blLooks)) prefs.getBytes("bl", blLooks, sizeof(blLooks));
  String tj = prefs.getString("trig", "[]");
  String gj = prefs.getString("gpi", "[]");
  prefs.end();
  loadTriggers(tj.c_str());
  gpiLoadJson(gj.c_str());
}

void saveOscConfig() {
  prefs.begin("cuelight", false);
  prefs.putUChar("mode", lightMode);
  prefs.putString("oname", oscName);
  prefs.putUShort("oport", oscPort);
  prefs.putString("aip", ackIp);
  prefs.putUShort("aport", ackPort);
  prefs.putString("aaddr", ackAddr);
  prefs.putString("aarg", ackArg);
  prefs.putString("trig", triggersJson());
  prefs.putString("gpi", gpiJson());
  prefs.end();
}

// ---------- OSC actions ----------
const char *shortId() { return deviceId.c_str() + (deviceId.length() >= 4 ? deviceId.length() - 4 : 0); }

void oscShow(const Look &L, uint32_t ms, uint8_t ack, const char *what) {
  oscSt.on = true; oscSt.look = L; oscSt.ack = ack;
  oscSt.until = ms ? millis() + ms : 0;
  oscSt.cdTotal = 0;
  if (L.pat == P_COUNTDOWN && ms) { oscSt.cdTotal = ms; oscSt.cdEnd = millis() + ms; }
  strlcpy(oscSt.what, what, sizeof oscSt.what);
}
void oscClear() { oscSt.on = false; }

bool oscPaint(uint32_t now) {                            // called from render()
  if (!oscSt.on) return false;
  if (oscSt.until && (int32_t)(oscSt.until - now) <= 0) { oscSt.on = false; return false; }
  paintCd(oscSt.look, now, oscSt.cdEnd, oscSt.cdTotal);
  return true;
}

void fireTrigger(const Trig &T, char *did, int dcap) {
  if (T.clear) { oscClear(); snprintf(did, dcap, "clear"); return; }
  oscShow(T.look, (uint32_t)T.dur * 1000, T.btnClears ? ACK_CLEARS : ACK_NONE, T.addr);
  snprintf(did, dcap, "%s %ds", PAT_NAMES[T.look.pat], T.dur);
}

bool targetIsMe(const char *t) {
  if (!strcasecmp(t, "all")) return true;
  if (oscName[0] && !strcasecmp(t, oscName)) return true;
  return !strcasecmp(t, shortId());
}

// Built-in /cuelight/<target>/<command>. Returns true if handled.
bool builtin(const char *addr, const OscArg *a, int n, char *did, int dcap) {
  char target[32], cmd[24];
  if (!oscSplitCuelight(addr, target, sizeof target, cmd, sizeof cmd) || !targetIsMe(target)) return false;
  int secs = n > 0 ? (int)a[0].d : 0;
  struct { const char *name; uint8_t look; uint8_t ack; } latch[] = {
    { "standby", B_STANDBY, ACK_STANDBY }, { "acked", B_ACKED, ACK_NONE }, { "standbyacked", B_ACKED, ACK_NONE },
    { "hold", B_HOLD, ACK_NONE }, { "call", B_CALL, ACK_CLEARS }, { "places", B_PLACES, ACK_NONE },
    { "stop", B_STOP, ACK_NONE }, { "warning", B_WARNING, ACK_NONE },
  };
  for (auto &l : latch) if (!strcmp(cmd, l.name)) {
    // Buttons often send 1 on press and 0 on release: 0 (or False) clears, anything else latches.
    if (n > 0 && (a[0].t == 'F' || (a[0].t != 's' && a[0].t != 'S' && a[0].d == 0))) {
      if (oscSt.on && !strcmp(oscSt.what, cmd)) oscClear();
      snprintf(did, dcap, "%s off", cmd); return true;
    }
    oscShow(blLooks[l.look], 0, l.ack, cmd);
    snprintf(did, dcap, "%s", cmd); return true;
  }
  if (!strcmp(cmd, "go")) { oscShow(blLooks[B_GO], (secs > 0 ? secs : 3) * 1000UL, ACK_NONE, cmd); snprintf(did, dcap, "go"); return true; }
  if (!strcmp(cmd, "countdown")) {
    if (secs <= 0) { snprintf(did, dcap, "countdown: needs seconds"); return true; }
    Look L = blLooks[B_COUNTDOWN]; L.pat = P_COUNTDOWN;
    oscShow(L, secs * 1000UL, ACK_NONE, cmd); snprintf(did, dcap, "countdown %ds", secs); return true;
  }
  if (!strcmp(cmd, "off") || !strcmp(cmd, "clear")) { oscClear(); snprintf(did, dcap, "clear"); return true; }
  if (!strcmp(cmd, "ident")) { identUntil = millis() + (secs > 0 ? secs : 3) * 1000UL; snprintf(did, dcap, "identify"); return true; }
  if (!strcmp(cmd, "look")) {
    if (n < 3) { snprintf(did, dcap, "look: needs r g b"); return true; }
    Look L = IDLE_LOOK;
    L.r = constrain((int)a[0].d, 0, 255); L.g = constrain((int)a[1].d, 0, 255); L.b = constrain((int)a[2].d, 0, 255);
    L.pat = n > 3 && a[3].s ? patFromName(a[3].s) : P_SOLID;
    L.rate = n > 4 ? constrain((int)a[4].d, 100, 5000) : 1000;
    L.lvl = n > 5 ? pct255(constrain((int)a[5].d, 1, 100)) : 255;
    int d = n > 6 ? (int)a[6].d : 0;
    oscShow(L, d > 0 ? d * 1000UL : 0, ACK_NONE, "look");
    snprintf(did, dcap, "look %s", PAT_NAMES[L.pat]); return true;
  }
  snprintf(did, dcap, "unknown command");
  return true;
}

IPAddress oscFrom;
void onOsc(const char *addr, const OscArg *a, int n, void *) {
  char argText[24] = "", did[24] = "";
  if (n > 0) oscArgText(a[0], argText, sizeof argText);
  bool done = false;
  for (uint8_t k = 0; k < nTrig && !done; k++) {
    if (!oscGlob(trigs[k].addr, addr)) continue;
    if (trigs[k].val[0] && strcasecmp(trigs[k].val, argText)) continue;
    fireTrigger(trigs[k], did, sizeof did);
    done = true;
  }
  if (!done && !builtin(addr, a, n, did, sizeof did)) snprintf(did, sizeof did, "-");
  LogRow &r = oscLog[logHead];
  r.at = millis();
  strlcpy(r.addr, addr, sizeof r.addr); strlcpy(r.arg, argText, sizeof r.arg);
  strlcpy(r.from, oscFrom.toString().c_str(), sizeof r.from); strlcpy(r.did, did, sizeof r.did);
  logHead = (logHead + 1) % OSC_LOG; if (logCount < OSC_LOG) logCount++;
}

void pollOsc() {
  if (!oscUp) return;
  for (int guard = 0; guard < 8; guard++) {               // drain a burst, but keep the LEDs moving
    int n = oscUdp.parsePacket();
    if (n <= 0) return;
    static uint8_t buf[1024];
    if (n > (int)sizeof buf) { oscUdp.clear(); continue; }
    oscFrom = oscUdp.remoteIP();
    int got = oscUdp.read(buf, n);
    oscParse(buf, got, onOsc, nullptr);
  }
}

// ---------- ack out ----------
// Sends one OSC message to the "Button sends OSC" IP and port. {name} = this light.
bool sendOscOut(const char *tmpl, const char *arg) {
  IPAddress ip;
  if (!ackIp[0] || !ip.fromString(ackIp) || !tmpl[0]) return false;
  char addr[128];
  const char *tok = strstr(tmpl, "{name}");
  const char *nm = oscName[0] ? oscName : shortId();
  if (tok) snprintf(addr, sizeof addr, "%.*s%s%s", (int)(tok - tmpl), tmpl, nm, tok + 6);
  else strlcpy(addr, tmpl, sizeof addr);
  uint8_t pkt[192];
  int len = oscBuild(pkt, sizeof pkt, addr, arg);
  if (!len) return false;
  oscUdp.beginPacket(ip, ackPort);
  oscUdp.write(pkt, len);
  return oscUdp.endPacket();
}
bool sendAckOut() { return sendOscOut(ackAddr, ackArg); }

// Short press of the ack button (from pollButton).
void buttonPressed() {
  if (lightMode != M_LXFLOW && oscSt.on) {
    if (oscSt.ack == ACK_STANDBY) { oscSt.look = blLooks[B_ACKED]; oscSt.ack = ACK_NONE; }
    else if (oscSt.ack == ACK_CLEARS) oscClear();
  }
  if (lightMode != M_LXFLOW) sendAckOut();
  if (lightMode != M_OSC && linked) { JsonDocument d; d["t"] = "ack"; sendJson(d); }
  Serial.println("ack");
}

// ---------- web page + API ----------
#include "web_page.h"

void apiState() {
  JsonDocument d;
  d["fw"] = FW_VERSION; d["id"] = deviceId; d["short"] = shortId(); d["host"] = apName;
  d["ip"] = WiFi.localIP().toString(); d["rssi"] = WiFi.RSSI(); d["up"] = millis() / 1000;
  d["mode"] = lightMode == M_OSC ? "osc" : lightMode == M_LXFLOW ? "lxflow" : "both";
  d["linked"] = linked; d["lxflow"] = linked ? serverIp.toString() + ":" + String(serverPort) : String("");
  d["oscName"] = oscName; d["oscPort"] = oscPort; d["oscUp"] = oscUp;
  d["ackIp"] = ackIp; d["ackPort"] = ackPort; d["ackAddr"] = ackAddr; d["ackArg"] = ackArg;
  d["showing"] = oscSt.on ? oscSt.what : (lightMode == M_OSC ? "idle" : linked ? "LXFlow" : "looking for LXFlow");
  JsonDocument t; deserializeJson(t, triggersJson()); d["triggers"] = t;
  gpiState(d);
  JsonArray lg = d["log"].to<JsonArray>();
  for (uint8_t k = 0; k < logCount; k++) {
    LogRow &r = oscLog[(logHead + OSC_LOG - 1 - k) % OSC_LOG];
    JsonObject o = lg.add<JsonObject>();
    o["ago"] = (millis() - r.at) / 1000; o["a"] = r.addr; o["v"] = r.arg; o["from"] = r.from; o["did"] = r.did;
  }
  String s; serializeJson(d, s);
  web.send(200, "application/json", s);
}

void apiConfig() {
  JsonDocument d;
  if (deserializeJson(d, web.arg("plain"))) { web.send(400, "application/json", "{\"ok\":false,\"error\":\"Bad JSON\"}"); return; }
  uint8_t oldMode = lightMode; uint16_t oldPort = oscPort;
  const char *m = d["mode"] | "both";
  lightMode = !strcmp(m, "osc") ? M_OSC : !strcmp(m, "lxflow") ? M_LXFLOW : M_BOTH;
  strlcpy(oscName, d["oscName"] | "", sizeof oscName);
  oscPort = constrain((int)(d["oscPort"] | 8000), 1, 65535);
  strlcpy(ackIp, d["ackIp"] | "", sizeof ackIp);
  ackPort = constrain((int)(d["ackPort"] | 8000), 1, 65535);
  strlcpy(ackAddr, d["ackAddr"] | "", sizeof ackAddr);
  strlcpy(ackArg, d["ackArg"] | "", sizeof ackArg);
  String tj; serializeJson(d["triggers"], tj);
  loadTriggers(tj.c_str());
  if (d["inputs"].is<JsonArrayConst>()) { String gj; serializeJson(d["inputs"], gj); gpiLoadJson(gj.c_str()); }
  if (triggersJson().length() > 3800) {                   // NVS strings top out near 4000 bytes
    loadOscConfig();
    web.send(400, "application/json", "{\"ok\":false,\"error\":\"Too many triggers to store. Shorten addresses or remove some.\"}");
    return;
  }
  saveOscConfig();
  bool restart = oldMode != lightMode || oldPort != oscPort;
  web.send(200, "application/json", restart ? "{\"ok\":true,\"restart\":true}" : "{\"ok\":true}");
  if (restart) { restartSoon = true; restartAt = millis() + 800; }
}

void apiTest() {
  JsonDocument d;
  if (deserializeJson(d, web.arg("plain"))) { web.send(400, "text/plain", "Bad JSON"); return; }
  const char *what = d["what"] | "";
  char did[24] = "";
  if (!strcmp(what, "clear")) oscClear();
  else if (!strcmp(what, "ack")) { bool ok = sendAckOut(); web.send(200, "application/json", ok ? "{\"ok\":true}" : "{\"ok\":false,\"error\":\"Set an IP address, port and OSC address first.\"}"); return; }
  else if (!strcmp(what, "trigger")) {                     // preview a row without saving it
    Trig T;
    if (parseTrigger(d["trigger"], T)) fireTrigger(T, did, sizeof did);
  }
  else if (!strcmp(what, "input")) {                       // preview an input row: look + its OSC
    Gpi G; parseGpi(d["input"], G);
    bool sent = gpiFire(constrain((int)(d["n"] | 0), 0, 1), G, "test from this page");
    web.send(200, "application/json", sent ? "{\"ok\":true,\"osc\":true}" : "{\"ok\":true,\"osc\":false}");
    return;
  }
  web.send(200, "application/json", "{\"ok\":true}");
}

void oscStopWeb() { if (webUp) { web.stop(); webUp = false; } if (oscUp) { oscUdp.stop(); oscUp = false; } }

void oscSetup() {                                        // after Wi-Fi is up
  memset(&oscSt, 0, sizeof oscSt);
  String host = apName; host.toLowerCase();
  if (MDNS.begin(host.c_str())) {
    MDNS.addService("http", "tcp", 80);
    if (lightMode != M_LXFLOW) MDNS.addService("osc", "udp", oscPort);
  }
  web.on("/", HTTP_GET, []() { web.send(200, "text/html", PAGE_HTML); });
  web.on("/api/state", HTTP_GET, apiState);
  web.on("/api/config", HTTP_POST, apiConfig);
  web.on("/api/test", HTTP_POST, apiTest);
  web.onNotFound([]() { web.send(404, "text/plain", "Not found"); });
  web.begin(); webUp = true;
  if (lightMode != M_LXFLOW) { oscUp = oscUdp.begin(oscPort); Serial.printf("OSC on UDP %u: %s\n", oscPort, oscUp ? "ok" : "failed"); }
  Serial.printf("Light page: http://%s/  (http://%s.local/)\n", WiFi.localIP().toString().c_str(), host.c_str());
}

void oscLoop() {
  if (webUp) web.handleClient();
  pollOsc();
  if (restartSoon && (int32_t)(millis() - restartAt) >= 0) ESP.restart();
}
