#define ARDUINOJSON_ENABLE_ARDUINO_STRING 0
#define ARDUINOJSON_ENABLE_STD_STRING 1
#include "shim.h"
#include <ArduinoJson.h>
#include "../LXFlowCueLight/osc_core.h"
#include <iostream>
#include <fstream>
// --- the pieces of LXFlowCueLight.ino that osc.ino uses ---
#define FW_VERSION "1.3.0"
enum Pat : uint8_t { P_SOLID, P_FLASH, P_PULSE, P_DBLINK, P_SPIN, P_STROBE, P_COUNTDOWN, P_DOT, P_OFF };
struct Look { uint8_t r, g, b; uint8_t pat; uint16_t rate; uint8_t lvl; };
enum Mode : uint8_t { M_LXFLOW, M_OSC, M_BOTH };
enum Builtin : uint8_t { B_STANDBY, B_ACKED, B_GO, B_HOLD, B_CALL, B_PLACES, B_STOP, B_WARNING, B_COUNTDOWN, B_IDLE, B_N };
struct Trig { char addr[96]; char val[32]; Look look; bool clear; uint16_t dur; bool btnClears; };
struct Gpi { Trig t; uint8_t when; };
uint8_t lightMode = M_BOTH; char oscName[24] = ""; uint16_t oscPort = 8000;
Preferences prefs; String deviceId = "A1B2C3D4E5F6", apName = "LXFlow-CueLight-E5F6";
const Look IDLE_LOOK = { 255, 255, 255, P_DOT, 1000, 25 };
bool linked = false; IPAddress serverIp; uint16_t serverPort = 7390; uint32_t identUntil = 0;
int lxAcks = 0;
uint8_t patFromName(const char *p) { static const char *n[] = { "solid","flash","pulse","dblink","spin","strobe","countdown","dot","off" }; for (uint8_t i = 0; i < 9; i++) if (!strcmp(p, n[i])) return i; return P_SOLID; }
Look lookFrom(JsonVariantConst v) { Look L = IDLE_LOOK; L.r = v["c"][0] | 0; L.g = v["c"][1] | 0; L.b = v["c"][2] | 0; L.pat = patFromName(v["p"] | "solid"); L.rate = constrain((int)(v["r"] | 1000), 100, 5000); L.lvl = constrain((int)(v["b"] | 255), 1, 255); return L; }
void sendJson(JsonDocument &) { lxAcks++; }
Look painted; bool paintedSet = false;
void paintCd(const Look &L, uint32_t, uint32_t, uint32_t) { painted = L; paintedSet = true; }
// forward declarations Arduino would generate
void oscClear(); bool oscPaint(uint32_t); void onOsc(const char *, const OscArg *, int, void *); void buttonPressed(); void loadOscConfig(); void apiConfig(); bool sendAckOut();
bool sendOscOut(const char *, const char *); void gpiLoadJson(const char *); String gpiJson(); void gpiState(JsonDocument &);
bool parseGpi(JsonVariantConst, Gpi &); bool gpiFire(uint8_t, const Gpi &, const char *);
#include "../LXFlowCueLight/osc.ino"
#include "../LXFlowCueLight/trigger_inputs.ino"
// --- tests ---
int fails = 0;
#define CHECK(c, m) do { if (!(c)) { std::cout << "FAIL " << m << "\n"; fails++; } else std::cout << "ok   " << m << "\n"; } while (0)
void send(const char *addr, const char *arg = "") { uint8_t b[256]; int n = oscBuild(b, 256, addr, arg); oscParse(b, n, onOsc, nullptr); }
const char *showing() { return oscSt.on ? oscSt.what : "-"; }
bool lookIs(uint8_t pat, int r, int g, int b) { paintedSet = false; if (!oscPaint(millis())) return false; return painted.pat == pat && painted.r == r && painted.g == g && painted.b == b; }
void config(const char *json) { web.body = json; try { apiConfig(); } catch (int) {} }
int main() {
  loadOscConfig();
  CHECK(lightMode == M_BOTH && oscPort == 8000, "defaults: both mode, port 8000");
  // built-ins
  send("/cuelight/all/standby");
  CHECK(lookIs(P_FLASH, 255, 0, 0), "standby flashes red");
  buttonPressed();
  CHECK(lookIs(P_SOLID, 255, 0, 0), "button acks standby -> solid");
  CHECK(lxAcks == 0, "no LXFlow ack while not linked");
  send("/cuelight/E5F6/go");
  CHECK(lookIs(P_SOLID, 0, 255, 0), "go by short ID");
  fakeMillis += 3100;
  CHECK(!oscPaint(millis()), "go ends after 3 s");
  send("/cuelight/LX/hold");
  CHECK(!oscSt.on, "unknown name ignored");
  config(R"({"mode":"both","oscName":"LX","oscPort":8000,"ackIp":"","ackPort":8000,"ackAddr":"/cuelight/{name}/ack","ackArg":"","triggers":[]})");
  send("/cuelight/lx/hold", "1");
  CHECK(lookIs(P_SOLID, 255, 160, 0), "hold with arg 1 latches (name is case-insensitive)");
  fakeMillis += 60000;
  CHECK(oscPaint(millis()), "hold stays on");
  send("/cuelight/LX/hold", "0");
  CHECK(!oscSt.on, "hold with arg 0 clears");
  send("/cuelight/LX/call"); buttonPressed();
  CHECK(!oscSt.on, "button answers a call");
  send("/cuelight/LX/countdown", "10");
  CHECK(lookIs(P_COUNTDOWN, 255, 80, 0) && oscSt.cdTotal == 10000, "countdown 10 s");
  send("/cuelight/LX/look 1");                     // bad address: has a space -> treated as unknown target
  send("/cuelight/LX/off");
  CHECK(!oscSt.on, "off clears");
  { // look with mixed int/string args, as QLab sends: /cuelight/LX/look 255 160 0 "pulse" 2000 80
    std::ifstream f("packets.txt"); std::string name, hex; std::vector<uint8_t> v;
    while (f >> name >> hex) if (name == "qlab_look") for (size_t i = 0; i < hex.size(); i += 2) v.push_back((uint8_t)std::stoi(hex.substr(i, 2), 0, 16));
    oscParse(v.data(), (int)v.size(), onOsc, nullptr);
    CHECK(lookIs(P_PULSE, 255, 160, 0) && painted.rate == 2000 && painted.lvl == pct255(80), "look r g b pattern speed level from QLab-style args"); }
  // custom triggers, first match wins, arg match, wildcard, clear
  config(R"({"mode":"both","oscName":"LX","oscPort":8000,"ackIp":"192.168.1.20","ackPort":8001,"ackAddr":"/cmd","ackArg":"Go+ Sequence 5","triggers":[
    {"a":"/ma3/exec/201","v":"1","c":"#ffa000","p":"pulse","r":2000,"l":80,"d":0,"k":true},
    {"a":"/ma3/exec/201","v":"0","p":"clear"},
    {"a":"/companion/*/button/?","v":"","c":"#00ffff","p":"strobe","r":250,"l":100,"d":5,"k":false},
    {"a":"/cuelight/LX/go","c":"#ff00ff","p":"spin","r":500,"l":100,"d":2}]})");
  CHECK(nTrig == 4, "4 triggers saved");
  send("/ma3/exec/201", "1");
  CHECK(lookIs(P_PULSE, 255, 160, 0) && painted.lvl == pct255(80), "MA3 exec 201 = 1 -> amber pulse 80%");
  send("/ma3/exec/201", "0");
  CHECK(!oscSt.on, "MA3 exec 201 = 0 -> clear");
  { uint8_t b[64]; int n = oscBuild(b, 64, "/ma3/exec/201", "1.0"); oscParse(b, n, onOsc, nullptr); }
  CHECK(oscSt.on, "float 1.0 matches value 1");
  buttonPressed();
  CHECK(!oscSt.on, "button clears a trigger with Button clears ticked");
  CHECK(!udpSent.empty() && udpSent.back().ip == "192.168.1.20" && udpSent.back().port == 8001, "ack out sent to 192.168.1.20:8001");
  { std::string got; auto &d = udpSent.back().data; oscParse(d.data(), (int)d.size(), [](const char *a, const OscArg *x, int n, void *ctx) { auto *g = (std::string *)ctx; *g = a; if (n) *g += std::string(" ") + x[0].s; }, &got);
    CHECK(got == "/cmd Go+ Sequence 5", "ack out is /cmd \"Go+ Sequence 5\": " + got); }
  send("/companion/page/1/button/4", "1");
  CHECK(lookIs(P_STROBE, 0, 255, 255), "wildcard trigger");
  fakeMillis += 5100;
  CHECK(!oscPaint(millis()), "5 s trigger ends");
  send("/cuelight/LX/go");
  CHECK(lookIs(P_SPIN, 255, 0, 255), "a custom trigger overrides a built-in address");
  CHECK(!strcmp(oscLog[(logHead + OSC_LOG - 1) % OSC_LOG].addr, "/cuelight/LX/go"), "log records the last message");
  // ack-out name substitution
  config(R"({"mode":"both","oscName":"Video","oscPort":8000,"ackIp":"10.0.0.5","ackPort":53000,"ackAddr":"/cuelight/{name}/ack","ackArg":"","triggers":[]})");
  buttonPressed();
  { std::string got; auto &d = udpSent.back().data; oscParse(d.data(), (int)d.size(), [](const char *a, const OscArg *, int, void *ctx) { *(std::string *)ctx = a; }, &got);
    CHECK(got == "/cuelight/Video/ack", "{name} replaced: " + got); }
  // LXFlow-only mode: button acks LXFlow, no OSC out
  size_t before = udpSent.size(); lightMode = M_LXFLOW; linked = true; lxAcks = 0;
  buttonPressed();
  CHECK(lxAcks == 1 && udpSent.size() == before, "LXFlow-only: button goes to LXFlow only");
  lightMode = M_BOTH; buttonPressed();
  CHECK(lxAcks == 2 && udpSent.size() == before + 1, "both: button goes to LXFlow and OSC");
  // mode change asks for a restart; storage limit
  config(R"({"mode":"osc","oscName":"Video","oscPort":8000,"ackIp":"","ackPort":8000,"ackAddr":"","ackArg":"","triggers":[]})");
  CHECK(web.lastSent.find("restart") != std::string::npos, "mode change restarts the light");
  std::string big = R"({"mode":"osc","oscName":"x","oscPort":8000,"ackIp":"","ackPort":8000,"ackAddr":"","ackArg":"","triggers":[)";
  for (int k = 0; k < 24; k++) big += std::string(k ? "," : "") + R"({"a":"/)" + std::string(90, 'a') + std::to_string(10 + k) + R"(","v":")" + std::string(31, 'v') + R"(","c":"#ffffff","p":"countdown","r":1000,"l":100,"d":3600,"k":true})";
  big += "]}";
  config(big.c_str());
  CHECK(web.lastCode == 400 && nTrig == 0, "too many triggers refused, saved set kept (code " + std::to_string(web.lastCode) + ", n " + std::to_string(nTrig) + ", len " + std::to_string(triggersJson().size()) + ")");
  // LXFlow pushes looks
  JsonDocument lk; deserializeJson(lk, R"({"go":{"c":[0,0,255],"p":"pulse","r":2000,"b":200}})");
  storeBuiltinLooks(lk.as<JsonVariantConst>());
  send("/cuelight/all/go");
  CHECK(lookIs(P_PULSE, 0, 0, 255), "built-in go uses the look LXFlow sent");
  // contact inputs (1.3)
  send("/cuelight/all/off");
  gpiSetup();
  CHECK(gpis[0].when == G_OFF && gpis[0].t.dur == 5, "inputs default to off, 5 s");
  config(R"({"mode":"both","oscName":"LX","oscPort":8000,"ackIp":"10.0.0.9","ackPort":8000,"ackAddr":"","ackArg":"","triggers":[],"inputs":[
    {"w":"close","c":"#00ff00","p":"flash","r":500,"l":100,"d":4,"k":false,"a":"/cuelight/{name}/input1","v":"1"},
    {"w":"open","c":"#ff0000","p":"solid","r":1000,"l":50,"d":0,"k":true,"a":"","v":""}]})");
  CHECK(gpis[0].when == G_CLOSE && gpis[1].when == G_OPEN && Preferences::store["gpi"].find("input1") != std::string::npos, "inputs saved");
  auto step = [](int ms) { for (int t = 0; t < ms; t += 10) { fakeMillis += 10; gpiLoop(); } };
  size_t sent0 = udpSent.size();
  pinLevel[32] = LOW; step(20);
  CHECK(!oscSt.on, "input 1: no fire before 30 ms debounce");
  step(30);
  CHECK(lookIs(P_FLASH, 0, 255, 0) && !strcmp(oscSt.what, "input 1"), "input 1 closes -> green flash");
  CHECK(udpSent.size() == sent0 + 1 && udpSent.back().ip == "10.0.0.9", "input 1 sends OSC");
  { std::string got; auto &d = udpSent.back().data; oscParse(d.data(), (int)d.size(), [](const char *a, const OscArg *x, int n, void *ctx) { auto *g = (std::string *)ctx; *g = a; if (n) *g += " " + std::to_string(x[0].i); }, &got);
    CHECK(got == "/cuelight/LX/input1 1", "input OSC is /cuelight/LX/input1 1: " + got); }
  step(2000);
  CHECK(udpSent.size() == sent0 + 1, "held closed: fires once");
  pinLevel[32] = HIGH; step(100); pinLevel[32] = LOW; step(100);
  CHECK(udpSent.size() == sent0 + 2 && oscSt.until == millis() - 60 + 4000, "a new closure restarts the time");
  fakeMillis += 4100;
  CHECK(!oscPaint(millis()), "input look ends after its seconds");
  pinLevel[33] = LOW; step(50);
  CHECK(!oscSt.on, "input 2 set to fire on open: closing does nothing");
  pinLevel[33] = HIGH; step(50);
  CHECK(lookIs(P_SOLID, 255, 0, 0) && painted.lvl == pct255(50) && oscSt.until == 0, "input 2 opens -> red 50%, until cleared");
  CHECK(udpSent.size() == sent0 + 2, "input 2 has no OSC address: nothing sent");
  buttonPressed();
  CHECK(!oscSt.on, "button clears input 2");
  pinLevel[33] = LOW; step(15); pinLevel[33] = HIGH; step(15); pinLevel[33] = LOW; step(15); pinLevel[33] = HIGH; step(50);
  CHECK(!oscSt.on, "contact bounce shorter than 30 ms is ignored");
  lightMode = M_LXFLOW; pinLevel[32] = HIGH; step(50); pinLevel[32] = LOW; step(50);
  CHECK(oscSt.on && udpSent.size() == sent0 + 2, "LXFlow-only: input shows its look, no OSC");
  lightMode = M_BOTH;
  web.body = R"({"what":"input","n":1,"input":{"w":"off","c":"#0000ff","p":"pulse","a":"/test","v":"go"}})"; apiTest();
  CHECK(lookIs(P_PULSE, 0, 0, 255) && web.lastSent.find("\"osc\":true") != std::string::npos, "page Test shows the row and sends its OSC");
  CHECK(!strcmp(oscLog[(logHead + OSC_LOG - 1) % OSC_LOG].addr, "test from this page"), "input events appear in the log");
  { JsonDocument s; gpiState(s); CHECK(s["inputs"][0]["closed"] == true && s["inputs"][0]["pin"] == 32 && s["inputs"][1]["w"] == "open", "state reports pins, closed and settings"); }
  std::cout << (fails ? "FAILED " : "PASSED ") << fails << "\n";
  return fails != 0;
}
