/*
  Output stage (firmware 1.4): runs on every frame just before the LEDs update, for every
  look, OSC and Art-Net alike.
    gamma    a 2.2 curve, so fades look even (on by default). Any lit channel stays at
             least 1, so dim looks never vanish.
    dither   temporal dithering: alternates between neighbouring levels so the low end
             gets finer steps than 8 bits (off by default; can flicker on camera).
    bright   the light's brightness setting, applied here in 16 bits instead of by the
             NeoPixel library, so it no longer throws away steps before gamma.
  Works on the raw pixel buffer, so it doesn't care about colour order.
*/

#define GAMMA 2.2f
uint16_t gammaLut[256];
uint16_t ditherErr[MAX_LEDS * 3];               // remainder, 0..256

void buildGamma() {
  for (int v = 0; v < 256; v++) gammaLut[v] = (uint16_t)lroundf(powf(v / 255.0f, GAMMA) * 65535.0f);
}

void showOut() {
  uint8_t *px = ring.getPixels();                  // brightness is 255 in render(), so unscaled
  uint16_t n = ring.numPixels() * 3;
  for (uint16_t i = 0; i < n; i++) {
    uint8_t v = px[i];
    if (!v) { ditherErr[i] = 0; continue; }
    uint32_t o = (uint32_t)(useGamma ? gammaLut[v] : v * 257u) * bright / 255;   // 0..65535
    if (useDither) {
      o += ditherErr[i];
      uint32_t q = o / 257;                          // 16-bit back to 8-bit: 65535 / 257 = 255
      ditherErr[i] = o - q * 257;
      px[i] = q > 255 ? 255 : q;
    } else {
      o = (o + 128) / 257;
      px[i] = o ? (o > 255 ? 255 : o) : 1;
    }
  }
  ring.show();
}
