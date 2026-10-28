// Minimal OSC 1.0 reader/writer for the LXFlow cue light. Plain C++ (no Arduino
// types) so it can be unit-tested on a PC. Handles messages and bundles with
// int32 (i), float32 (f), string (s), symbol (S), int64 (h), double (d), True (T),
// False (F), Nil (N) and Impulse (I) arguments: what Companion, grandMA3 and QLab send.
#pragma once
#include <stdint.h>
#include <string.h>
#include <stdio.h>
#include <ctype.h>
#include <stdlib.h>

#define OSC_MAX_ARGS 8

struct OscArg {
  char t;              // OSC type tag
  int32_t i;           // i, T(1), F(0)
  int64_t h;
  double d;            // f and d
  const char *s;       // s and S (points into the packet)
};

typedef void (*OscHandler)(const char *addr, const OscArg *args, int n, void *ctx);

static inline uint32_t oscBe32(const uint8_t *p) { return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3]; }

// Length of an OSC string starting at p (including its NUL and padding), or -1.
static inline int oscStrLen(const uint8_t *p, int avail) {
  for (int k = 0; k < avail; k++) if (p[k] == 0) { int n = (k + 4) & ~3; return n <= avail ? n : -1; }
  return -1;
}

// Parse one packet (a message or a bundle). Calls cb once per message.
// Returns the number of messages delivered, or -1 if the packet is malformed.
static int oscParse(const uint8_t *buf, int len, OscHandler cb, void *ctx, int depth = 0) {
  if (len < 4 || (len & 3) || depth > 4) return -1;
  if (len >= 16 && !memcmp(buf, "#bundle", 8)) {
    int pos = 16, total = 0;                        // "#bundle\0" + 8-byte time tag
    while (pos + 4 <= len) {
      int32_t sz = (int32_t)oscBe32(buf + pos); pos += 4;
      if (sz <= 0 || pos + sz > len) return -1;
      int n = oscParse(buf + pos, sz, cb, ctx, depth + 1);
      if (n < 0) return -1;
      total += n; pos += sz;
    }
    return pos == len ? total : -1;
  }
  if (buf[0] != '/') return -1;
  int al = oscStrLen(buf, len);
  if (al < 0) return -1;
  const char *addr = (const char *)buf;
  OscArg args[OSC_MAX_ARGS];
  int n = 0, pos = al;
  if (pos == len) { cb(addr, args, 0, ctx); return 1; }    // old-style message with no type tags
  if (buf[pos] != ',') return -1;
  int tl = oscStrLen(buf + pos, len - pos);
  if (tl < 0) return -1;
  const char *tags = (const char *)buf + pos + 1;
  pos += tl;
  for (const char *t = tags; *t; t++) {
    OscArg a; memset(&a, 0, sizeof a); a.t = *t;
    switch (*t) {
      case 'i': if (pos + 4 > len) return -1; a.i = (int32_t)oscBe32(buf + pos); a.d = a.i; pos += 4; break;
      case 'f': { if (pos + 4 > len) return -1; uint32_t u = oscBe32(buf + pos); float f; memcpy(&f, &u, 4); a.d = f; a.i = (int32_t)f; pos += 4; break; }
      case 'h': { if (pos + 8 > len) return -1; a.h = ((int64_t)oscBe32(buf + pos) << 32) | oscBe32(buf + pos + 4); a.d = (double)a.h; a.i = (int32_t)a.h; pos += 8; break; }
      case 'd': { if (pos + 8 > len) return -1; uint64_t u = ((uint64_t)oscBe32(buf + pos) << 32) | oscBe32(buf + pos + 4); double d; memcpy(&d, &u, 8); a.d = d; a.i = (int32_t)d; pos += 8; break; }
      case 's': case 'S': { int sl = oscStrLen(buf + pos, len - pos); if (sl < 0) return -1; a.s = (const char *)buf + pos; pos += sl; break; }
      case 'T': a.i = 1; a.d = 1; break;
      case 'F': case 'N': case 'I': break;
      case 'b': { if (pos + 4 > len) return -1; int32_t bl = (int32_t)oscBe32(buf + pos); pos += 4 + ((bl + 3) & ~3); if (bl < 0 || pos > len) return -1; break; }
      default: return -1;                            // unknown type: can't know its size
    }
    if (n < OSC_MAX_ARGS) args[n++] = a;
  }
  cb(addr, args, n, ctx);
  return 1;
}

// Text form of an argument, for matching a trigger's value: 1, 0.5, "go", T -> 1, F -> 0.
static inline void oscArgText(const OscArg &a, char *out, int cap) {
  switch (a.t) {
    case 's': case 'S': snprintf(out, cap, "%s", a.s); break;
    case 'i': case 'T': case 'F': snprintf(out, cap, "%d", (int)a.i); break;
    case 'h': snprintf(out, cap, "%lld", (long long)a.h); break;
    case 'f': case 'd': {
      double d = a.d;
      if (d == (double)(long long)d) snprintf(out, cap, "%lld", (long long)d);
      else { snprintf(out, cap, "%.4f", d); char *e = out + strlen(out) - 1; while (*e == '0') *e-- = 0; }
      break;
    }
    default: if (cap) out[0] = 0;
  }
}

// Case-insensitive glob: '*' matches any run of characters, '?' one character.
static inline bool oscGlob(const char *pat, const char *s) {
  const char *star = 0, *ss = 0;
  while (*s) {
    if (*pat == '*') { star = pat++; ss = s; continue; }
    if (*pat && (*pat == '?' || tolower((unsigned char)*pat) == tolower((unsigned char)*s))) { pat++; s++; continue; }
    if (star) { pat = star + 1; s = ++ss; continue; }
    return false;
  }
  while (*pat == '*') pat++;
  return !*pat;
}

// Split "/cuelight/<target>/<command>" into target and command; false if it isn't one.
static inline bool oscSplitCuelight(const char *addr, char *target, int tcap, char *cmd, int ccap) {
  const char *p = "/cuelight/";
  for (int k = 0; p[k]; k++) if (tolower((unsigned char)addr[k]) != p[k]) return false;
  const char *t = addr + 10, *slash = strchr(t, '/');
  if (!slash || slash == t || !slash[1] || strchr(slash + 1, '/')) return false;
  int tl = (int)(slash - t); if (tl >= tcap) return false;
  memcpy(target, t, tl); target[tl] = 0;
  snprintf(cmd, ccap, "%s", slash + 1);
  for (char *c = cmd; *c; c++) *c = (char)tolower((unsigned char)*c);
  return true;
}

// Build one OSC message. The argument is sent as int if it looks like an integer, float if it
// looks like a number, string otherwise; an empty argument sends no arguments.
// Returns the packet length, or 0 if it doesn't fit.
static inline int oscBuild(uint8_t *out, int cap, const char *addr, const char *arg) {
  int al = (int)strlen(addr), pos = 0;
  int need = ((al + 4) & ~3) + 4 + (arg && *arg ? 4 + (int)strlen(arg) + 4 : 0);
  if (need > cap || addr[0] != '/') return 0;
  memset(out, 0, need);
  memcpy(out, addr, al); pos = (al + 4) & ~3;
  if (!arg || !*arg) { out[pos] = ','; return pos + 4; }
  char *end = 0;
  long iv = strtol(arg, &end, 10);
  bool isInt = end && !*end;
  double dv = strtod(arg, &end);
  bool isNum = end && !*end;
  out[pos] = ','; out[pos + 1] = isInt ? 'i' : isNum ? 'f' : 's'; pos += 4;
  if (isInt || isNum) {
    uint32_t u;
    if (isInt) u = (uint32_t)(int32_t)iv; else { float f = (float)dv; memcpy(&u, &f, 4); }
    out[pos] = u >> 24; out[pos + 1] = u >> 16; out[pos + 2] = u >> 8; out[pos + 3] = u; pos += 4;
  } else {
    int sl = (int)strlen(arg); memcpy(out + pos, arg, sl); pos += (sl + 4) & ~3;
  }
  return pos;
}
