// SparkBlynk.h — a Blynk-compatible IoT library for the Sparklab simulator (client-side, backend=0).
//
// The sketch uses the SAME idioms as the real Blynk library — Blynk.begin(auth), Blynk.run(),
// Blynk.virtualWrite(Vn, value), and BLYNK_WRITE(Vn){ ... param.asInt() ... } — but the transport is
// the simulator's network MMIO talking to Blynk's HTTP Device API (https://blynk.cloud/external/api/…),
// which is CORS-readable from the browser. A real Blynk auth token in the sketch makes data appear on
// your real Blynk dashboard and commands from the Blynk app drive the firmware — like real hardware,
// without the gateway the binary-protocol library would need (browsers can't open raw TCP — Wokwi uses
// a gateway for that reason; here we use HTTP instead, so no server).
//
// Declarations MUST match the definitions in the sim-runtime shim (esp32c3-arduino-sim.cpp) so the
// mangled C++ symbols link. State lives in the runtime (the methods never dereference `this`).
#ifndef SPARKBLYNK_H
#define SPARKBLYNK_H

// Virtual-pin tokens V0..V31 (mirrors Blynk's Vn constants). BLYNK_WRITE(V0) / virtualWrite(V0, x).
#define V0 0
#define V1 1
#define V2 2
#define V3 3
#define V4 4
#define V5 5
#define V6 6
#define V7 7
#define V8 8
#define V9 9
#define V10 10
#define V11 11
#define V12 12
#define V13 13
#define V14 14
#define V15 15

// The value delivered to a BLYNK_WRITE handler (the dashboard widget's current value).
class BlynkParam {
 public:
  long asInt() const;        // the widget value as an integer (button 0/1, slider 0..N)
  long asLong() const;       // same as asInt(), for code that uses asLong()
  float asFloat() const;     // the value as a float (slider/gauge with decimals)
  double asDouble() const;   // the value as a double
  const char *asStr() const; // the raw value string (for text/terminal widgets)
  const char *_raw;          // points at the value string the runtime fetched (internal)
};

// One registered virtual-pin handler (placed in the `blynk_handlers` link section — no global ctors).
struct BlynkHandler {
  int vpin;
  void (*fn)(BlynkParam param);
};
// One registered BLYNK_CONNECTED handler (its own `blynk_connected` link section).
struct BlynkConnectHandler {
  void (*fn)();
};

// BLYNK_WRITE(Vn){ ... } — define a handler for dashboard writes to virtual pin Vn. The handler is
// registered by emitting a BlynkHandler into the `blynk_handlers` section; Blynk.run() iterates it.
// `retain` sets SHF_GNU_RETAIN so the linker's --gc-sections (lld default -z start-stop-gc) keeps the
// entry even though it's only reached through __start_/__stop_blynk_handlers; `used` keeps the compiler
// from dropping it. Both are needed.
#define BLYNK_WRITE(vp)                                                       \
  static void _blynkWrite_##vp(BlynkParam param);                            \
  __attribute__((used, retain, section("blynk_handlers")))                   \
  static const BlynkHandler _blynkReg_##vp = {(vp), _blynkWrite_##vp};       \
  static void _blynkWrite_##vp(BlynkParam param)

// BLYNK_CONNECTED(){ ... } — runs once the device session is established (real sketches sync widget state
// here via Blynk.syncVirtual). Registered into the `blynk_connected` link section, like BLYNK_WRITE.
#define BLYNK_CONNECTED()                                                     \
  static void _blynkConnected();                                             \
  __attribute__((used, retain, section("blynk_connected")))                  \
  static const BlynkConnectHandler _blynkConnReg = {_blynkConnected};        \
  static void _blynkConnected()

class BlynkSim {
 public:
  // Connect: WiFi must already be up (call WiFi.begin first), then Blynk.begin(auth). The 3-arg form
  // also joins the virtual WiFi for you (auth, ssid, pass) — like the real Blynk.begin overload.
  void begin(const char *auth);
  void begin(const char *auth, const char *ssid, const char *pass);
  void config(const char *auth);  // alias for begin(auth)
  void run();                      // poll the registered virtual pins; dispatch BLYNK_WRITE handlers
  bool connected();                // true once the (virtual) WiFi link Blynk runs over is up
  void virtualWrite(int vpin, int value);
  void virtualWrite(int vpin, long value);
  void virtualWrite(int vpin, float value);
  void virtualWrite(int vpin, double value);
  void virtualWrite(int vpin, const char *value);
  void syncVirtual(int vpin);  // pull V<n> from the dashboard now and fire its BLYNK_WRITE
  void syncAll();              // pull all registered virtual pins now
};

extern BlynkSim Blynk;

#endif  // SPARKBLYNK_H
