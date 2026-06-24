/*
 * ESP32-C3 Arduino "simulation build profile" runtime (REFERENCE-SPEC Stage 4 §22).
 *
 * Provides the Arduino HAL (pinMode / digitalWrite / delay / millis ...) backed by emulator
 * MMIO, plus a crt0 that calls the sketch's setup()/loop(). The user's sketch is compiled
 * UNCHANGED against the real arduino-esp32 headers and linked against THIS shim instead of
 * the full IDF — the API -> HAL bridge first; full-MMIO/firmware emulation comes later
 * (doctrine: API -> HAL -> MMIO). Built freestanding for rv32imc.
 *
 * Linkage matters: the arduino-esp32 headers declare pinMode/digitalWrite/delay/millis as
 * `extern "C"`, so we DEFINE them in an extern "C" block (unmangled symbols). setup()/loop()
 * are the user's C++ functions, so we REFERENCE them with C++ linkage (mangled _Z5setupv /
 * _Z4loopv). _start is the linker entry, kept unmangled.
 *
 * MMIO contract (matches packages/emulators/src/esp32c3-soc.ts):
 *   GPIO  block @ 0x60004000  (W1TS/W1TC output set/clear, enable, input)
 *   timer block @ 0x60010000  (millis @ +0, micros @ +4) — virtual-time, cycle-derived
 */

// clang.wasm ships no builtin-header resource dir; rv32 ilp32 makes these exact.
typedef unsigned char uint8_t;
typedef unsigned int uint32_t;

#define GPIO_BASE 0x60004000u
#define GPIO_OUT_W1TS (*(volatile uint32_t *)(GPIO_BASE + 0x08))
#define GPIO_OUT_W1TC (*(volatile uint32_t *)(GPIO_BASE + 0x0c))
#define GPIO_EN_W1TS (*(volatile uint32_t *)(GPIO_BASE + 0x24))
#define GPIO_EN_W1TC (*(volatile uint32_t *)(GPIO_BASE + 0x28))
#define GPIO_IN (*(volatile uint32_t *)(GPIO_BASE + 0x3c))

#define SYSTIMER_BASE 0x60010000u
#define SYS_MILLIS (*(volatile uint32_t *)(SYSTIMER_BASE + 0x00))
#define SYS_MICROS (*(volatile uint32_t *)(SYSTIMER_BASE + 0x04))

#define UART0_BASE 0x60000000u
#define UART_FIFO (*(volatile uint32_t *)(UART0_BASE + 0x00))

#define I2C0_BASE 0x60013000u
#define I2C_DATA (*(volatile uint32_t *)(I2C0_BASE + 0x00)) // write a data byte to the slave
#define I2C_ADDR (*(volatile uint32_t *)(I2C0_BASE + 0x04)) // start a write transaction to addr
#define I2C_CMD (*(volatile uint32_t *)(I2C0_BASE + 0x08))  // 1 = STOP

#define ADC_BASE 0x60020000u // sim ADC: analogRead(ch) reads the per-channel value register
#define ADC_CH(ch) (*(volatile uint32_t *)(ADC_BASE + (((ch) & 0x3f) << 2)))

#define LEDC_BASE 0x60019000u // sim LEDC (PWM): channel duty + a config trigger
#define LEDC_DUTY(c) (*(volatile uint32_t *)(LEDC_BASE + (((c) & 0xf) << 3)))
#define LEDC_PIN(c) (*(volatile uint32_t *)(LEDC_BASE + (((c) & 0xf) << 3) + 4))

#define NET_BASE 0x60022000u // Stage 6 network peripheral (Tier-1 fake; backend=0)
#define NET_WIFI_SSID (*(volatile uint32_t *)(NET_BASE + 0x00))   // append one SSID char
#define NET_WIFI_BEGIN (*(volatile uint32_t *)(NET_BASE + 0x04))  // start WiFi connect
#define NET_WIFI_STATUS (*(volatile uint32_t *)(NET_BASE + 0x08)) // poll + read wl_status_t
#define NET_REQ_CHAR (*(volatile uint32_t *)(NET_BASE + 0x10))    // append one request char
#define NET_HTTP_SEND (*(volatile uint32_t *)(NET_BASE + 0x14))   // send buffered request
#define NET_HTTP_STATUS (*(volatile uint32_t *)(NET_BASE + 0x18)) // response status code
#define NET_RX_AVAIL (*(volatile uint32_t *)(NET_BASE + 0x1c))    // response bytes unread
#define NET_RX_CHAR (*(volatile uint32_t *)(NET_BASE + 0x20))     // pop one response byte
#define NET_HTTP_READY (*(volatile uint32_t *)(NET_BASE + 0x24))  // 1 when response has landed
#define NET_MQTT_TOPIC (*(volatile uint32_t *)(NET_BASE + 0x30))  // append one topic char
#define NET_MQTT_PAY (*(volatile uint32_t *)(NET_BASE + 0x34))    // append one payload char
#define NET_MQTT_PUB (*(volatile uint32_t *)(NET_BASE + 0x38))    // publish topic+payload
#define NET_MQTT_SUB (*(volatile uint32_t *)(NET_BASE + 0x3c))    // subscribe to topic
#define NET_MQTT_AVAIL (*(volatile uint32_t *)(NET_BASE + 0x40))  // queued incoming msg count
#define NET_MQTT_RX (*(volatile uint32_t *)(NET_BASE + 0x44))     // pop one incoming payload byte
#define NET_MQTT_NEXT (*(volatile uint32_t *)(NET_BASE + 0x48))   // advance to next incoming msg
#define NET_BLYNK_TOKEN (*(volatile uint32_t *)(NET_BASE + 0x50))  // append one auth-token char
#define NET_BLYNK_BEGIN (*(volatile uint32_t *)(NET_BASE + 0x54))  // open the Blynk device session
#define NET_BLYNK_STATUS (*(volatile uint32_t *)(NET_BASE + 0x58)) // 0 idle 1 connecting 2 online 3 failed
#define NET_BLYNK_PING (*(volatile uint32_t *)(NET_BASE + 0x5c))   // handshake round-trip ms

// The sketch's setup()/loop() — C++ linkage (mangled), resolved from the sketch object.
void setup();
void loop();

/*
 * Minimal Serial shim. The mangled names must match what the arduino-esp32 headers produce,
 * so the user sketch's `Serial.begin(...)` / `Serial.println("...")` resolve here:
 *   Print::println(const char*)            -> _ZN5Print7printlnEPKc
 *   HardwareSerial::begin(unsigned long, unsigned int, signed char, signed char, bool,
 *                         unsigned long, unsigned char) -> _ZN14HardwareSerial5beginEmjaabmh
 *   Serial0 (global)                       -> Serial0
 * println/print are non-virtual in arduino's Print (they call write), so these are direct
 * calls — no vtable, and we never dereference `this` (output goes straight to UART MMIO).
 */
class Printable; // an object that knows how to print itself (IPAddress, etc.) — see the WiFi shim below
class Print {
public:
  unsigned int write(unsigned char c);
  unsigned int print(const char *s);
  unsigned int println(const char *s);
  unsigned int print(unsigned int n);          // Print::print(unsigned int) — IPAddress::printTo uses it
  unsigned int print(const Printable &p);       // Serial.print(WiFi.localIP())
  unsigned int println(const Printable &p);      // Serial.println(WiFi.localIP())
  // Number printing: Serial.print/println(n[, base]) → Print::print(<type>, int). The base arg has a
  // DEC default in the real header (not part of the mangled name); we define each integer type.
  unsigned int print(int n, int base);
  unsigned int print(unsigned int n, int base);
  unsigned int print(long n, int base);
  unsigned int print(unsigned long n, int base);
  unsigned int println(int n, int base);
  unsigned int println(unsigned int n, int base);
  unsigned int println(long n, int base);
  unsigned int println(unsigned long n, int base);
  // 64-bit + floating-point forms. arduino-esp32's Print.h declares print/println(long long,int=DEC),
  // (unsigned long long,int=DEC) and (double,int=2); a sketch doing Serial.println(someFloat) or
  // Serial.println(<long long>) compiles against those but used to fail to LINK (only the 32-bit forms
  // were defined here). The base/digits default is filled at the call site, so each takes two args.
  unsigned int print(long long n, int base);
  unsigned int print(unsigned long long n, int base);
  unsigned int print(double n, int digits);
  unsigned int println(long long n, int base);
  unsigned int println(unsigned long long n, int base);
  unsigned int println(double n, int digits);
  unsigned int println(void); // Serial.println() with no args
};
class HardwareSerial : public Print {
public:
  void begin(unsigned long baud, unsigned int config, signed char rxPin, signed char txPin,
             bool invert, unsigned long timeout, unsigned char rxfifo_full_thrhd);
};
HardwareSerial Serial0;

unsigned int Print::write(unsigned char c) {
  UART_FIFO = c;
  return 1;
}
unsigned int Print::print(const char *s) {
  unsigned int n = 0;
  while (*s) {
    UART_FIFO = (unsigned char)*s++;
    n++;
  }
  return n;
}
unsigned int Print::println(const char *s) {
  unsigned int n = print(s);
  UART_FIFO = '\r';
  UART_FIFO = '\n';
  return n + 2;
}
unsigned int Print::print(unsigned int n) {
  char buf[12];
  int i = 0;
  if (n == 0) buf[i++] = '0';
  while (n > 0) {
    buf[i++] = (char)('0' + (n % 10));
    n /= 10;
  }
  unsigned int written = (unsigned int)i;
  while (i > 0) UART_FIFO = (unsigned char)buf[--i];
  return written;
}
// Emit an unsigned value in `base` (2..36) to the UART; returns the digit count.
static unsigned int uart_ulong(unsigned long u, int base) {
  if (base < 2 || base > 36) base = 10;
  char buf[34];
  int i = 0;
  if (u == 0) buf[i++] = '0';
  while (u > 0) {
    int d = (int)(u % (unsigned long)base);
    buf[i++] = (char)(d < 10 ? '0' + d : 'a' + d - 10);
    u /= (unsigned long)base;
  }
  unsigned int written = (unsigned int)i;
  while (i > 0) UART_FIFO = (unsigned char)buf[--i];
  return written;
}
static unsigned int uart_long(long n, int base) {
  if (base == 10 && n < 0) {
    UART_FIFO = '-';
    return 1 + uart_ulong((unsigned long)(-n), 10);
  }
  return uart_ulong((unsigned long)n, base);
}
unsigned int Print::print(int n, int base) { return uart_long(n, base); }
unsigned int Print::print(unsigned int n, int base) { return uart_ulong(n, base); }
unsigned int Print::print(long n, int base) { return uart_long(n, base); }
unsigned int Print::print(unsigned long n, int base) { return uart_ulong(n, base); }
unsigned int Print::println(void) {
  UART_FIFO = '\r';
  UART_FIFO = '\n';
  return 2;
}
unsigned int Print::println(int n, int base) { return print(n, base) + println(); }
unsigned int Print::println(unsigned int n, int base) { return print(n, base) + println(); }
unsigned int Print::println(long n, int base) { return print(n, base) + println(); }
unsigned int Print::println(unsigned long n, int base) { return print(n, base) + println(); }
// 64-bit base loop (mirrors uart_ulong) for Serial.print(<long long>); negative magnitude is taken in
// unsigned space (0 - x) so LLONG_MIN is correct (plain -n would overflow). The 64-bit %/÷ resolve to
// libgcc __udivdi3/__umoddi3, which link + run on the interpreter.
static unsigned int uart_ulonglong(unsigned long long u, int base) {
  if (base < 2 || base > 36) base = 10;
  char buf[66];
  int i = 0;
  if (u == 0) buf[i++] = '0';
  while (u > 0) {
    int d = (int)(u % (unsigned long long)base);
    buf[i++] = (char)(d < 10 ? '0' + d : 'a' + d - 10);
    u /= (unsigned long long)base;
  }
  unsigned int written = (unsigned int)i;
  while (i > 0) UART_FIFO = (unsigned char)buf[--i];
  return written;
}
// Serial.print/println(floatVar) → snprintf("%.*f", …): the real picolibc dtoa/vfprintf FP path (now
// linked + verified by esp32-classic-printf.test.ts) does the rounding — a thin wrapper, the shape the
// Arduino printFloat documents (default 2 digits, filled at the call site).
extern "C" int snprintf(char *, __SIZE_TYPE__, const char *, ...);
unsigned int Print::print(long long n, int base) {
  if (base == 10 && n < 0) {
    UART_FIFO = '-';
    return 1 + uart_ulonglong(0ull - (unsigned long long)n, 10);
  }
  return uart_ulonglong((unsigned long long)n, base);
}
unsigned int Print::print(unsigned long long n, int base) { return uart_ulonglong(n, base); }
unsigned int Print::print(double n, int digits) {
  if (digits < 0) digits = 2;
  char buf[40];
  int len = snprintf(buf, sizeof(buf), "%.*f", digits, n);
  if (len < 0) return 0;
  if (len > (int)sizeof(buf) - 1) len = (int)sizeof(buf) - 1; // truncated, but never overrun
  for (int i = 0; i < len; i++) UART_FIFO = (unsigned char)buf[i];
  return (unsigned int)len;
}
unsigned int Print::println(long long n, int base) { return print(n, base) + println(); }
unsigned int Print::println(unsigned long long n, int base) { return print(n, base) + println(); }
unsigned int Print::println(double n, int digits) { return print(n, digits) + println(); }

// String→number for Arduino's String::toInt()/toFloat()/toDouble() (which call atol/atof) + the common
// atoi/atoll. Routed through the REAL picolibc sscanf (vfscanf — links + runs, see esp32-classic-printf
// test) so parsing is correct WITHOUT pulling picolibc's strtod/strtol objects, whose `errno` is reached
// via an R_XTENSA_TLS_TPOFF (type 53) relocation our generic ld.lld can't resolve. sscanf does its own
// number scanning (never calls strtod/strtol), so there is no recursion and no TLS-errno reloc. Defining
// these strongly here means picolibc's atof/atol.o are never pulled, so neither is their strtod/strtol.
extern "C" int sscanf(const char *, const char *, ...);
extern "C" double atof(const char *s) {
  double v = 0.0;
  sscanf(s, "%lf", &v);
  return v;
}
extern "C" long atol(const char *s) {
  long v = 0;
  sscanf(s, "%ld", &v);
  return v;
}
extern "C" int atoi(const char *s) {
  int v = 0;
  sscanf(s, "%d", &v);
  return v;
}
extern "C" long long atoll(const char *s) {
  long long v = 0;
  sscanf(s, "%lld", &v);
  return v;
}

void HardwareSerial::begin(unsigned long, unsigned int, signed char, signed char, bool,
                           unsigned long, unsigned char) {
  /* sim: nothing to configure — TX is always ready */
}

/*
 * Minimal Wire (I2C master) shim. Mangling matches arduino-esp32 Wire.h:
 *   TwoWire::begin(int, int, unsigned int)         -> _ZN7TwoWire5beginEiij
 *   TwoWire::beginTransmission(unsigned char)      -> _ZN7TwoWire16beginTransmissionEh
 *   TwoWire::write(unsigned char)                  -> _ZN7TwoWire5writeEh
 *   TwoWire::endTransmission()                     -> _ZN7TwoWire15endTransmissionEv
 *   Wire (global)                                  -> Wire
 * Each transaction is streamed to the emulator's I2C controller MMIO, which routes the
 * bytes to the addressed slave device (e.g. a PCF8574 LCD backpack).
 */
class TwoWire {
public:
  bool begin(int sda, int scl, unsigned int frequency);
  void beginTransmission(unsigned char address);
  unsigned int write(unsigned char b);
  unsigned char endTransmission();
};
TwoWire Wire;

bool TwoWire::begin(int, int, unsigned int) { return true; }
void TwoWire::beginTransmission(unsigned char address) { I2C_ADDR = address; }
unsigned int TwoWire::write(unsigned char b) {
  I2C_DATA = b;
  return 1;
}
unsigned char TwoWire::endTransmission() {
  I2C_CMD = 1;
  return 0;
}

/*
 * WiFi shim (Stage 6) — the REAL arduino-esp32 WiFi API surface a sketch uses to get online.
 * `WiFi` is a WiFiClass whose WiFiSTAClass base declares begin()/status(); we define those exact
 * mangled methods and route them to the network MMIO (Tier-1 fake), never dereferencing `this`
 * (same trick as the Serial/Wire shims). The `WiFi` global is plain storage the sketch's
 * WiFiClass reference resolves to. wl_status_t is int-sized; WL_CONNECTED==3 comes from the
 * real WiFiType.h in the sketch.
 */
typedef int wl_status_t_shim;
enum wifi_mode_t { WIFI_MODE_NULL_S, WIFI_MODE_STA_S, WIFI_MODE_AP_S, WIFI_MODE_APSTA_S };

// IPAddress (IPv6-capable, like the real core) — defined with the SAME object layout + Printable vtable
// as arduino-esp32's IPAddress.h so `Serial.println(WiFi.localIP())` constructs, returns-by-value, and
// virtual-dispatches printTo correctly. We only need the 4 octets it formats for IPv4.
// Real heap allocation: the sketch + linked libraries get genuine new/delete backed by libc's malloc
// over the sim heap (see sbrk below) — so a library using `new`, `String`, `std::vector`, `std::string`
// allocates (and frees) for real, with its true behavior. Replaces the earlier no-op deletes; the
// Printable deleting-dtor slot now calls free(), which is only reached for an actual `delete` (stack
// IPAddress objects never hit it). malloc/free come from the always-linked libc.
extern "C" void *malloc(__SIZE_TYPE__);
extern "C" void free(void *);
void *operator new(__SIZE_TYPE__ n) { return malloc(n ? n : 1); }
void *operator new[](__SIZE_TYPE__ n) { return malloc(n ? n : 1); }
void operator delete(void *p) noexcept { free(p); }
void operator delete[](void *p) noexcept { free(p); }
void operator delete(void *p, __SIZE_TYPE__) noexcept { free(p); }
void operator delete[](void *p, __SIZE_TYPE__) noexcept { free(p); }
// With -fno-exceptions, libstdc++ headers route a thrown error (std::vector::at, bad_alloc, …) to these
// __throw_* hooks; in the sim a fatal range/alloc error terminates (trap → surfaced) rather than unwinds.
namespace std {
void __throw_length_error(const char *) { __builtin_trap(); }
void __throw_bad_alloc() { __builtin_trap(); }
void __throw_bad_array_new_length() { __builtin_trap(); }
void __throw_out_of_range(const char *) { __builtin_trap(); }
void __throw_out_of_range_fmt(const char *, ...) { __builtin_trap(); }
void __throw_logic_error(const char *) { __builtin_trap(); }
void __throw_invalid_argument(const char *) { __builtin_trap(); }
} // namespace std
class Print;
class Printable {
public:
  virtual ~Printable() {}
  virtual unsigned int printTo(Print &p) const = 0;
};
enum IPType_shim { IPv4_S, IPv6_S };
class IPAddress : public Printable {
  union {
    unsigned char bytes[16];
    unsigned int dword[4];
  } _address;
  IPType_shim _type;
  unsigned char _zone;

public:
  IPAddress(unsigned char a, unsigned char b, unsigned char c, unsigned char d);
  unsigned int printTo(Print &p) const override;
};
IPAddress::IPAddress(unsigned char a, unsigned char b, unsigned char c, unsigned char d) {
  for (int i = 0; i < 16; ++i) _address.bytes[i] = 0;
  _address.bytes[12] = a; // IPADDRESS_V4_BYTES_INDEX = 12 (IPv4 lives in the last 4 bytes)
  _address.bytes[13] = b;
  _address.bytes[14] = c;
  _address.bytes[15] = d;
  _type = IPv4_S;
  _zone = 0;
}
unsigned int IPAddress::printTo(Print &p) const {
  unsigned int n = 0;
  for (int i = 0; i < 4; ++i) {
    if (i) {
      p.print(".");
      n += 1;
    }
    n += p.print((unsigned int)_address.bytes[12 + i]);
  }
  return n;
}
unsigned int Print::print(const Printable &v) { return v.printTo(*this); }
unsigned int Print::println(const Printable &v) {
  unsigned int n = v.printTo(*this);
  UART_FIFO = '\r';
  UART_FIFO = '\n';
  return n + 2;
}

// WiFi shim — `WiFi` (a WiFiClass) inherits WiFiGenericClass (mode/getMode, static) + WiFiSTAClass
// (begin/status/localIP/disconnect). We define the exact mangled methods a sketch calls; the link uses
// them regardless of the real class layout because none dereferences `this`.
class WiFiGenericClass {
public:
  static bool mode(wifi_mode_t);
  bool setSleep(bool);
};
bool WiFiGenericClass::mode(wifi_mode_t) { return true; } // sim is always STA-capable
bool WiFiGenericClass::setSleep(bool) { return true; }
class WiFiSTAClass {
public:
  wl_status_t_shim begin(const char *ssid, const char *passphrase = 0, int channel = 0,
                         const unsigned char *bssid = 0, bool connect = true);
  wl_status_t_shim status();
  IPAddress localIP();
  bool disconnect(bool wifioff = false, bool eraseap = false);
  bool setAutoReconnect(bool);
};
wl_status_t_shim WiFiSTAClass::begin(const char *ssid, const char *, int, const unsigned char *, bool) {
  for (const char *p = ssid; p && *p; ++p) NET_WIFI_SSID = (unsigned char)*p;
  NET_WIFI_BEGIN = 1;
  return 0; // WL_IDLE; the sketch spins on status() until WL_CONNECTED
}
wl_status_t_shim WiFiSTAClass::status() { return (wl_status_t_shim)NET_WIFI_STATUS; }
IPAddress WiFiSTAClass::localIP() { return IPAddress(192, 168, 4, 2); } // the WiFiSim DHCP-style IP
bool WiFiSTAClass::disconnect(bool, bool) { return true; }
bool WiFiSTAClass::setAutoReconnect(bool) { return true; }
unsigned char WiFi[512]; // storage for the `WiFi` global (WiFiClass : ... WiFiSTAClass ...)

/*
 * SparkHttp (Stage 6) — a compact HTTP helper for sending a sensor value and receiving a command
 * back, without pulling in HTTPClient/String (heap) or the WiFiClient vtable. Declared identically
 * in the mounted SparkNet.h the sketch includes; defined here. State lives in the MMIO peripheral,
 * so the methods never dereference `this`. Each request is one Tier-1 fetch().
 */
class SparkHttp {
public:
  void begin(const char *host, int port, const char *path);
  int postValue(int value);
  int available();
  int read();
};
static void net_puts(const char *s) {
  while (*s) NET_REQ_CHAR = (unsigned char)*s++;
}
static void net_putint(int v) {
  if (v < 0) {
    NET_REQ_CHAR = '-';
    v = -v;
  }
  char buf[12];
  int n = 0;
  if (v == 0) buf[n++] = '0';
  while (v > 0) {
    buf[n++] = (char)('0' + (v % 10));
    v /= 10;
  }
  while (n > 0) NET_REQ_CHAR = (unsigned char)buf[--n];
}
void SparkHttp::begin(const char *host, int port, const char *path) {
  net_puts("POST ");
  net_puts(host);
  NET_REQ_CHAR = ':';
  net_putint(port);
  NET_REQ_CHAR = ' ';
  net_puts(path);
  NET_REQ_CHAR = '\n';
}
int SparkHttp::postValue(int value) {
  net_puts("VAL=");
  net_putint(value);
  NET_HTTP_SEND = 1;
  while (NET_HTTP_READY == 0) {
  } // wait for the (possibly async, Tier-2) response to land
  return (int)NET_HTTP_STATUS;
}
int SparkHttp::available() { return (int)NET_RX_AVAIL; }
int SparkHttp::read() { return (int)NET_RX_CHAR; }
SparkHttp Http;

/*
 * SparkMqtt (Stage 6) — the canonical IoT pub/sub: publish a sensor value to a topic and receive
 * commands on a subscribed topic. Declared identically in SparkNet.h; state lives in the MMIO
 * peripheral (Tier-1 fake broker / Tier-2 WS broker), so the methods never dereference `this`.
 */
class SparkMqtt {
public:
  void publish(const char *topic, int value);
  void subscribe(const char *topic);
  int available();
  int read();
  void next();
};
void SparkMqtt::publish(const char *topic, int value) {
  for (const char *p = topic; *p; ++p) NET_MQTT_TOPIC = (unsigned char)*p;
  if (value < 0) {
    NET_MQTT_PAY = '-';
    value = -value;
  }
  char buf[12];
  int n = 0;
  if (value == 0) buf[n++] = '0';
  while (value > 0) {
    buf[n++] = (char)('0' + (value % 10));
    value /= 10;
  }
  while (n > 0) NET_MQTT_PAY = (unsigned char)buf[--n];
  NET_MQTT_PUB = 1;
}
void SparkMqtt::subscribe(const char *topic) {
  for (const char *p = topic; *p; ++p) NET_MQTT_TOPIC = (unsigned char)*p;
  NET_MQTT_SUB = 1;
}
int SparkMqtt::available() { return (int)NET_MQTT_AVAIL; }
int SparkMqtt::read() { return (int)NET_MQTT_RX; }
void SparkMqtt::next() { NET_MQTT_NEXT = 1; }
SparkMqtt Mqtt;

/*
 * SparkBlynk (firmware-driven Blynk over HTTP) — declared identically in the mounted SparkBlynk.h.
 * `virtualWrite` and `run` build Blynk Device-API requests (GET blynk.cloud:443 /external/api/{update,
 * get}) onto the network MMIO; the selected transport carries them to the REAL Blynk cloud (Tier-2
 * fetch, CORS-readable) or a deterministic fake Blynk server (Tier-1). State lives in file-scope statics
 * (no `this` deref, no global ctors — the crt0 doesn't run .init_array). The token is the user's, in
 * the sketch, exactly like real Blynk. BLYNK_WRITE handlers are registered via the `blynk_handlers` link
 * section; run() iterates it, polling each pin (throttled to ~1s of virtual time) and dispatches on change.
 */
class BlynkParam {
public:
  long asInt() const;
  long asLong() const;
  float asFloat() const;
  double asDouble() const;
  const char *asStr() const;
  const char *_raw;
};
struct BlynkHandler {
  int vpin;
  void (*fn)(BlynkParam param);
};
struct BlynkConnectHandler {
  void (*fn)();
};
class BlynkSim {
public:
  void begin(const char *auth);
  void begin(const char *auth, const char *ssid, const char *pass);
  void config(const char *auth);
  void run();
  bool connected();
  void virtualWrite(int vpin, int value);
  void virtualWrite(int vpin, long value);
  void virtualWrite(int vpin, float value);
  void virtualWrite(int vpin, double value);
  void virtualWrite(int vpin, const char *value);
  void syncVirtual(int vpin);
  void syncAll();
};

// The link section the BLYNK_WRITE macro fills; the linker brackets it with these (weak: absent → no
// handlers → the run() loop simply does nothing).
extern "C" const BlynkHandler __start_blynk_handlers[] __attribute__((weak));
extern "C" const BlynkHandler __stop_blynk_handlers[] __attribute__((weak));

static char g_blynkToken[48];
static unsigned char g_blynkSeen[32];
static long g_blynkLast[32];
static unsigned int g_blynkLastPollMs;
static char g_blynkValBuf[40];
static unsigned char g_blynkErrShown; // print the /get failure note once, not every ~1s poll

long BlynkParam::asInt() const {
  const char *s = _raw;
  if (!s) return 0;
  while (*s == ' ') ++s;
  int neg = 0;
  if (*s == '-') {
    neg = 1;
    ++s;
  }
  long v = 0;
  while (*s >= '0' && *s <= '9') {
    v = v * 10 + (*s - '0');
    ++s;
  }
  return neg ? -v : v;
}
const char *BlynkParam::asStr() const { return _raw ? _raw : ""; }
double BlynkParam::asDouble() const {
  const char *s = _raw;
  if (!s) return 0;
  while (*s == ' ') ++s;
  double sign = 1;
  if (*s == '-') { sign = -1; ++s; }
  double v = 0;
  while (*s >= '0' && *s <= '9') { v = v * 10 + (*s - '0'); ++s; }
  if (*s == '.') {
    ++s;
    double f = 0.1;
    while (*s >= '0' && *s <= '9') { v += (*s - '0') * f; f *= 0.1; ++s; }
  }
  return sign * v;
}
float BlynkParam::asFloat() const { return (float)asDouble(); }
long BlynkParam::asLong() const { return asInt(); }

static void blynk_copy_token(const char *auth) {
  int i = 0;
  for (; auth && auth[i] && i < 47; ++i) g_blynkToken[i] = auth[i];
  g_blynkToken[i] = 0;
  g_blynkLastPollMs = 0;
}

// Blynk-style connection log straight to UART0 — mirrors the stock library's "[millis] ..." banner so
// the Serial Monitor shows the real handshake the user expects. Writes the FIFO directly (no Print).
static void blynk_uart_puts(const char *s) {
  while (*s) UART_FIFO = (unsigned char)*s++;
}
static void blynk_log_ts() {
  UART_FIFO = '[';
  uart_ulong((unsigned long)SYS_MILLIS, 10);
  UART_FIFO = ']';
  UART_FIFO = ' ';
}

// Version + board reported in the banner, matching the stock Blynk library's "Blynk v<ver> on <board>".
#define BLYNK_SIM_VERSION "1.3.5"
#if defined(__riscv)
#define BLYNK_SIM_BOARD "ESP32-C3"
#else
#define BLYNK_SIM_BOARD "ESP32"
#endif

// The exact startup banner the stock Blynk library prints when BLYNK_PRINT is defined (ASCII logo +
// "v<ver> on <board>"). Reproduced byte-for-byte so the Serial Monitor looks like a real device.
static void blynk_print_banner() {
  blynk_log_ts();
  blynk_uart_puts("\r\n");
  blynk_uart_puts("    ___  __          __\r\n");
  blynk_uart_puts("   / _ )/ /_ _____  / /__\r\n");
  blynk_uart_puts("  / _  / / // / _ \\/  '_/\r\n");
  blynk_uart_puts(" /____/_/\\_, /_//_/_/\\_\\\r\n");
  blynk_uart_puts("        /___/ v" BLYNK_SIM_VERSION " on " BLYNK_SIM_BOARD "\r\n");
  blynk_uart_puts("\r\n");
}

static void blynk_fire_connected(); // defined below (after the handler section); fired when begin completes

// Open the persistent Blynk DEVICE SESSION (MQTT-over-WebSocket, serviced by the net peripheral). This
// live connection is what makes the device show "online" on the real dashboard; data (virtualWrite /
// BLYNK_WRITE) still flows over the pin-based HTTP Device API. Hybrid by design (backend=0). Mirrors the
// stock library's "Connecting to blynk.cloud:443" → "Ready (ping: Nms)." handshake.
static void blynk_cloud_connect() {
  for (const char *p = g_blynkToken; *p; ++p) NET_BLYNK_TOKEN = (unsigned char)*p;
  NET_BLYNK_BEGIN = 1;
  blynk_log_ts();
  blynk_uart_puts("Connecting to blynk.cloud:443\r\n");
  uint32_t start = SYS_MILLIS;
  // Spin while connecting; the worker tick loop yields so the async WS handshake can land (same pattern
  // as HTTP_READY). Bounded so a dead network can't hang the sketch — connected()/run() recover later.
  while ((int)NET_BLYNK_STATUS == 1 && (uint32_t)(SYS_MILLIS - start) < 10000u) {
  }
  if ((int)NET_BLYNK_STATUS == 2) {
    blynk_log_ts();
    blynk_uart_puts("Ready (ping: ");
    uart_ulong((unsigned long)NET_BLYNK_PING, 10);
    blynk_uart_puts("ms).\r\n");
  } else {
    // The real library retries silently; tag this clearly as a sim-only note (not stock Blynk output).
    blynk_log_ts();
    blynk_uart_puts("[sim] no cloud session — check the auth token and turn on the Internet network tier\r\n");
  }
  blynk_fire_connected(); // the data path (HTTP) is ready once WiFi+begin completed — fire BLYNK_CONNECTED()
}

void BlynkSim::begin(const char *auth) {
  blynk_copy_token(auth);
  blynk_print_banner();   // WiFi assumed already up (config()+begin() idiom)
  blynk_cloud_connect();
}
// connected() means "the device can talk to Blynk" — i.e. the DATA path is usable. In the sim that path
// is the pin-based HTTP Device API, which works whenever WiFi is up (independent of the MQTT presence /
// dashboard "online" dot). Sketches gate Blynk.run() on connected(); tying it to the presence would stop
// run() — and thus BLYNK_WRITE / virtualWrite — whenever the (separate) presence session didn't connect.
bool BlynkSim::connected() { return (int)NET_WIFI_STATUS == 3; } // WL_CONNECTED — HTTP data path is usable
void BlynkSim::config(const char *auth) { blynk_copy_token(auth); }
void BlynkSim::begin(const char *auth, const char *ssid, const char *pass) {
  (void)pass;
  blynk_print_banner();
  // Stock Blynk's connectWiFi() logs (the block that was missing): connect the virtual AP, then report.
  blynk_log_ts();
  blynk_uart_puts("Connecting to ");
  blynk_uart_puts(ssid && *ssid ? ssid : "WiFi");
  blynk_uart_puts("\r\n");
  for (const char *p = ssid; p && *p; ++p) NET_WIFI_SSID = (unsigned char)*p;
  NET_WIFI_BEGIN = 1;
  while ((int)NET_WIFI_STATUS != 3) {
  } // spin until WL_CONNECTED (==3), the virtual AP always accepts
  blynk_log_ts();
  blynk_uart_puts("Connected to WiFi\r\n");
  blynk_log_ts();
  blynk_uart_puts("IP: 192.168.4.2\r\n"); // the virtual AP address (matches WiFi.localIP())
  blynk_copy_token(auth);
  blynk_cloud_connect();
}

// Build "GET blynk.cloud:443 /external/api/<op>?token=<tok>&V<n>" onto the request buffer.
static void blynk_req_head(const char *op, int vpin) {
  net_puts("GET blynk.cloud:443 /external/api/");
  net_puts(op);
  net_puts("?token=");
  net_puts(g_blynkToken);
  net_puts("&V");
  net_putint(vpin);
}
static int blynk_send_drain(char *buf, int cap) {
  NET_HTTP_SEND = 1;
  while (NET_HTTP_READY == 0) {
  }
  int status = (int)NET_HTTP_STATUS;
  int n = 0;
  while (NET_RX_AVAIL > 0) {
    int c = (int)NET_RX_CHAR;
    if (buf && n < cap - 1) buf[n++] = (char)c;
  }
  if (buf && cap > 0) buf[n] = 0;
  return status;
}

// Append a signed long to the request buffer (net_putint handles int; long needs its own digits).
static void blynk_put_long(long v) {
  if (v < 0) { NET_REQ_CHAR = '-'; v = -v; }
  char buf[20];
  int i = 0;
  if (v == 0) buf[i++] = '0';
  while (v > 0) { buf[i++] = (char)('0' + (v % 10)); v /= 10; }
  while (i > 0) NET_REQ_CHAR = (unsigned char)buf[--i];
}
// Append a float with 3 decimals (enough for sensor values; matches Blynk's default formatting closely).
static void blynk_put_float(double v) {
  if (v < 0) { NET_REQ_CHAR = '-'; v = -v; }
  long ip = (long)v;
  blynk_put_long(ip);
  NET_REQ_CHAR = '.';
  double frac = v - (double)ip;
  for (int d = 0; d < 3; ++d) {
    frac *= 10.0;
    int digit = (int)frac;
    NET_REQ_CHAR = (unsigned char)('0' + digit);
    frac -= digit;
  }
}
void BlynkSim::virtualWrite(int vpin, int value) {
  blynk_req_head("update", vpin);
  NET_REQ_CHAR = '=';
  net_putint(value);
  NET_REQ_CHAR = '\n';
  blynk_send_drain(0, 0);
}
void BlynkSim::virtualWrite(int vpin, long value) {
  blynk_req_head("update", vpin);
  NET_REQ_CHAR = '=';
  blynk_put_long(value);
  NET_REQ_CHAR = '\n';
  blynk_send_drain(0, 0);
}
void BlynkSim::virtualWrite(int vpin, double value) {
  blynk_req_head("update", vpin);
  NET_REQ_CHAR = '=';
  blynk_put_float(value);
  NET_REQ_CHAR = '\n';
  blynk_send_drain(0, 0);
}
void BlynkSim::virtualWrite(int vpin, float value) { virtualWrite(vpin, (double)value); }
void BlynkSim::virtualWrite(int vpin, const char *value) {
  blynk_req_head("update", vpin);
  NET_REQ_CHAR = '=';
  for (const char *p = value; p && *p; ++p) NET_REQ_CHAR = (unsigned char)*p;
  NET_REQ_CHAR = '\n';
  blynk_send_drain(0, 0);
}

// Blynk's get returns a JSON array like ["42"] (or a bare value); return a pointer past any [ and ".
static const char *blynk_unwrap(char *s) {
  if (*s == '[') ++s;
  if (*s == '"') ++s;
  for (char *e = s; *e; ++e) {
    if (*e == '"' || *e == ']') {
      *e = 0;
      break;
    }
  }
  return s;
}

// Poll one registered handler's V-pin and dispatch its BLYNK_WRITE when the value is new (or `force`,
// used by syncVirtual). Shared by run() and syncVirtual so there is ONE get-and-dispatch path.
static void blynk_poll_handler(const BlynkHandler *h, int force) {
  blynk_req_head("get", h->vpin);
  NET_REQ_CHAR = '\n';
  int status = blynk_send_drain(g_blynkValBuf, (int)sizeof(g_blynkValBuf));
  if (status != 200) {
    if (!g_blynkErrShown) {
      g_blynkErrShown = 1;
      blynk_log_ts();
      blynk_uart_puts("[sim] Blynk get V");
      uart_ulong((unsigned long)(h->vpin), 10);
      blynk_uart_puts(" failed (HTTP ");
      uart_ulong((unsigned long)status, 10);
      blynk_uart_puts(") — check the auth token and that the Internet network tier is on\r\n");
    }
    return;
  }
  g_blynkErrShown = 0;
  const char *val = blynk_unwrap(g_blynkValBuf);
  BlynkParam param;
  param._raw = val;
  long iv = param.asInt();
  int idx = h->vpin & 31;
  if (force || !g_blynkSeen[idx] || g_blynkLast[idx] != iv) {
    g_blynkSeen[idx] = 1;
    g_blynkLast[idx] = iv;
    h->fn(param);
  }
}

void BlynkSim::run() {
  unsigned int now = SYS_MILLIS;
  if (g_blynkLastPollMs != 0 && (unsigned int)(now - g_blynkLastPollMs) < 1000) return; // throttle ~1s
  g_blynkLastPollMs = now ? now : 1;
  for (const BlynkHandler *h = __start_blynk_handlers; h && h < __stop_blynk_handlers; ++h) blynk_poll_handler(h, 0);
}

// syncVirtual(Vn) / syncAll() — pull the dashboard's current value(s) NOW and fire BLYNK_WRITE, even if
// unchanged. Real sketches call these in BLYNK_CONNECTED() to restore widget state on (re)connect.
void BlynkSim::syncVirtual(int vpin) {
  for (const BlynkHandler *h = __start_blynk_handlers; h && h < __stop_blynk_handlers; ++h)
    if (h->vpin == vpin) blynk_poll_handler(h, 1);
}
void BlynkSim::syncAll() {
  for (const BlynkHandler *h = __start_blynk_handlers; h && h < __stop_blynk_handlers; ++h) blynk_poll_handler(h, 1);
}

// BLYNK_CONNECTED(){...} handlers, registered like BLYNK_WRITE in their own link section. Fired once the
// device session is established (here: right after Blynk.begin connects), as the real library does.
extern "C" const BlynkConnectHandler __start_blynk_connected[] __attribute__((weak));
extern "C" const BlynkConnectHandler __stop_blynk_connected[] __attribute__((weak));
static void blynk_fire_connected() {
  for (const BlynkConnectHandler *h = __start_blynk_connected; h && h < __stop_blynk_connected; ++h) h->fn();
}
BlynkSim Blynk;

extern "C" {

/* arduino-esp32 pin modes: INPUT=0x01, OUTPUT=0x03 — bit1 means "drive enabled". */
void pinMode(uint8_t pin, uint8_t mode) {
  if (mode & 0x02)
    GPIO_EN_W1TS = (1u << pin);
  else
    GPIO_EN_W1TC = (1u << pin);
}

void digitalWrite(uint8_t pin, uint8_t val) {
  if (val)
    GPIO_OUT_W1TS = (1u << pin);
  else
    GPIO_OUT_W1TC = (1u << pin);
}

int digitalRead(uint8_t pin) { return (GPIO_IN >> pin) & 1u; }

/* analogRead: read the sim ADC channel value (0..4095, set by the host/sensor model). */
int analogRead(uint8_t pin) { return (int)ADC_CH(pin); }

/* LEDC PWM (arduino-esp32 3.x API): attach a pin + write a duty, indexed by pin via MMIO. */
bool ledcAttach(uint8_t pin, uint32_t freq, uint8_t resolution) {
  LEDC_PIN(pin) = (freq << 8) | resolution;
  return true;
}
bool ledcWrite(uint8_t pin, uint32_t duty) {
  LEDC_DUTY(pin) = duty;
  return true;
}

uint32_t millis(void) { return SYS_MILLIS; }
uint32_t micros(void) { return SYS_MICROS; }

/* Busy-wait on the virtual clock: the timer is cycle-derived, so these retired instructions
 * advance virtual time until the deadline — deterministic, host-speed independent (I3). */
void delay(uint32_t ms) {
  uint32_t start = SYS_MILLIS;
  while ((uint32_t)(SYS_MILLIS - start) < ms) {
  }
}

void delayMicroseconds(uint32_t us) {
  uint32_t start = SYS_MICROS;
  while ((uint32_t)(SYS_MICROS - start) < us) {
  }
}

/* Sim heap for libc's malloc: a bump allocator over a fixed .bss region. The emulator RAM is a fresh
 * zeroed buffer (so the heap starts zeroed), and the runner gives ~1 MiB with the stack at the top, so
 * this 192 KiB heap + firmware + stack coexist. malloc/operator-new draw from here; sbrk returns -1 when
 * exhausted (malloc then fails → the caller's __throw_bad_alloc traps, which the sim surfaces). The whole
 * block is dead-stripped by --gc-sections for sketches that never allocate, so a plain blink stays tiny. */
typedef struct SimBlock {
  unsigned long size;     // payload bytes
  struct SimBlock *next;  // free-list link (valid only while the block is free)
} SimBlock;
// The heap grows UP from `_end` (linker-provided end of .bss) toward the stack — so it adds NO .bss to
// the firmware image (a sketch that never allocates stays tiny and fits a small RAM), yet a sketch that
// does gets the whole gap up to the stack on the runner's 1 MiB RAM. SIM_HEAP_LIMIT stays below the
// runner stack top (0xf0000); a sketch that over-allocates gets 0 from malloc → new throws → trap.
extern char _end[];
static char *g_brk = 0;
static SimBlock *g_free = 0;
static unsigned long sim_align(unsigned long n) { return (n + 7ul) & ~7ul; }
static void *sim_sbrk(unsigned long n) {
  if (g_brk == 0) g_brk = _end;
  if ((unsigned long)g_brk + n > 0xf0000ul - 0x10000ul) return 0; // keep a 64 KiB guard below the stack
  char *p = g_brk;
  g_brk += n;
  return p;
}

void *malloc(__SIZE_TYPE__ want) {
  unsigned long need = sim_align(want ? want : 1);
  for (SimBlock **pp = &g_free; *pp; pp = &(*pp)->next) { // first-fit reuse of a freed block
    SimBlock *b = *pp;
    if (b->size >= need) {
      *pp = b->next;
      if (b->size >= need + sizeof(SimBlock) + 8) { // split the tail back onto the free-list
        SimBlock *rest = (SimBlock *)((char *)(b + 1) + need);
        rest->size = b->size - need - sizeof(SimBlock);
        rest->next = g_free;
        g_free = rest;
        b->size = need;
      }
      return (void *)(b + 1);
    }
  }
  SimBlock *b = (SimBlock *)sim_sbrk(sizeof(SimBlock) + need); // else grow the heap
  if (!b) return 0;                                           // out of heap → new throws → trap
  b->size = need;
  return (void *)(b + 1);
}
void free(void *p) {
  if (!p) return;
  SimBlock *b = (SimBlock *)p - 1;
  b->next = g_free; // push to the free-list (reused with splitting; bounds long-loop fragmentation)
  g_free = b;
}
void *calloc(__SIZE_TYPE__ n, __SIZE_TYPE__ sz) {
  unsigned long total = (unsigned long)n * (unsigned long)sz;
  void *p = malloc(total);
  if (p) {
    char *c = (char *)p;
    for (unsigned long i = 0; i < total; i++) c[i] = 0;
  }
  return p;
}
void *realloc(void *p, __SIZE_TYPE__ want) {
  if (!p) return malloc(want);
  SimBlock *b = (SimBlock *)p - 1;
  if (b->size >= sim_align(want)) return p;
  void *np = malloc(want);
  if (np) {
    char *s = (char *)p, *d = (char *)np;
    for (unsigned long i = 0; i < b->size; i++) d[i] = s[i];
    free(p);
  }
  return np;
}
// Fallback brk for any stray libc caller; shares the bump pointer with malloc (self-contained, so
// picolibc's own sbrk-based malloc is never pulled from the archive).
void *sbrk(long incr) {
  void *p = sim_sbrk((unsigned long)incr);
  return p ? p : (void *)-1;
}
void *_sbrk(long incr) { return sbrk(incr); }
void abort(void) { __builtin_trap(); }
void _exit(int) { __builtin_trap(); }
int _getpid(void) { return 1; }
int _kill(int, int) { return -1; }
void __cxa_pure_virtual(void) { __builtin_trap(); }

/* C++ global constructors. Real hardware's crt0 runs the .init_array table (function pointers for
 * file-scope objects with non-trivial constructors) BEFORE the app; ours used to skip it, so a sketch
 * or library with a global object whose constructor has side effects was silently left uninitialised.
 * The bracket symbols are linker-provided (the Xtensa flat script PROVIDEs them; the C3 -Ttext=0 default
 * does too) — weak, so an absent .init_array (no global ctors) just yields an empty range. */
extern void (*__init_array_start[])(void) __attribute__((weak));
extern void (*__init_array_end[])(void) __attribute__((weak));
static void run_global_ctors(void) {
  for (void (**p)(void) = __init_array_start; p && p < __init_array_end; ++p) {
    if (*p) (*p)();
  }
}

/* crt0 == Arduino's loopTask: run global ctors, then setup() once, then loop() forever. */
void _start(void) {
  run_global_ctors();
  setup();
  for (;;) {
    loop();
  }
}

} // extern "C"
