#include "../LXFlowCueLight/osc_core.h"
#include <map>
#include <string>
#include <vector>
#include <fstream>
#include <sstream>
#include <cassert>
#include <iostream>
static std::string got;
static void cb(const char *addr, const OscArg *a, int n, void *) {
  got += addr; got += "(";
  for (int k = 0; k < n; k++) { char t[64]; oscArgText(a[k], t, sizeof t); got += (k ? "," : ""); got += a[k].t; got += ":"; got += t; }
  got += ")";
}
static std::vector<uint8_t> hex(const std::string &h) { std::vector<uint8_t> v; for (size_t i = 0; i < h.size(); i += 2) v.push_back((uint8_t)std::stoi(h.substr(i, 2), 0, 16)); return v; }
int fails = 0;
#define CHECK(c, m) do { if (!(c)) { std::cout << "FAIL " << m << "\n"; fails++; } else std::cout << "ok   " << m << "\n"; } while (0)
int main() {
  std::ifstream f("packets.txt"); std::string name, h;
  std::map<std::string, std::string> res;
  while (f >> name >> h) { auto v = hex(h); got.clear(); int r = oscParse(v.data(), (int)v.size(), cb, 0); res[name] = std::to_string(r) + " " + got; }
  CHECK(res["companion_noargs"] == "1 /cuelight/LX/go()", "Companion, no args: " + res["companion_noargs"]);
  CHECK(res["companion_int"] == "1 /cuelight/all/standby(i:1)", "int arg: " + res["companion_int"]);
  CHECK(res["ma3_int"] == "1 /ma3/exec/201(i:1)", "MA3 int: " + res["ma3_int"]);
  CHECK(res["ma3_float"] == "1 /ma3/fader/201(f:0.5)", "MA3 float: " + res["ma3_float"]);
  CHECK(res["ma3_string"] == "1 /cmd(s:Go+ Sequence 5)", "MA3 string: " + res["ma3_string"]);
  CHECK(res["qlab_look"] == "1 /cuelight/LX/look(i:255,i:160,i:0,s:pulse,i:2000,i:80)", "look args: " + res["qlab_look"]);
  CHECK(res["qlab_true"] == "1 /cue/5/go(T:1)", "True: " + res["qlab_true"]);
  CHECK(res["qlab_false"] == "1 /cue/5/go(F:0)", "False: " + res["qlab_false"]);
  CHECK(res["double"] == "1 /x(d:2.25)", "double: " + res["double"]);
  CHECK(res["int64"] == "1 /x(h:5)", "int64: " + res["int64"]);
  CHECK(res["nil"] == "1 /x(N:)", "nil: " + res["nil"]);
  CHECK(res["bundle"] == "2 /cuelight/LX/hold()/cuelight/Video/call()", "bundle: " + res["bundle"]);
  // malformed
  { uint8_t bad[] = {'/','x',0,0,',','i',0,0,0,0}; got.clear(); CHECK(oscParse(bad, 10, cb, 0) == -1, "truncated int rejected"); }
  { uint8_t bad[] = {'/','x','y','z'}; got.clear(); CHECK(oscParse(bad, 4, cb, 0) == -1, "unterminated address rejected"); }
  { uint8_t bad[] = {'x',0,0,0}; CHECK(oscParse(bad, 4, cb, 0) == -1, "non-OSC rejected"); }
  // glob
  CHECK(oscGlob("/ma3/exec/*", "/ma3/exec/201"), "glob *");
  CHECK(oscGlob("/MA3/Exec/2?1", "/ma3/exec/201"), "glob ? and case");
  CHECK(!oscGlob("/ma3/exec/202", "/ma3/exec/201"), "glob mismatch");
  CHECK(oscGlob("*", "/anything/at/all"), "glob all");
  CHECK(oscGlob("/a/*/go", "/a/b/c/go"), "* spans segments");
  // split
  char t[24], c[24];
  CHECK(oscSplitCuelight("/cuelight/LX/go", t, 24, c, 24) && !strcmp(t, "LX") && !strcmp(c, "go"), "split");
  CHECK(oscSplitCuelight("/CueLight/all/Standby", t, 24, c, 24) && !strcmp(c, "standby"), "split case");
  CHECK(!oscSplitCuelight("/cuelight/LX", t, 24, c, 24), "split needs a command");
  CHECK(!oscSplitCuelight("/cuelight/LX/go/x", t, 24, c, 24), "split rejects extra segments");
  // build -> parse round trips
  uint8_t out[128]; int n;
  n = oscBuild(out, 128, "/cuelight/LX/ack", ""); got.clear(); oscParse(out, n, cb, 0); CHECK(got == "/cuelight/LX/ack()", "build no arg: " + got);
  n = oscBuild(out, 128, "/location/1/0/1/press", "1"); got.clear(); oscParse(out, n, cb, 0); CHECK(got == "/location/1/0/1/press(i:1)", "build int (Companion): " + got);
  n = oscBuild(out, 128, "/cmd", "Go+ Sequence 5"); got.clear(); oscParse(out, n, cb, 0); CHECK(got == "/cmd(s:Go+ Sequence 5)", "build string (MA3 /cmd): " + got);
  n = oscBuild(out, 128, "/x", "0.5"); got.clear(); oscParse(out, n, cb, 0); CHECK(got == "/x(f:0.5)", "build float: " + got);
  { std::ofstream o("built.hex"); n = oscBuild(out, 128, "/cmd", "Go+ Sequence 5"); for (int k = 0; k < n; k++) { char b[3]; snprintf(b, 3, "%02x", out[k]); o << b; } }
  CHECK(oscBuild(out, 8, "/a/long/address", "") == 0, "build refuses overflow");
  std::cout << (fails ? "FAILED " : "PASSED ") << fails << "\n";
  return fails ? 1 : 0;
}
