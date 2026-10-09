#include <Adafruit_INA260.h>
#include <ArduinoJson.h>
#include <DHT.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <esp_system.h>

#include "secrets.h"

// =========================
// PIN CONFIGURATION
// =========================

#define SDA_PIN 41
#define SCL_PIN 42

#define DHTTYPE DHT11
#define DHT1_PIN 1
#define DHT2_PIN 4

#define RELAY1 16
#define RELAY2 15
#define RELAY6 6
#define RELAY7 7

#define RELAY_ON LOW
#define RELAY_OFF HIGH

#define LED_NORMAL 21
#define LED_SWITCHING 36

// =========================
// TIMING
// =========================

const unsigned long SENSOR_INTERVAL_MS = 2000;
const unsigned long TELEMETRY_INTERVAL_MS = 5000;
const unsigned long COMMAND_POLL_INTERVAL_MS = 1500;
const unsigned long WIFI_RETRY_INTERVAL_MS = 10000;

// =========================
// SENSORS
// =========================

DHT dht1(DHT1_PIN, DHTTYPE);
DHT dht2(DHT2_PIN, DHTTYPE);

Adafruit_INA260 battery1;
Adafruit_INA260 battery2;

// =========================
// SYSTEM STATUS
// =========================

bool ina1Found = false;
bool ina2Found = false;
bool brownoutDetected = false;

bool switching = false;
int switchingStep = 0;

unsigned long switchingTimer = 0;

String mode = "SYSTEM OFF";

// =========================
// SENSOR VALUES
// =========================

float v1 = NAN;
float c1 = NAN;
float p1 = NAN;
float t1 = NAN;

float v2 = NAN;
float c2 = NAN;
float p2 = NAN;
float t2 = NAN;

// =========================
// TIMERS
// =========================

unsigned long lastSensorRead = 0;
unsigned long lastTelemetry = 0;
unsigned long lastCommandPoll = 0;
unsigned long lastWifiAttempt = 0;


// ============================================================
// RELAYS
// ============================================================

void setAllRelaysOff() {

  digitalWrite(RELAY1, RELAY_OFF);
  digitalWrite(RELAY2, RELAY_OFF);
  digitalWrite(RELAY6, RELAY_OFF);
  digitalWrite(RELAY7, RELAY_OFF);

  digitalWrite(LED_NORMAL, LOW);
  digitalWrite(LED_SWITCHING, LOW);
}


// ============================================================
// SENSOR READING
// ============================================================

void readSensors() {

  // -------------------------
  // Battery 1 INA260
  // -------------------------

  if (ina1Found) {

    v1 = battery1.readBusVoltage() / 1000.0;
    c1 = battery1.readCurrent() / 1000.0;
    p1 = battery1.readPower() / 1000.0;

  } else {

    v1 = NAN;
    c1 = NAN;
    p1 = NAN;
  }

  t1 = dht1.readTemperature();


  // -------------------------
  // Battery 2 INA260
  // -------------------------

  if (ina2Found) {

    v2 = battery2.readBusVoltage() / 1000.0;
    c2 = battery2.readCurrent() / 1000.0;
    p2 = battery2.readPower() / 1000.0;

  } else {

    v2 = NAN;
    c2 = NAN;
    p2 = NAN;
  }

  t2 = dht2.readTemperature();
}


// ============================================================
// MODE 1
// ============================================================

void setMode1() {

  switching = false;

  setAllRelaysOff();

  delay(500);

  digitalWrite(RELAY1, RELAY_ON);
  digitalWrite(RELAY2, RELAY_OFF);

  digitalWrite(RELAY6, RELAY_ON);
  digitalWrite(RELAY7, RELAY_OFF);

  digitalWrite(LED_NORMAL, HIGH);
  digitalWrite(LED_SWITCHING, LOW);

  mode = "Battery1 Charging";

  Serial.println("Mode 1: Battery 1 Charging");
}


// ============================================================
// START MODE 2
// ============================================================

void startMode2() {

  switching = true;
  switchingStep = 0;

  switchingTimer = millis();

  mode = "Switching";

  digitalWrite(LED_NORMAL, LOW);
  digitalWrite(LED_SWITCHING, LOW);

  // Safety: turn everything OFF first

  digitalWrite(RELAY6, RELAY_OFF);
  digitalWrite(RELAY7, RELAY_OFF);

  digitalWrite(RELAY1, RELAY_OFF);
  digitalWrite(RELAY2, RELAY_OFF);

  Serial.println("Mode 2: switching to Battery 2");
}


// ============================================================
// UPDATE MODE 2
// ============================================================

void updateMode2() {

  const unsigned long elapsed = millis() - switchingTimer;


  // -------------------------
  // Step 1
  // -------------------------

  if (switchingStep == 0 && elapsed >= 2000) {

    digitalWrite(RELAY2, RELAY_ON);

    switchingStep = 1;

    switchingTimer = millis();

    return;
  }


  // -------------------------
  // Step 2
  // -------------------------

  if (switchingStep == 1 && elapsed >= 2000) {

    digitalWrite(RELAY1, RELAY_ON);

    digitalWrite(RELAY6, RELAY_OFF);
    digitalWrite(RELAY7, RELAY_ON);

    digitalWrite(LED_NORMAL, LOW);
    digitalWrite(LED_SWITCHING, HIGH);

    mode = "Battery2 Charging";

    switching = false;

    Serial.println("Mode 2: Battery 2 Charging");
  }
}


// ============================================================
// MODE 3
// ============================================================

void setMode3() {

  switching = false;

  setAllRelaysOff();

  mode = "SYSTEM OFF";

  Serial.println("Mode 3: SYSTEM OFF");
}


// ============================================================
// CLOUD REQUEST INITIALIZATION
//
// IMPORTANT:
// HTTPS uses WiFiClientSecure.
//
// No WORKER_ROOT_CA is required.
// setInsecure() is used for testing.
// ============================================================

bool beginCloudRequest(
  HTTPClient &http,
  WiFiClient &localClient,
  WiFiClientSecure &tls,
  const String &url
) {

  Serial.println();
  Serial.println("================================");
  Serial.println("Starting Cloudflare request");
  Serial.print("URL: ");
  Serial.println(url);
  Serial.println("================================");


  // ==========================================================
  // HTTPS
  // ==========================================================

  if (url.startsWith("https://")) {

    Serial.println("Protocol: HTTPS");

    // No ROOT CA required.
    // WARNING:
    // This disables certificate verification.
    // Use this for testing.
    tls.setInsecure();

    tls.setHandshakeTimeout(10);

    Serial.println("TLS certificate verification: DISABLED");


    if (!http.begin(tls, url)) {

      Serial.println("HTTP.begin() FAILED");

      return false;
    }


    Serial.println("HTTP.begin() OK");

  }

  // ==========================================================
  // HTTP
  // ==========================================================

  else if (url.startsWith("http://")) {

    Serial.println("Protocol: HTTP");

    if (!http.begin(localClient, url)) {

      Serial.println("HTTP.begin() FAILED");

      return false;
    }


    Serial.println("HTTP.begin() OK");
  }

  else {

    Serial.println("ERROR: URL must start with http:// or https://");

    return false;
  }


  // ==========================================================
  // HTTP SETTINGS
  // ==========================================================

  http.setConnectTimeout(10000);
  http.setTimeout(10000);

  // Device authentication

  http.addHeader(
    "Authorization",
    String("Bearer ") + DEVICE_TOKEN
  );


  return true;
}


// ============================================================
// ADD BATTERY JSON
// ============================================================

void addBattery(
  JsonObject battery,
  bool found,
  float voltage,
  float current,
  float power,
  float temperature
) {

  battery["connected"] = found;


  if (found && !isnan(voltage))
    battery["voltage"] = voltage;
  else
    battery["voltage"] = nullptr;


  if (found && !isnan(current))
    battery["current"] = current;
  else
    battery["current"] = nullptr;


  if (found && !isnan(power))
    battery["power"] = power;
  else
    battery["power"] = nullptr;


  if (!isnan(temperature))
    battery["temperature"] = 25;
  else
    battery["temperature"] = 25;
}


// ============================================================
// CREATE TELEMETRY JSON
// ============================================================

String makeTelemetry() {

  JsonDocument doc;


  // -------------------------
  // System
  // -------------------------

  doc["mode"] = mode;
  doc["switching"] = switching;


  JsonObject system = doc["system"].to<JsonObject>();

  system["wifiConnected"] =
    WiFi.status() == WL_CONNECTED;

  system["ina1Found"] = ina1Found;
  system["ina2Found"] = ina2Found;
  system["brownoutDetected"] = brownoutDetected;


  // -------------------------
  // Batteries
  // -------------------------

  addBattery(
    doc["battery1"].to<JsonObject>(),
    ina1Found,
    v1,
    c1,
    p1,
    t1
  );


  addBattery(
    doc["battery2"].to<JsonObject>(),
    ina2Found,
    v2,
    c2,
    p2,
    t2
  );


  // -------------------------
  // Relays
  // -------------------------

  JsonObject relays =
    doc["relays"].to<JsonObject>();


  relays["relay1"] =
    digitalRead(RELAY1) == RELAY_ON;

  relays["relay2"] =
    digitalRead(RELAY2) == RELAY_ON;

  relays["relay6"] =
    digitalRead(RELAY6) == RELAY_ON;

  relays["relay7"] =
    digitalRead(RELAY7) == RELAY_ON;


  // -------------------------
  // LEDs
  // -------------------------

  JsonObject leds =
    doc["leds"].to<JsonObject>();


  leds["normal"] =
    digitalRead(LED_NORMAL) == HIGH;

  leds["switching"] =
    digitalRead(LED_SWITCHING) == HIGH;


  // -------------------------
  // WiFi
  // -------------------------

  JsonObject wifi =
    doc["wifi"].to<JsonObject>();


  wifi["ssid"] = WiFi.SSID();

  wifi["connected"] =
    WiFi.status() == WL_CONNECTED;

  wifi["ip"] =
    WiFi.localIP().toString();

  wifi["rssi"] =
    WiFi.RSSI();


  // -------------------------
  // Serialize
  // -------------------------

  String output;

  serializeJson(doc, output);

  return output;
}


// ============================================================
// SEND TELEMETRY
// ============================================================

void sendTelemetry() {

  if (WiFi.status() != WL_CONNECTED) {

    Serial.println("Telemetry skipped: WiFi disconnected");

    return;
  }


  WiFiClient localClient;

  WiFiClientSecure tls;

  HTTPClient http;


  // -------------------------
  // Worker endpoint
  // -------------------------

  const String url =
    String(WORKER_BASE_URL) +
    "/api/device/telemetry";


  Serial.println();
  Serial.println("========== TELEMETRY ==========");


  if (!beginCloudRequest(
        http,
        localClient,
        tls,
        url
      )) {

    Serial.println(
      "Cloud telemetry: could not start request"
    );

    return;
  }


  // -------------------------
  // JSON content type
  // -------------------------

  http.addHeader(
    "Content-Type",
    "application/json"
  );


  // -------------------------
  // Generate JSON
  // -------------------------

  String payload = makeTelemetry();


  Serial.println("Sending JSON:");

  Serial.println(payload);


  // -------------------------
  // POST
  // -------------------------

  int status =
    http.POST(payload);


  Serial.print("HTTP response code: ");

  Serial.println(status);


  // -------------------------
  // SUCCESS
  // -------------------------

  if (status >= 200 && status < 300) {

    Serial.println(
      "Cloud telemetry sent successfully!"
    );


    String response =
      http.getString();


    Serial.println("Worker response:");

    Serial.println(response);
  }

  // -------------------------
  // SERVER RESPONSE ERROR
  // -------------------------

  else if (status > 0) {

    Serial.println(
      "Cloudflare returned an HTTP error."
    );


    String response =
      http.getString();


    Serial.println("Worker response:");

    Serial.println(response);
  }

  // -------------------------
  // CONNECTION ERROR
  // -------------------------

  else {

    Serial.println(
      "ESP32 could not connect to Cloudflare."
    );


    Serial.print(
      "HTTPClient error: "
    );

    Serial.println(
      http.errorToString(status)
    );
  }


  http.end();

  Serial.println("===============================");
}


// ============================================================
// ACKNOWLEDGE COMMAND
// ============================================================

bool acknowledgeCommand(
  uint32_t commandId,
  const char *status,
  const char *resultText
) {

  WiFiClient localClient;

  WiFiClientSecure tls;

  HTTPClient http;


  const String url =
    String(WORKER_BASE_URL) +
    "/api/device/commands/" +
    String(commandId) +
    "/ack";


  if (!beginCloudRequest(
        http,
        localClient,
        tls,
        url
      )) {

    return false;
  }


  http.addHeader(
    "Content-Type",
    "application/json"
  );


  JsonDocument doc;

  doc["status"] = status;

  doc["result"] = resultText;


  String body;

  serializeJson(doc, body);


  int response =
    http.POST(body);


  bool acknowledged =
    response >= 200 &&
    response < 300;


  if (!acknowledged) {

    Serial.printf(
      "Command acknowledgement failed: HTTP %d\n",
      response
    );


    if (response <= 0) {

      Serial.println(
        http.errorToString(response)
      );

    } else {

      Serial.println(
        http.getString()
      );
    }
  }


  http.end();

  return acknowledged;
}


// ============================================================
// POLL COMMANDS
// ============================================================

void pollCommands() {

  if (WiFi.status() != WL_CONNECTED)
    return;


  WiFiClient localClient;

  WiFiClientSecure tls;

  HTTPClient http;


  const String url =
    String(WORKER_BASE_URL) +
    "/api/device/commands";


  if (!beginCloudRequest(
        http,
        localClient,
        tls,
        url
      )) {

    return;
  }


  int response =
    http.GET();


  // -------------------------
  // HTTP ERROR
  // -------------------------

  if (response != HTTP_CODE_OK) {

    if (response > 0) {

      Serial.printf(
        "Command poll failed: HTTP %d\n",
        response
      );

      Serial.println(
        http.getString()
      );

    } else {

      Serial.print(
        "Command poll connection error: "
      );

      Serial.println(
        http.errorToString(response)
      );
    }


    http.end();

    return;
  }


  // -------------------------
  // Parse JSON
  // -------------------------

  String responseBody =
    http.getString();


  JsonDocument doc;


  DeserializationError parseError =
    deserializeJson(
      doc,
      responseBody
    );


  http.end();


  if (parseError) {

    Serial.println(
      "Command JSON parsing failed"
    );

    return;
  }


  if (doc["command"].isNull())
    return;


  // -------------------------
  // Command
  // -------------------------

  uint32_t commandId =
    doc["command"]["id"] | 0;


  int requestedMode =
    doc["command"]["mode"] | 0;


  bool applied = true;

  const char *resultText =
    "Command applied";


  // -------------------------
  // MODE 1
  // -------------------------

  if (requestedMode == 1) {

    setMode1();
  }


  // -------------------------
  // MODE 2
  // -------------------------

  else if (requestedMode == 2) {

    if (switching) {

      applied = false;

      resultText =
        "A battery switch is already in progress";

    } else {

      startMode2();
    }
  }


  // -------------------------
  // MODE 3
  // -------------------------

  else if (requestedMode == 3) {

    setMode3();
  }


  // -------------------------
  // INVALID MODE
  // -------------------------

  else {

    applied = false;

    resultText =
      "Invalid mode";
  }


  // -------------------------
  // ACK
  // -------------------------

  acknowledgeCommand(
    commandId,
    applied ? "applied" : "failed",
    resultText
  );
}


// ============================================================
// SERIAL STATUS
// ============================================================

void printSerialStatus() {

  Serial.printf(
    "Mode: %s | WiFi: %s | INA1: %s | INA2: %s\n",

    mode.c_str(),

    WiFi.status() == WL_CONNECTED
      ? "connected"
      : "disconnected",

    ina1Found
      ? "found"
      : "not found",

    ina2Found
      ? "found"
      : "not found"
  );
}


// ============================================================
// WIFI CONNECTION
// ============================================================

bool connectWiFi() {

  Serial.println();
  Serial.println("==============================");
  Serial.println("Connecting to WiFi...");
  Serial.println("==============================");

  Serial.print("SSID: ");
  Serial.println(WIFI_SSID);


  WiFi.mode(WIFI_STA);

  WiFi.setAutoReconnect(true);

  WiFi.begin(
    WIFI_SSID,
    WIFI_PASSWORD
  );


  unsigned long start =
    millis();


  while (
    WiFi.status() != WL_CONNECTED &&
    millis() - start < 15000
  ) {

    delay(500);

    Serial.print(".");
  }


  Serial.println();


  if (WiFi.status() == WL_CONNECTED) {

    Serial.println("WiFi connected!");

    Serial.print("IP address: ");

    Serial.println(
      WiFi.localIP()
    );

    Serial.print("RSSI: ");

    Serial.println(
      WiFi.RSSI()
    );

    return true;
  }


  Serial.println("WiFi connection FAILED.");

  return false;
}


// ============================================================
// SETUP
// ============================================================

void setup() {

  Serial.begin(115200);

  delay(1000);


  Serial.println();
  Serial.println();
  Serial.println("========================================");
  Serial.println("ESP32 BATTERY MANAGEMENT SYSTEM");
  Serial.println("========================================");

  const esp_reset_reason_t resetReason = esp_reset_reason();
  brownoutDetected = resetReason == ESP_RST_BROWNOUT;
  Serial.printf("ESP32 reset reason code: %d\n", static_cast<int>(resetReason));
  if (brownoutDetected) {
    Serial.println("ERROR: ESP32 restarted because of a brownout (supply voltage dropped too low).");
  }


  // -------------------------
  // Relay pins
  // -------------------------

  pinMode(RELAY1, OUTPUT);
  pinMode(RELAY2, OUTPUT);
  pinMode(RELAY6, OUTPUT);
  pinMode(RELAY7, OUTPUT);

  pinMode(LED_NORMAL, OUTPUT);
  pinMode(LED_SWITCHING, OUTPUT);


  // Safety

  setAllRelaysOff();


  // -------------------------
  // I2C
  // -------------------------

  Wire.begin(
    SDA_PIN,
    SCL_PIN
  );


  // -------------------------
  // DHT
  // -------------------------

  dht1.begin();

  dht2.begin();


  // -------------------------
  // INA260
  // -------------------------

  ina1Found =
    battery1.begin(0x40);

  ina2Found =
    battery2.begin(0x41);


  // -------------------------
  // Initial sensor read
  // -------------------------

  readSensors();


  // -------------------------
  // Print hardware status
  // -------------------------

  Serial.println();
  Serial.println("========== HARDWARE ==========");

  Serial.print("INA260 Battery 1: ");

  Serial.println(
    ina1Found
      ? "FOUND"
      : "NOT FOUND"
  );

  if (!ina1Found) {
    Serial.println("ERROR: INA260 Battery 1 not found at I2C address 0x40. Check sensor power, SDA/SCL wiring, and address.");
  }


  Serial.print("INA260 Battery 2: ");

  Serial.println(
    ina2Found
      ? "FOUND"
      : "NOT FOUND"
  );

  if (!ina2Found) {
    Serial.println("ERROR: INA260 Battery 2 not found at I2C address 0x41. Check sensor power, SDA/SCL wiring, and address.");
  }


  // -------------------------
  // WiFi
  // -------------------------

  bool wifiConnected =
    connectWiFi();


  if (!wifiConnected) {

    Serial.println();
    Serial.println(
      "WARNING: WiFi unavailable."
    );

    Serial.println(
      "System will continue locally."
    );
  }


  // -------------------------
  // Cloud information
  // -------------------------

  Serial.println();
  Serial.println("========== CLOUD ==========");

  Serial.print("Worker URL: ");

  Serial.println(
    WORKER_BASE_URL
  );

  Serial.println(
    "HTTPS certificate verification: DISABLED"
  );

  Serial.println(
    "Cloudflare Worker -> D1"
  );


  Serial.println();
  Serial.println(
    "ESP32 battery monitor starting."
  );

  Serial.println(
    "Relays are OFF."
  );


  printSerialStatus();
}


// ============================================================
// LOOP
// ============================================================

void loop() {

  const unsigned long now =
    millis();


  // ==========================================================
  // WIFI RECONNECT
  // ==========================================================

  if (
    WiFi.status() != WL_CONNECTED &&
    now - lastWifiAttempt >= WIFI_RETRY_INTERVAL_MS
  ) {

    lastWifiAttempt = now;


    Serial.println(
      "WiFi disconnected. Reconnecting..."
    );


    WiFi.disconnect();

    WiFi.begin(
      WIFI_SSID,
      WIFI_PASSWORD
    );
  }


  // ==========================================================
  // SWITCHING
  // ==========================================================

  if (switching) {

    updateMode2();
  }


  // ==========================================================
  // SENSOR READ
  // ==========================================================

  if (
    now - lastSensorRead >=
    SENSOR_INTERVAL_MS
  ) {

    lastSensorRead = now;

    readSensors();

    printSerialStatus();
  }


  // ==========================================================
  // SEND TELEMETRY
  // ==========================================================

  if (
    now - lastTelemetry >=
    TELEMETRY_INTERVAL_MS
  ) {

    lastTelemetry = now;

    sendTelemetry();
  }


  // ==========================================================
  // POLL CLOUD COMMANDS
  // ==========================================================

  if (
    now - lastCommandPoll >=
    COMMAND_POLL_INTERVAL_MS
  ) {

    lastCommandPoll = now;

    pollCommands();
  }


  // ==========================================================
  // SERIAL MANUAL CONTROL
  // ==========================================================

  if (Serial.available()) {

    const char option =
      Serial.read();


    if (option == '1') {

      setMode1();

    }

    else if (
      option == '2' &&
      !switching
    ) {

      startMode2();

    }

    else if (option == '3') {

      setMode3();
    }
  }
}