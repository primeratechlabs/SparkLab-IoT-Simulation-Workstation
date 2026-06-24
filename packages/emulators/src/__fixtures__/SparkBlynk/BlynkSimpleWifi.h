// BlynkSimpleWifi.h — Sparklab compatibility shim. A standard Blynk sketch that does `#include <BlynkSimpleWifi.h>` gets the
// simulator's HTTP-based Blynk (SparkBlynk) instead of the real binary-protocol library (which can't
// run in a browser — no raw TCP). The Blynk idioms are unchanged: Blynk.begin/run/connected/virtualWrite
// + BLYNK_WRITE(Vn). BLYNK_TEMPLATE_ID / _NAME / _AUTH_TOKEN / BLYNK_PRINT #defines are accepted + ignored.
#ifndef SPARK_BLYNK_COMPAT_BlynkSimpleWifi_H
#define SPARK_BLYNK_COMPAT_BlynkSimpleWifi_H
#include <SparkBlynk.h>
#endif
