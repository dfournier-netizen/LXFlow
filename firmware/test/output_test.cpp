// Checks output.ino (gamma, brightness, dithering) on a PC.
// g++ -std=c++17 -o output_test output_test.cpp && ./output_test
#include <cstdint>
#include <cstring>
#include <cmath>
#include <iostream>
#define MAX_LEDS 170
struct Ring { uint8_t buf[MAX_LEDS * 3]; uint16_t n = 1; int shows = 0;
  uint8_t *getPixels() { return buf; } uint16_t numPixels() const { return n; } void show() { shows++; } } ring;
uint8_t bright = 255; bool useGamma = true, useDither = false;
#include "../LXFlowCueLight/output.ino"
int fails = 0;
#define CHECK(c, m) do { if (!(c)) { std::cout << "FAIL " << m << "\n"; fails++; } else std::cout << "ok   " << m << "\n"; } while (0)
uint8_t out(uint8_t v) { ring.buf[0] = v; showOut(); return ring.buf[0]; }
int main() {
  buildGamma();
  CHECK(gammaLut[0] == 0 && gammaLut[255] == 65535, "gamma table ends at 0 and 65535");
  CHECK(std::abs(gammaLut[128] - 14386) <= 2, "gamma 2.2: input 128 -> 22% (" + std::to_string(gammaLut[128]) + ")");
  CHECK(out(255) == 255 && out(0) == 0, "full stays full, zero stays zero");
  CHECK(out(128) == 56, "gamma: 128 -> 56 (" + std::to_string(out(128)) + ")");
  CHECK(out(1) == 1 && out(10) == 1, "gamma: dim values never vanish (minimum 1)");
  useGamma = false;
  bool lin = true; for (int v = 1; v < 256; v++) if (out(v) != v) lin = false;
  CHECK(lin, "gamma off, brightness 255: output = input");
  bright = 80;
  CHECK(out(255) == 80 && out(128) == 40, "gamma off, brightness 80: 255 -> 80, 128 -> 40");
  useGamma = true;
  CHECK(out(255) == 80, "gamma on, brightness 80: full -> 80");
  bright = 255; useDither = true; memset(ditherErr, 0, sizeof ditherErr);
  int ones = 0; for (int f = 0; f < 257; f++) ones += out(10);
  uint32_t want = gammaLut[10];   // 16-bit target; over 257 frames the outputs sum to it
  CHECK(std::abs(ones - (int)want) <= 1, "dither: 257 frames sum to the 16-bit target (" + std::to_string(ones) + " vs " + std::to_string(want) + ")");
  int sum = 0; for (int f = 0; f < 257; f++) sum += out(128);
  CHECK(std::abs(sum - (int)gammaLut[128]) <= 1, "dither: mid level averages exactly (" + std::to_string(sum) + " vs " + std::to_string(gammaLut[128]) + ")");
  useDither = false; bright = 255;
  bool mono = true; int prev = 0; for (int v = 1; v < 256; v++) { int o = out(v); if (o < prev) mono = false; prev = o; }
  CHECK(mono, "gamma output never steps backwards");
  useDither = true;
  CHECK(out(255) == 255, "dither: full stays full");
  ring.n = 2; ring.buf[3] = 0; showOut();
  CHECK(ring.buf[3] == 0 && ditherErr[3] == 0, "dark channels stay dark and reset their error");
  std::cout << (fails ? "FAILED " : "PASSED ") << fails << "\n";
  return fails != 0;
}
