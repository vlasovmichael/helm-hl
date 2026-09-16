// Витрина счёта на LCD1602 (I2C 0x27, пины 21/22) для ESP32 DevKit.
// Данные тянем прямо у Hyperliquid по публичному адресу кошелька: ключей не
// нужно, экран не зависит ни от дашборда, ни от прода.
//
// 🚨 secrets.h в git не едет: WiFi-пароль и адрес кошелька лежат только локально.
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <LiquidCrystal_I2C.h>
#include "secrets.h"

static const int PIN_SDA = 21;
static const int PIN_SCL = 22;
static const uint8_t LCD_ADDR = 0x27;
static const uint32_t POLL_MS = 15000;

LiquidCrystal_I2C lcd(LCD_ADDR, 16, 2);

// Экран узкий: строка ровно 16 символов, хвост режем, недостаток добиваем
// пробелами — иначе на месте коротких значений остаются буквы прошлого кадра.
static void line(uint8_t row, const String &text) {
  String s = text.substring(0, 16);
  while (s.length() < 16) s += ' ';
  lcd.setCursor(0, row);
  lcd.print(s);
}

static bool fetchInfo(const char *type, JsonDocument &doc) {
  WiFiClientSecure client;
  // Без проверки сертификата: на экранчик идут только публичные числа, а
  // хранить и обновлять корневой CA в прошивке дороже, чем эта уступка.
  client.setInsecure();

  HTTPClient http;
  if (!http.begin(client, "https://api.hyperliquid.xyz/info")) return false;
  http.addHeader("Content-Type", "application/json");

  String body = String("{\"type\":\"") + type + "\",\"user\":\"" + HL_WALLET + "\"}";
  int code = http.POST(body);
  if (code != 200) {
    Serial.printf("[hl] %s: HTTP %d\n", type, code);
    http.end();
    return false;
  }

  DeserializationError err = deserializeJson(doc, http.getStream());
  http.end();
  if (err) {
    Serial.printf("[hl] %s: json %s\n", type, err.c_str());
    return false;
  }
  return true;
}

// Вторая строка — самая крупная позиция по модулю нереализованного PnL:
// на 16 символах имеет смысл показывать ту, что сейчас решает исход дня.
static String biggestPosition(JsonDocument &perp) {
  const char *coin = nullptr;
  double bestAbs = -1, bestPnl = 0, bestSzi = 0;

  for (JsonObject ap : perp["assetPositions"].as<JsonArray>()) {
    JsonObject p = ap["position"];
    double pnl = p["unrealizedPnl"].as<String>().toDouble();
    if (fabs(pnl) > bestAbs) {
      bestAbs = fabs(pnl);
      bestPnl = pnl;
      bestSzi = p["szi"].as<String>().toDouble();
      coin = p["coin"];
    }
  }

  if (!coin) return "no position";
  return String(coin) + " " + (bestSzi < 0 ? "S" : "L") + " " +
         (bestPnl >= 0 ? "+" : "") + String(bestPnl, 2);
}

// Эквити unified-аккаунта = spot USDC total, копейка в копейку с accountValue
// из info-эндпоинта portfolio.
//
// 🚨 не прибавлять сюда unrealizedPnl: залог hold внутри spot-баланса уже
// переоценён по рынку, и убыток вычтется дважды.
// 🚨 не marginSummary.accountValue: это стоимость только перп-части счёта.
static bool readEquity(double &equity) {
  JsonDocument spot;
  if (!fetchInfo("spotClearinghouseState", spot)) return false;

  for (JsonObject b : spot["balances"].as<JsonArray>()) {
    if (strcmp(b["coin"] | "", "USDC") == 0) {
      equity = b["total"].as<String>().toDouble();
      return true;
    }
  }
  return false;
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
  // Опрос раз в 15с не требует полной мощности: 11 dBm дома хватает с запасом.
  WiFi.setTxPower(WIFI_POWER_11dBm);
  WiFi.setSleep(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

void loop() {
  static uint32_t lastPoll = 0;

  if (WiFi.status() != WL_CONNECTED) {
    line(1, "wifi...");
    delay(500);
    return;
  }

  if (millis() - lastPoll < POLL_MS && lastPoll != 0) {
    delay(200);
    return;
  }
  lastPoll = millis();

  JsonDocument perp;
  if (!fetchInfo("clearinghouseState", perp)) {
    line(1, "API error");
    return;
  }

  double equity = 0;
  if (readEquity(equity)) {
    line(0, "EQ $" + String(equity, 2));
    Serial.printf("[hl] equity=%.2f\n", equity);
  }
  line(1, biggestPosition(perp));
}
