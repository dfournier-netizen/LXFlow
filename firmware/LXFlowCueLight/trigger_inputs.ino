/*
  Two dry-contact trigger inputs (firmware 1.3).

  Wiring: a switch, footswitch or relay contact between the input pin and GND, through a
  3.5 mm mono (TS) panel jack: tip = input, sleeve = GND.
    Input 1 -> GPIO 32      Input 2 -> GPIO 33
  The ESP32's internal pull-ups hold the pins high, which is fine for cable runs under
  about 3 m. Dry contacts only: never connect a voltage to these pins.

  Each input, set on the light's web page (stored with the OSC settings, key "gpi"):
    fires when   off | the contact closes | the contact opens
    look         colour, pattern, speed and level, shown for a set number of seconds
                 (0 = until cleared); pattern "clear" ends any OSC look instead
    button       whether the ack button clears it early
    OSC          an optional address and argument, sent to the "Button sends OSC" IP and
                 port ({name} = this light). Not sent in LXFlow-only mode.
  An input shows its look the same way an OSC trigger does: on top of LXFlow while it
  lasts. Each closure restarts the time; holding the contact closed does not repeat it.
*/

#define N_GPI           2
#define GPI_DEBOUNCE_MS 30
const uint8_t GPI_PINS[N_GPI] = { 32, 33 };
enum { G_OFF, G_CLOSE, G_OPEN };
const char *GPI_WHEN[] = { "off", "close", "open" };

Gpi gpis[N_GPI];
bool gpiClosed[N_GPI], gpiRaw[N_GPI];
uint32_t gpiRawAt[N_GPI];

bool parseGpi(JsonVariantConst j, Gpi &G) {
  memset(&G, 0, sizeof G);
  const char *w = j["w"] | "off";
  G.when = !strcmp(w, "close") ? G_CLOSE : !strcmp(w, "open") ? G_OPEN : G_OFF;
  Trig &T = G.t;
  strlcpy(T.addr, j["a"] | "", sizeof T.addr);          // OSC to send (blank = none)
  strlcpy(T.val, j["v"] | "", sizeof T.val);
  T.look = IDLE_LOOK;
  if (!hexColor(j["c"] | "#ffffff", T.look)) hexColor("#ffffff", T.look);
  const char *p = j["p"] | "solid";
  T.clear = !strcmp(p, "clear");
  T.look.pat = patFromName(p);
  T.look.rate = constrain((int)(j["r"] | 1000), 100, 5000);
  T.look.lvl = pct255(constrain((int)(j["l"] | 100), 1, 100));
  T.dur = constrain((int)(j["d"] | 5), 0, 3600);
  T.btnClears = j["k"] | false;
  return true;
}

void gpiLoadJson(const char *json) {
  JsonDocument d;
  deserializeJson(d, json);                              // bad or missing JSON = defaults
  JsonArrayConst a = d.as<JsonArrayConst>();
  for (uint8_t i = 0; i < N_GPI; i++) parseGpi(a[i], gpis[i]);
}

void gpiToJson(JsonObject o, const Gpi &G) {
  char hex[8]; colorHex(G.t.look, hex);
  o["w"] = GPI_WHEN[G.when < 3 ? G.when : 0];
  o["c"] = hex; o["p"] = G.t.clear ? "clear" : PAT_NAMES[G.t.look.pat];
  o["r"] = G.t.look.rate; o["l"] = pctOf(G.t.look.lvl); o["d"] = G.t.dur; o["k"] = G.t.btnClears;
  o["a"] = G.t.addr; o["v"] = G.t.val;
}

String gpiJson() {
  JsonDocument d;
  JsonArray a = d.to<JsonArray>();
  for (uint8_t i = 0; i < N_GPI; i++) gpiToJson(a.add<JsonObject>(), gpis[i]);
  String s; serializeJson(d, s);
  return s;
}

void gpiState(JsonDocument &d) {                         // for /api/state
  JsonArray a = d["inputs"].to<JsonArray>();
  for (uint8_t i = 0; i < N_GPI; i++) {
    JsonObject o = a.add<JsonObject>();
    gpiToJson(o, gpis[i]);
    o["pin"] = GPI_PINS[i]; o["closed"] = gpiClosed[i];
  }
}

// Shows the input's look and sends its OSC. Returns true if an OSC message went out.
bool gpiFire(uint8_t i, const Gpi &G, const char *event) {
  char what[16]; snprintf(what, sizeof what, "input %u", i + 1);
  char did[24];
  if (G.t.clear) { oscClear(); snprintf(did, sizeof did, "clear"); }
  else {
    oscShow(G.t.look, (uint32_t)G.t.dur * 1000, G.t.btnClears ? ACK_CLEARS : ACK_NONE, what);
    snprintf(did, sizeof did, "%s %us", PAT_NAMES[G.t.look.pat], G.t.dur);
  }
  bool sent = G.t.addr[0] && lightMode != M_LXFLOW && sendOscOut(G.t.addr, G.t.val);
  if (sent) strlcat(did, " + OSC", sizeof did);
  LogRow &r = oscLog[logHead];                           // shows in "Recent OSC received"
  r.at = millis();
  strlcpy(r.addr, event, sizeof r.addr);
  r.arg[0] = 0; strlcpy(r.from, what, sizeof r.from); strlcpy(r.did, did, sizeof r.did);
  logHead = (logHead + 1) % OSC_LOG; if (logCount < OSC_LOG) logCount++;
  return sent;
}

void gpiSetup() {
  for (uint8_t i = 0; i < N_GPI; i++) {
    pinMode(GPI_PINS[i], INPUT_PULLUP);
    delayMicroseconds(50);
    gpiRaw[i] = gpiClosed[i] = digitalRead(GPI_PINS[i]) == LOW;   // state at boot does not fire
    gpiRawAt[i] = millis();
  }
}

void gpiLoop() {
  uint32_t now = millis();
  for (uint8_t i = 0; i < N_GPI; i++) {
    bool raw = digitalRead(GPI_PINS[i]) == LOW;
    if (raw != gpiRaw[i]) { gpiRaw[i] = raw; gpiRawAt[i] = now; continue; }
    if (raw == gpiClosed[i] || now - gpiRawAt[i] < GPI_DEBOUNCE_MS) continue;
    gpiClosed[i] = raw;
    Serial.printf("input %u %s\n", i + 1, raw ? "closed" : "opened");
    if ((raw && gpis[i].when == G_CLOSE) || (!raw && gpis[i].when == G_OPEN)) gpiFire(i, gpis[i], raw ? "contact closed" : "contact opened");
  }
}
