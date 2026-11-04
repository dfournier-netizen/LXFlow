#define ARDUINOJSON_ENABLE_ARDUINO_STRING 0
#define ARDUINOJSON_ENABLE_STD_STRING 1
#include "shim.h"
#include <ArduinoJson.h>
#include "../LXFlowCueLight/osc_core.h"
#include <iostream>
#include <fstream>
// --- the pieces of LXFlowCueLight.ino that osc.ino uses ---
#define FW_VERSION "1.4.0"
enum Pat : uint8_t { P_SOLID, P_FLASH, P_PULSE, P_DBLINK, P_SPIN, P_STROBE, P_COUNTDOWN, P_DOT, P_OFF };
struct Look { uint8_t r, g, b; uint8_t pat; uint16_t rate; uint8_t lvl; };
enum Mode : uint8_t { M_LXFLOW, M_OSC, M_BOTH, M_ARTNET };
enum Builtin : uint8_t { B_STANDBY, B_ACKED, B_GO, B_HOLD, B_CALL, B_PLACES, B_STOP, B_WARNING, B_COUNTDOWN, B_IDLE, B_N };
struct Trig { char addr[96]; char val[32]; Look look; bool clear; uint16_t dur; bool btnClears; };
uint8_t lightMode = M_BOTH; char oscName[24] = ""; uint16_t oscPort = 8000;
Preferences prefs; String deviceId = "A1B2C3D4E5F6", apName = "LXFlow-CueLight-E5F6";
const Look IDLE_LOOK = { 255, 255, 255, P_DOT, 1000, 25 };
bool linked = false; IPAddress serverIp; uint16_t serverPort = 7390; uint32_t identUntil = 0;
int lxAcks = 0;
#define MAX_LEDS 170
#define NEO_GRB 0
#define NEO_RGB 1
#define NEO_RBG 2
#define NEO_GBR 3
#define NEO_BRG 4
#define NEO_BGR 5
bool useGamma = true, useDither = false;
uint16_t ledCount = 12; uint8_t colorOrder = 0; uint32_t rgbTestUntil = 0; char cfgLeds[4] = "12";
const char *ORDER_NAMES[] = { "grb", "rgb", "rbg", "gbr", "brg", "bgr" };
int configSaves = 0; void saveConfig() { configSaves++; }
struct Ring { uint32_t px[MAX_LEDS]; void clear() { memset(px, 0, sizeof px); }
  uint32_t Color(uint8_t r, uint8_t g, uint8_t b) { return (uint32_t)r << 16 | g << 8 | b; }
  void setPixelColor(uint16_t i, uint32_t c) { if (i < MAX_LEDS) px[i] = c; } } ring;
uint8_t patFromName(const char *p) { static const char *n[] = { "solid","flash","pulse","dblink","spin","strobe","countdown","dot","off" }; for (uint8_t i = 0; i < 9; i++) if (!strcmp(p, n[i])) return i; return P_SOLID; }
Look lookFrom(JsonVariantConst v) { Look L = IDLE_LOOK; L.r = v["c"][0] | 0; L.g = v["c"][1] | 0; L.b = v["c"][2] | 0; L.pat = patFromName(v["p"] | "solid"); L.rate = constrain((int)(v["r"] | 1000), 100, 5000); L.lvl = constrain((int)(v["b"] | 255), 1, 255); return L; }
void sendJson(JsonDocument &) { lxAcks++; }
Look painted; bool paintedSet = false;
void paintCd(const Look &L, uint32_t, uint32_t, uint32_t) { painted = L; paintedSet = true; }
// forward declarations Arduino would generate
void oscClear(); bool oscPaint(uint32_t); void onOsc(const char *, const OscArg *, int, void *); void buttonPressed(); void loadOscConfig(); void apiConfig(); bool sendAckOut();
const char *shortId(); void apiTest();
#include "../LXFlowCueLight/artnet.ino"
#include "../LXFlowCueLight/osc.ino"
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
  // ---- pixel count and colour order (1.4) ----
  const char *base = R"("oscName":"LX","oscPort":8000,"ackIp":"","ackPort":8000,"ackAddr":"","ackArg":"","triggers":[])";
  config((std::string(R"({"mode":"osc","leds":60,"order":"rgb",)") + base + "}").c_str());
  CHECK(ledCount == 60 && colorOrder == 1 && !strcmp(cfgLeds, "60") && Preferences::store["order"] == "1", "pixels 60 + RGB order saved (same key as the setup portal)");
  CHECK(web.lastSent.find("restart") != std::string::npos, "pixel count change restarts the light");
  config((std::string(R"({"mode":"osc","leds":999,"order":"nope",)") + base + "}").c_str());
  CHECK(ledCount == 170 && colorOrder == 1, "pixels capped at 170; unknown order ignored");
  { JsonDocument s; web.body = ""; apiState(); deserializeJson(s, web.lastSent); CHECK(s["leds"] == 170 && s["maxLeds"] == 170 && s["order"] == "rgb", "state reports pixels, max and order"); }
  web.body = R"({"what":"rgb"})"; apiTest();
  CHECK(rgbTestUntil > millis(), "colour check runs from the page");
  { size_t was = web.lastSent.size(); (void)was;
    config((std::string(R"({"mode":"osc","leds":170,"order":"rgb","gamma":false,"dither":true,)") + base + "}").c_str());
    CHECK(!useGamma && useDither && Preferences::store.count("gamma") && web.lastSent.find("restart") == std::string::npos, "gamma off + dither on saved, live (no restart)");
    JsonDocument s; web.body = ""; apiState(); deserializeJson(s, web.lastSent); CHECK(s["gamma"] == false && s["dither"] == true, "state reports gamma and dither");
    config((std::string(R"({"mode":"osc","leds":170,"order":"rgb","gamma":true,"dither":false,)") + base + "}").c_str()); }
  // ---- Art-Net (1.4) ----
  std::map<std::string, std::vector<uint8_t>> pk;
  { std::ifstream f("artnet_packets.txt"); std::string name, hex; while (f >> name >> hex) { std::vector<uint8_t> v; for (size_t i = 0; i < hex.size(); i += 2) v.push_back((uint8_t)std::stoi(hex.substr(i, 2), 0, 16)); pk[name] = v; } }
  CHECK(pk.size() == 3, "ArtDmx packets from stupidArtnet loaded");
  ledCount = 12;
  config((std::string(R"({"mode":"artnet","leds":12,"order":"grb","artUni":17,"artAddr":10,"artHold":3,)") + base + "}").c_str());
  CHECK(lightMode == M_ARTNET && artUni == 17 && artAddr == 10 && Preferences::store["auni"] == "17", "Art-Net mode, universe 17, address 10 saved");
  oscUp = false; oscSetup();
  CHECK(!oscUp, "OSC listener stays closed in Art-Net mode");
  artSetup();
  CHECK(artUp && !artPaint(millis()), "Art-Net port open; idle before data");
  udpInbox[6454].push_back(pk["dmx_u300"]); artLoop();
  CHECK(!artHave, "other universe (300) ignored");
  udpInbox[6454].push_back(pk["dmx_u17"]); artLoop();
  CHECK(artPaint(millis()), "universe 17 received");
  { bool ok = true; for (int i = 0; i < 36; i++) { int ch = 9 + i; uint8_t want = (ch * 7) % 256; uint32_t c = ring.px[i / 3]; uint8_t got = (c >> (16 - 8 * (i % 3))) & 255; if (got != want) ok = false; }
    CHECK(ok && ring.px[12] == 0, "12 pixels = channels 10-45 as R,G,B; pixel 13 dark"); }
  fakeMillis += 2500;
  CHECK(artPaint(millis()) && !strcmp(artShowing(), "Art-Net (holding last frame)"), "holds the last frame within 3 s");
  fakeMillis += 600;
  CHECK(!artPaint(millis()) && !artHave, "after the hold time, back to idle");
  { auto late = pk["dmx_u17"]; late[12] = 50; auto early = late; early[12] = 40; early[18 + 9] = 1;
    udpInbox[6454].push_back(late); udpInbox[6454].push_back(early); artLoop();
    CHECK((ring.px[0] = 0, artPaint(millis()), ((ring.px[0] >> 16) & 255) == 63), "a late (older sequence) packet is dropped"); }
  ledCount = 170; artAddr = 1;
  udpInbox[6454].push_back(pk["dmx_u17_short"]); artLoop(); artPaint(millis());
  CHECK(ring.px[7] == 0xC8C8C8 && ring.px[8] == 0, "short packet (24 ch): 8 pixels lit, the rest dark");
  udpInbox[6454].push_back(pk["dmx_u17"]); artLoop(); artPaint(millis());
  { uint8_t want = (509 * 7) % 256; CHECK((ring.px[169] & 255) == want, "170 pixels use channels 1-510"); }
  // ArtPoll -> ArtPollReply
  { const uint8_t poll[14] = { 'A','r','t','-','N','e','t',0, 0x00,0x20, 0,14, 0,0 };
    size_t before = udpSent.size(); udpInbox[6454].push_back(std::vector<uint8_t>(poll, poll + 14)); artLoop();
    CHECK(udpSent.size() == before + 1, "ArtPoll answered");
    auto &r = udpSent.back().data;
    CHECK(udpSent.back().ip == "192.168.1.50" && udpSent.back().port == 6454, "reply unicast to the poller on 6454");
    CHECK(r.size() == 239 && !memcmp(r.data(), "Art-Net", 8) && r[8] == 0x00 && r[9] == 0x21, "239-byte ArtPollReply, OpCode 0x2100");
    CHECK(r[10] == 192 && r[13] == 77 && r[14] == 0x36 && r[15] == 0x19, "IP and port 6454 in the reply");
    CHECK(r[18] == 0 && r[19] == 1 && r[190] == 1 && r[174] == 0x80, "universe 17 = Net 0, Sub-Net 1, SwOut 1; one DMX output port");
    CHECK(!strcmp((const char *)&r[26], "LXFlow CL E5F6") && !strncmp((const char *)&r[44], "LXFlow Cue Light E5F6 LX", 64), "short and long names");
    CHECK(r[201] == 0xA1 && r[206] == 0xF6 && r[207] == 192 && r[212] == 0x0F, "MAC, BindIp, Status2"); }
  { JsonDocument s; web.body = ""; apiState(); deserializeJson(s, web.lastSent); CHECK(s["mode"] == "artnet" && s["art"]["uni"] == 17 && s["art"]["live"] == "receiving" && s["art"]["polls"] == 1, "state reports Art-Net status"); }
  lightMode = M_ARTNET; size_t b2 = udpSent.size(); strcpy(ackIp, "10.0.0.5"); strcpy(ackAddr, "/ack"); buttonPressed();
  CHECK(udpSent.size() == b2 + 1, "button still sends its OSC in Art-Net mode");
  std::cout << (fails ? "FAILED " : "PASSED ") << fails << "\n";
  return fails != 0;
}
