// SparkNet.h — Stage 6 Sparklab HTTP helper (sim). A sketch includes this to send a value and
// read a command back over the (Tier-1 fake) network. Declarations MUST match the definitions in
// the sim-runtime shim (esp32c3-arduino-sim.cpp) so the mangled symbols link.
#ifndef SPARKNET_H
#define SPARKNET_H

class SparkHttp {
 public:
  void begin(const char *host, int port, const char *path);
  int postValue(int value);  // streams "VAL=<value>" body + sends; returns HTTP status (200/0)
  int available();           // response body bytes still unread
  int read();                // pop one response body byte
};

extern SparkHttp Http;

// MQTT pub/sub helper (the canonical IoT messaging pattern).
class SparkMqtt {
 public:
  void publish(const char *topic, int value);  // publish a sensor value to a topic
  void subscribe(const char *topic);            // subscribe to a command topic
  int available();                              // queued incoming message count
  int read();                                   // pop one payload byte of the front message
  void next();                                  // advance to the next incoming message
};

extern SparkMqtt Mqtt;

#endif  // SPARKNET_H
