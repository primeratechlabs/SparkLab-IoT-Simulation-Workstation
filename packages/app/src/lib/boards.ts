/** Board + starter-project metadata for the Mạch Ảo workstation (board picker + workspace chip). */
import type { SavedCanvas } from './persist';
import {
  BUTTON_LED_CANVAS,
  POT_BRIGHT_CANVAS,
  TEMP_SENSOR_CANVAS,
  BLYNK_LED_CANVAS,
} from './template-circuits';

export interface BoardInfo {
  /** @sparklab/schematic board id. */
  id: string;
  name: string;
  sub: string;
  /** Difficulty badge from the design. */
  level: 'DỄ NHẤT' | 'TRUNG BÌNH' | 'NÂNG CAO';
  blurb: string;
  /** Accent colour used on the card CTA. */
  accent: string;
  /** The on-board LED GPIO for THIS board — the default blink sketch targets it so the first Run is
   *  observable on every board (AUD-004): Uno D13, ESP32-C3 GPIO8, ESP32-classic GPIO2. */
  onboardLed: number;
  /** Work-in-progress: shown in the picker but NOT selectable yet (the board's support isn't finished). */
  wip?: boolean;
}

export const BOARDS: BoardInfo[] = [
  {
    id: 'arduino-uno',
    name: 'Arduino Uno',
    sub: 'ATmega328P · 5V · 14 chân I/O',
    level: 'DỄ NHẤT',
    blurb: 'Lựa chọn hoàn hảo cho bài học đầu tiên. Chạy hoàn toàn trong máy bạn.',
    accent: 'var(--accent)',
    onboardLed: 13,
  },
  {
    id: 'esp32-c3-devkitm',
    name: 'ESP32-C3',
    sub: 'RISC-V · WiFi + Bluetooth',
    level: 'TRUNG BÌNH',
    blurb: 'Đang hoàn thiện — sẽ sớm ra mắt. Hãy dùng ESP32 (classic) cho dự án WiFi.',
    accent: 'var(--blue)',
    onboardLed: 8,
    wip: true, // RISC-V support is still in development — not selectable yet.
  },
  {
    id: 'esp32-devkit',
    name: 'ESP32 (classic)',
    sub: 'Xtensa · WiFi + Bluetooth',
    level: 'NÂNG CAO',
    blurb: 'Mạnh mẽ nhất. Dùng chế độ nâng cao cho dự án lớn.',
    accent: 'var(--red-ink)',
    onboardLed: 2,
  },
];

export function boardInfo(id: string): BoardInfo | undefined {
  return BOARDS.find((b) => b.id === id);
}

/** True iff the board has on-chip WiFi (the ESP32 family). The AVR Uno has none — so the workspace
 *  library panel must not claim `WiFi.h` is "built in" for it (the SDK pack ships WiFi only for ESP32). */
export function boardHasWifi(id: string): boolean {
  return id.startsWith('esp32');
}

/** The first-lesson blink sketch, targeting the given board's on-board LED so the first Run is observable
 *  on EVERY board (AUD-004 — no shared fixed pin 13 that's wrong on ESP32). */
export function defaultSketch(boardId: string): string {
  const led = boardInfo(boardId)?.onboardLed ?? 13;
  return `// Nhấp nháy LED — bài học đầu tiên 💡
#define LED ${led}

void setup() {
  pinMode(LED, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  digitalWrite(LED, HIGH);
  Serial.println("Den: BAT");
  delay(1000);
  digitalWrite(LED, LOW);
  Serial.println("Den: TAT");
  delay(1000);
}
`;
}

/** The first-lesson blink sketch for the Uno (back-compat default). Prefer defaultSketch(boardId). */
export const DEFAULT_SKETCH = defaultSketch('arduino-uno');

export interface StarterTemplate {
  id: string;
  title: string;
  sub: string;
  boardId: string;
  sketch: string;
  /** small swatch descriptor for the card icon */
  swatch: 'led' | 'button' | 'pot' | 'lcd' | 'wifi';
  /**
   * The circuit the sketch talks to (AUD-005). When present, selecting the template opens the workspace
   * with this circuit already drawn — not an empty canvas. Verified ERC-complete by a test.
   */
  canvas?: SavedCanvas;
}

export const TEMPLATES: StarterTemplate[] = [
  {
    id: 'blink',
    title: 'Nhấp nháy LED',
    sub: 'Bài học số 1',
    boardId: 'arduino-uno',
    sketch: DEFAULT_SKETCH,
    swatch: 'led',
  },
  {
    id: 'button-led',
    title: 'Nút bấm + LED',
    sub: 'Đọc tín hiệu vào',
    boardId: 'arduino-uno',
    swatch: 'button',
    canvas: BUTTON_LED_CANVAS,
    sketch: `// Nut bam dieu khien LED
#define LED 13
#define BTN 2

void setup() {
  pinMode(LED, OUTPUT);
  pinMode(BTN, INPUT_PULLUP);
}

void loop() {
  digitalWrite(LED, digitalRead(BTN) == LOW ? HIGH : LOW);
}
`,
  },
  {
    id: 'pot-bright',
    title: 'Biến trở · độ sáng',
    sub: 'Tín hiệu analog',
    boardId: 'arduino-uno',
    swatch: 'pot',
    canvas: POT_BRIGHT_CANVAS,
    sketch: `// Bien tro chinh do sang LED (PWM)
#define LED 9
#define POT A0

void setup() {
  pinMode(LED, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  int v = analogRead(POT);
  analogWrite(LED, v / 4);
  Serial.println(v);
  delay(50);
}
`,
  },
  {
    id: 'temp-lcd',
    title: 'Cảm biến nhiệt độ (NTC)',
    sub: 'Đọc analog, in Serial',
    boardId: 'arduino-uno',
    swatch: 'lcd',
    canvas: TEMP_SENSOR_CANVAS,
    sketch: `// Doc nhiet do tu cam bien NTC tren A0, in ra Serial
#define SENSOR A0

void setup() {
  Serial.begin(9600);
}

void loop() {
  int raw = analogRead(SENSOR);
  float c = raw * (5.0 / 1023.0) * 100.0;
  Serial.print("t=");
  Serial.println(c);
  delay(1000);
}
`,
  },
  {
    id: 'blynk-iot',
    title: 'WiFi + Blynk IoT',
    sub: 'ESP32 · điều khiển qua app',
    // Targets the C3 (its canvas is drawn for the C3 pinout). The Start screen hides any template whose
    // board is work-in-progress, so this one is not offered while the C3 is disabled — it returns with it.
    boardId: 'esp32-c3-devkitm',
    swatch: 'wifi',
    canvas: BLYNK_LED_CANVAS, // a drawn LED on GPIO2 so the dashboard switch is VISIBLE (C3 on-board LED is GPIO8)
    sketch: `// ESP32 + Blynk: dieu khien LED tu app, gui cam bien len dashboard.
// Doi token bang token thiet bi Blynk cua ban (Blynk app -> Device -> Device Info),
// roi chon "Internet that" o thanh tren de noi Blynk Cloud that.
#include <WiFi.h>
#include <SparkBlynk.h>

#define BLYNK_AUTH_TOKEN "YourBlynkToken"
#define LED 2

// V0: nut tren app Blynk -> bat/tat LED
BLYNK_WRITE(V0) {
  digitalWrite(LED, param.asInt() ? HIGH : LOW);
}

void setup() {
  Serial.begin(115200);
  pinMode(LED, OUTPUT);
  // WiFi ao cua trinh mo phong (mo, khong mat khau)
  WiFi.begin("Sparklab-GUEST", "");
  while (WiFi.status() != WL_CONNECTED) { delay(100); }
  Serial.println("WiFi connected");
  Blynk.begin(BLYNK_AUTH_TOKEN);
  Serial.println("Blynk ready");
}

void loop() {
  Blynk.run();
  // Gui gia tri cam bien (chan 34) len datastream V1 moi giay
  int sensor = analogRead(34);
  Blynk.virtualWrite(V1, sensor);
  delay(1000);
}
`,
  },
];
