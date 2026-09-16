// Витрина счёта на LCD1602 (I2C 0x27, пины 21/22) для ESP32 DevKit.
//
// Эквити и параметры позиции — REST раз в 30с, цена — потоком по WS
// (подписка activeAssetCtx на монету позиции, ~300 байт на кадр). PnL считаем
// локально из szi и entryPx, поэтому нижняя строка живёт в реальном времени.
//
// 🚨 не подписываться на allMids: кадр 19 КБ на 1000+ монет, это память ESP32.
// 🚨 secrets.h в git не едет: WiFi-пароль и адрес кошелька лежат только локально.
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <ArduinoWebsockets.h>
#include <LiquidCrystal_I2C.h>
#include "ca_cert.h"
#include "secrets.h"

using namespace websockets;

static const int PIN_SDA = 21;
static const int PIN_SCL = 22;
static const uint8_t LCD_ADDR = 0x27;
static const uint32_t REST_MS = 30000;
static const uint32_t PING_MS = 30000;

LiquidCrystal_I2C lcd(LCD_ADDR, 16, 2);
WebsocketsClient ws;

static String posCoin;      // монета открытой позиции, пустая — позиции нет
static double posSzi = 0;   // знак = сторона, модуль = размер
static double posEntry = 0;
static String wsCoin;       // на что подписаны сейчас

// Экран узкий: строка ровно 16 символов, хвост режем, недостаток добиваем
// пробелами — иначе на месте коротких значений остаются буквы прошлого кадра.
static void line(uint8_t row, const String &text) {
  String s = text.substring(0, 16);
  while (s.length() < 16) s += ' ';
  lcd.setCursor(0, row);
  lcd.print(s);
}

static bool fetchInfo(const String &body, JsonDocument &doc) {
  WiFiClientSecure client;
  // Без проверки сертификата: на экранчик идут только публичные числа, а
  // хранить и обновлять корневой CA в прошивке дороже, чем эта уступка.
  client.setInsecure();

  HTTPClient http;
  if (!http.begin(client, "https://api.hyperliquid.xyz/info")) return false;
  http.addHeader("Content-Type", "application/json");

  int code = http.POST(body);
  if (code != 200) {
    Serial.printf("[hl] HTTP %d\n", code);
    http.end();
    return false;
  }

  DeserializationError err = deserializeJson(doc, http.getStream());
  http.end();
  if (err) {
    Serial.printf("[hl] json %s\n", err.c_str());
    return false;
  }
  return true;
}

// Эквити unified-аккаунта = spot USDC total, копейка в копейку с accountValue
// из info-эндпоинта portfolio.
//
// 🚨 не прибавлять сюда unrealizedPnl: залог hold внутри spot уже переоценён
// по рынку, и убыток вычтется дважды.
static bool readEquity(double &equity) {
  JsonDocument doc;
  String body = String("{\"type\":\"spotClearinghouseState\",\"user\":\"") + HL_WALLET + "\"}";
  if (!fetchInfo(body, doc)) return false;

  for (JsonObject b : doc["balances"].as<JsonArray>()) {
    if (strcmp(b["coin"] | "", "USDC") == 0) {
      equity = b["total"].as<String>().toDouble();
      return true;
    }
  }
  return false;
}

// Берём позицию с наибольшим модулем PnL: на 16 символах смысл показывать ту,
// что сейчас решает исход дня.
static void readPosition() {
  JsonDocument doc;
  String body = String("{\"type\":\"clearinghouseState\",\"user\":\"") + HL_WALLET + "\"}";
  if (!fetchInfo(body, doc)) return;

  double bestAbs = -1;
  String coin;
  double szi = 0, entry = 0;

  for (JsonObject ap : doc["assetPositions"].as<JsonArray>()) {
    JsonObject p = ap["position"];
    double pnl = fabs(p["unrealizedPnl"].as<String>().toDouble());
    if (pnl > bestAbs) {
      bestAbs = pnl;
      coin = String(p["coin"] | "");
      szi = p["szi"].as<String>().toDouble();
      entry = p["entryPx"].as<String>().toDouble();
    }
  }

  posCoin = coin;
  posSzi = szi;
  posEntry = entry;
}

static void drawPnl(double markPx) {
  if (posCoin.isEmpty()) {
    line(1, "no position");
    return;
  }
  double pnl = posSzi * (markPx - posEntry);
  line(1, posCoin + " " + (posSzi < 0 ? "S" : "L") + " " +
              (pnl >= 0 ? "+" : "") + String(pnl, 2));
}

static void onWsMessage(WebsocketsMessage msg) {
  JsonDocument doc;
  if (deserializeJson(doc, msg.data())) return;
  if (strcmp(doc["channel"] | "", "activeAssetCtx") != 0) return;

  double markPx = doc["data"]["ctx"]["markPx"].as<String>().toDouble();
  if (markPx > 0) drawPnl(markPx);
}

// Переподписка нужна при смене монеты: подписка привязана к активу.
static void wsResubscribe() {
  if (posCoin == wsCoin || posCoin.isEmpty()) return;

  if (!ws.available()) {
    // 🚨 не setInsecure(): у этой библиотеки он работает только на ESP8266,
    // на ESP32 молча оставляет клиента без корня доверия и connect падает.
    ws.setCACert(HL_ROOT_CA);
    ws.onMessage(onWsMessage);
    if (!ws.connect("wss://api.hyperliquid.xyz/ws")) {
      Serial.println("[ws] connect failed");
      return;
    }
    Serial.println("[ws] connected");
  }

  ws.send(String("{\"method\":\"subscribe\",\"subscription\":{\"type\":\"activeAssetCtx\",\"coin\":\"") +
          posCoin + "\"}}");
  wsCoin = posCoin;
  Serial.printf("[ws] subscribed %s\n", posCoin.c_str());
}

void setup() {
  Serial.begin(115200);
  Wire.begin(PIN_SDA, PIN_SCL);
  lcd.init();
  lcd.backlight();
  line(0, "HL SCANNER");
  line(1, "wifi...");

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  // Пики тока передатчика проваливают напряжение, и подсветка LCD дрожит в такт.
  WiFi.setTxPower(WIFI_POWER_11dBm);
  WiFi.setSleep(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

void loop() {
  static uint32_t lastRest = 0, lastPing = 0;

  if (WiFi.status() != WL_CONNECTED) {
    line(1, "wifi...");
    delay(500);
    return;
  }

  if (ws.available()) ws.poll();

  uint32_t now = millis();

  if (lastRest == 0 || now - lastRest >= REST_MS) {
    lastRest = now;
    double equity = 0;
    if (readEquity(equity)) {
      line(0, "EQ $" + String(equity, 2));
      Serial.printf("[hl] equity=%.2f\n", equity);
    }
    readPosition();
    wsResubscribe();
    if (posCoin.isEmpty()) line(1, "no position");
  }

  // Молчащее соединение рвут посредники: пингуем, пока ждём кадров.
  if (ws.available() && now - lastPing >= PING_MS) {
    lastPing = now;
    ws.ping();
  }

  delay(20);
}
