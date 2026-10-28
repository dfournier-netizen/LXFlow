// Just enough Arduino to run osc.ino's (and trigger_inputs.ino's) logic on a PC.
#pragma once
#include <string>
#include <map>
#include <vector>
#include <cstring>
#include <cstdio>
#include <cstdint>
#include <strings.h>
#include <algorithm>
static uint32_t fakeMillis = 1000;
static inline uint32_t millis() { return fakeMillis; }
template <class T, class A, class B> T constrain(T v, A lo, B hi) { return v < (T)lo ? (T)lo : v > (T)hi ? (T)hi : v; }
struct String : std::string {
  String() {} String(const char *s) : std::string(s ? s : "") {} String(const std::string &s) : std::string(s) {}
  explicit String(int v) : std::string(std::to_string(v)) {} explicit String(unsigned v) : std::string(std::to_string(v)) {}
  void toLowerCase() { for (auto &c : *this) c = (char)tolower(c); }
  size_t write(uint8_t c) { push_back((char)c); return 1; }
  size_t write(const uint8_t *d, size_t n) { append((const char *)d, n); return n; }
  String operator+(const String &o) const { return String(std::string(*this) + std::string(o)); }
  String operator+(const char *o) const { return String(std::string(*this) + o); }
};
struct IPAddress {
  uint8_t b[4] = {0, 0, 0, 0};
  IPAddress() {} IPAddress(int a, int c, int d, int e) { b[0] = a; b[1] = c; b[2] = d; b[3] = e; }
  bool fromString(const char *s) { int a, c, d, e; if (sscanf(s, "%d.%d.%d.%d", &a, &c, &d, &e) != 4) return false; *this = IPAddress(a, c, d, e); return true; }
  String toString() const { char t[16]; snprintf(t, 16, "%d.%d.%d.%d", b[0], b[1], b[2], b[3]); return String(t); }
};
#define INPUT_PULLUP 5
#define LOW 0
#define HIGH 1
static int pinLevel[40];
static inline void pinMode(int p, int) { pinLevel[p] = HIGH; }
static inline int digitalRead(int p) { return pinLevel[p]; }
static inline void delayMicroseconds(int) {}
struct SerialT { void println(const char *) {} template <class... A> void printf(const char *, A...) {} } Serial;
struct Sent { std::string ip; int port; std::vector<uint8_t> data; };
static std::vector<Sent> udpSent;
struct WiFiUDP {
  std::string ip; int port = 0; std::vector<uint8_t> buf;
  bool begin(int) { return true; } void stop() {} void clear() {}
  int parsePacket() { return 0; } int read(uint8_t *, int) { return 0; }
  IPAddress remoteIP() { return IPAddress(192, 168, 1, 50); }
  bool beginPacket(IPAddress i, int p) { ip = i.toString(); port = p; buf.clear(); return true; }
  void write(const uint8_t *d, int n) { buf.insert(buf.end(), d, d + n); }
  bool endPacket() { udpSent.push_back({ip, port, buf}); return true; }
};
struct Preferences {
  static std::map<std::string, std::string> store;
  void begin(const char *, bool) {} void end() {}
  bool isKey(const char *k) { return store.count(k); }
  size_t getBytesLength(const char *k) { return store.count(k) ? store[k].size() : 0; }
  size_t getBytes(const char *k, void *o, size_t n) { memcpy(o, store[k].data(), n); return n; }
  size_t putBytes(const char *k, const void *d, size_t n) { store[k] = std::string((const char *)d, n); return n; }
  size_t getString(const char *k, char *o, size_t n) { if (store.count(k)) snprintf(o, n, "%s", store[k].c_str()); return 0; }
  String getString(const char *k, const char *def) { return String(store.count(k) ? store[k].c_str() : def); }
  size_t putString(const char *k, const String &v) { store[k] = v; return v.size(); }
  size_t putString(const char *k, const char *v) { store[k] = v; return strlen(v); }
  uint8_t getUChar(const char *k, uint8_t d) { return store.count(k) ? (uint8_t)std::stoi(store[k]) : d; }
  void putUChar(const char *k, uint8_t v) { store[k] = std::to_string(v); }
  uint16_t getUShort(const char *k, uint16_t d) { return store.count(k) ? (uint16_t)std::stoi(store[k]) : d; }
  void putUShort(const char *k, uint16_t v) { store[k] = std::to_string(v); }
};
std::map<std::string, std::string> Preferences::store;
#define HTTP_GET 0
#define HTTP_POST 1
struct WebServer {
  WebServer(int) {} std::string body, lastSent; int lastCode = 0;
  template <class F> void on(const char *, int, F) {} template <class F> void onNotFound(F) {}
  void begin() {} void stop() {} void handleClient() {}
  String arg(const char *) { return String(body); }
  void send(int c, const char *, const char *s) { lastCode = c; lastSent = s; }
  void send(int c, const char *, const String &s) { lastCode = c; lastSent = s; }
};
struct { bool begin(const char *) { return true; } void addService(const char *, const char *, int) {} } MDNS;
struct { IPAddress localIP() { return IPAddress(192, 168, 1, 77); } int RSSI() { return -50; } } WiFi;
struct { [[noreturn]] void restart() { throw 1; } } ESP;
