# Reklamacja — Play, usługa internetowa (modem kablowy DOCSIS)

**Do:** ok@pomocplay.pl
**Adres pocztowy (gdyby brak odpowiedzi):** P4 Sp. z o.o., Skrytka pocztowa 41, 02-671 Warszawa
**Temat:** Reklamacja usługi internetowej — awaria toru zwrotnego, przerwy w usłudze — nr abonenta [NUMER]

---

Szanowni Państwo,

na podstawie art. 106 ustawy Prawo komunikacji elektronicznej składam reklamację
dotyczącą nienależytego wykonywania usługi telekomunikacyjnej — wielokrotnych,
powtarzalnych przerw w dostępie do internetu.

**Dane abonenta i urządzenia**

- Imię i nazwisko: [IMIĘ NAZWISKO]
- Adres świadczenia usługi: [ULICA, KOD, MIASTO]
- Numer abonenta / numer umowy: [NUMER]
- Modem/router (urządzenie Operatora): **Compal CH7465PLAY**, DOCSIS 3.0
- Wersja sprzętowa: 5.01, oprogramowanie: CH7465PLAY-NCIP-6.15.32p5-GA-NOSH
- Cable MAC: **34:2C:C4:B0:83:A1**, numer seryjny modemu: **DEAP91280A4D**
- CMTS MAC: **24:7E:12:F0:E3:25**

---

## 1. Opis problemu

Usługa jest przerywana wielokrotnie w ciągu doby. Przerwy dotyczą **wszystkich
urządzeń w lokalu jednocześnie** (telefon komórkowy, laptopy) — nie są to zaniki
sieci Wi-Fi pojedynczego urządzenia. W dniu składania reklamacji odnotowałem
kilkanaście przerw, w tym pięć w ciągu jednej godziny.

## 2. Dowód: dane diagnostyczne z Państwa własnego urządzenia

Wszystkie poniższe dane pochodzą z panelu diagnostycznego modemu dostarczonego
przez Operatora (`Advanced settings → Tools → Network status`), odczytane
**17.08.2026 o godz. 15:08**.

### 2.1. Liczniki przekroczeń czasu w torze zwrotnym (upstream)

Liczniki narosły od ostatniego restartu modemu, tj. w ciągu **3 dni i 19 godzin**:

| Kanał upstream | T1 | T2 | **T3 timeouts** | **T4 timeouts** |
|---|---|---|---|---|
| 1 (29,2 MHz) | 0 | 0 | 33 | 22 |
| 2 (61,1 MHz) | 0 | 0 | 43 | 46 |
| 3 (41,0 MHz) | 0 | 0 | 34 | 23 |
| 4 (54,4 MHz) | 0 | 0 | 7 | 0 |
| 5 (47,7 MHz) | 0 | 0 | 37 | 23 |
| 6 (34,3 MHz) | 0 | 0 | 32 | 23 |
| **Razem** | 0 | 0 | **186** | **137** |

**137 przekroczeń czasu T4 w ciągu niecałych czterech dób.** Zgodnie ze
specyfikacją DOCSIS przekroczenie czasu T4 oznacza brak odpowiedzi na
utrzymanie stacji (station maintenance) i **wymusza ponowną rejestrację modemu
w sieci** — czyli każdorazowo zerwanie połączenia dla wszystkich urządzeń
w lokalu. Na prawidłowo działającym łączu licznik T4 powinien wynosić **zero**.

### 2.2. Wpisy krytyczne w dzienniku modemu

W dzienniku (`Network Log`) widnieją wpisy o priorytecie **critical**:

> `No Ranging Response received - T3 time-out`

Wpisy z ostatnich trzech dni (dziennik nie sięga dalej):
17.08 godz. 14:16:34, 13:06:16, 00:10:01; 16.08 godz. 20:58:26;
15.08 godz. 19:23:47, 05:06:34, 03:31:13; 14.08 godz. 18:28:24, 10:29:24.

Modem wysyła żądania ranging do Państwa CMTS i **nie otrzymuje odpowiedzi**.

### 2.3. Tor odbiorczy (downstream) jest sprawny — usterka jest w torze zwrotnym

| Parametr | Wartość | Ocena |
|---|---|---|
| Moc downstream | +7 do +9 dBmV (24 kanały) | w normie |
| SNR / RxMER downstream | 37–39 dB, modulacja 256QAM | w normie |
| Status kanałów downstream | wszystkie 24 „Locked" | w normie |
| Moc upstream | 40–41 dBmV | podwyższona |
| **T3 / T4 upstream** | **186 / 137** | **awaria** |

Zestawienie to wyklucza usterkę po stronie abonenta. Tor odbiorczy pracuje
poprawnie, natomiast tor zwrotny (od lokalu do stacji czołowej) generuje
setki przekroczeń czasu. Wskazuje to na zakłócenia lub uszkodzenie
w **infrastrukturze kablowej Operatora** — odcinku sieci, wzmacniaczu,
odgałęźniku lub przyłączu.

### 2.4. Niezależny monitoring potwierdza skutki

Równolegle prowadzę ciągły monitoring dostępności łącza (sondowanie trzech
niezależnych adresów co 2 sekundy, **1 094 372 próbki w ciągu 624,9 godzin**,
okres 18.07–17.08.2026). Wyniki:

- **294 przerwy w dostępie do internetu**, łącznie **3 godziny 24 minuty**;
- najdłuższa przerwa: **70 minut, 13.08.2026 w godz. 18:37–19:47**.

Godzina zakończenia tej przerwy pokrywa się z czasem ostatniego restartu modemu
(licznik `System up time` wskazywał 3 dni 19 godz. 22 min o godz. 15:07 dnia
17.08.2026, co daje moment startu **13.08.2026 ok. godz. 19:45**). Innymi słowy
modem po 70 minutach braku łączności **zrestartował się samoczynnie**.

## 3. Żądania

W związku z powyższym wnoszę o:

1. **Wizytę technika i pomiar toru zwrotnego** pod moim adresem —
   ze sprawdzeniem przyłącza, odgałęźnika i odcinka sieci, oraz usunięcie
   źródła zakłóceń powodujących przekroczenia czasu T3 i T4.
2. **Wymianę modemu** na sprawne urządzenie, jeżeli pomiary wykluczą usterkę
   sieci — urządzenie samoczynnie się restartuje.
3. **Obniżenie opłaty abonamentowej** za okres, w którym usługa nie była
   świadczona w sposób nieprzerwany, wraz z podaniem sposobu wyliczenia.
4. **Podanie liczby zgłoszeń awarii z mojego węzła** w okresie ostatnich
   30 dni — jeżeli usterka dotyczy odcinka wspólnego, powinna być Państwu znana.

## 4. Uwagi formalne

- Zgodnie z art. 107 Prawa komunikacji elektronicznej oczekuję odpowiedzi
  w terminie **14 dni**. Brak odpowiedzi w tym terminie oznacza uznanie
  reklamacji.
- Proszę o odpowiedź **w formie pisemnej (e-mail)**, nie telefonicznie.
- Proszę o nadanie sprawie numeru i podanie go w odpowiedzi.
- Uprzejmie proszę o **nieodsyłanie mnie do restartu urządzenia** — modem
  restartował się samoczynnie, a liczniki T3/T4 narosły po tym restarcie.
- W razie nieuwzględnienia reklamacji skorzystam z drogi postępowania przed
  Prezesem Urzędu Komunikacji Elektronicznej.

**Załączniki:**

1. Zrzut ekranu: liczniki T3/T4 kanałów upstream (panel modemu, 17.08.2026)
2. Zrzut ekranu: dziennik zdarzeń modemu z wpisami „No Ranging Response received – T3 time-out"
3. Zrzut ekranu: parametry downstream (moc, SNR)
4. Raport dostępności łącza za okres 18.07–17.08.2026 wraz z rejestrem 294 zdarzeń

Z poważaniem,
[IMIĘ NAZWISKO]
[TELEFON]
[E-MAIL]

---

## Notatki dla mnie (nie wysyłać)

### Dowody — stan 17.08.2026

- 🔑 Rdzeń sprawy: **T4 = 137 w 3 dni 19 godz.** Na sprawnym łączu ma być 0.
  T4 wymusza ponowną rejestrację modemu → zrywa łącze wszystkim urządzeniom.
- 🔑 Downstream czysty (moc +7…+9 dBmV, SNR 37–39 dB, 24× Locked) → wina
  nie leży po stronie abonenta. To zdanie zamyka odpowiedź „proszę zrestartować".
- 🔑 `System up time` 3d19h22m ↔ 70-minutowa przerwa 13.08 18:37–19:47 z monitoringu.
  Dwa niezależne źródła, zbieżność co do minuty.
- Telefon też traci internet (ok. 10× dziennia) → drugi punkt obserwacji,
  hipoteza „to Wi-Fi Surface" odpada.

### Zrzut kontrolny 20.08.2026 (przed planowanym restartem)

Odczyt o godz. 09:43–09:59, katalog `~/Desktop/play/`, 9 plików.

| Parametr | 17.08 15:08 | 20.08 09:43 |
|---|---|---|
| T3 timeouts (razem) | 186 | **190** |
| T4 timeouts (razem) | 137 | **137** |
| System up time | 3d 19h 22m | **6d 14h 11m** |
| Downstream | +7…+9 dBmV, SNR 37–39, 24× Locked | bez zmian |

- 🔑 Uptime 6d14h11m o godz. 09:59 dnia 20.08 ⇒ start **13.08.2026 o 19:48**.
  Monitoring dał koniec 70-minutowej przerwy o **19:47**. Zbieżność co do minuty,
  drugi niezależny pomiar. Modem od 13.08 się nie restartował ⇒ liczniki
  190/137 narosły w **jednym oknie 6,5 doby**.
- ⚠️ T4 nie urósł od 17.08 (nadal 137) — ostra faza była 13–17.08. Jeżeli
  technik powie „teraz jest dobrze", odpowiedź to dziennik: wpisy critical
  `No Ranging Response - T3 time-out` z 17.08 23:19, 18.08 11:19 i 13:30,
  19.08 15:39. Awaria jest okresowa, nie minęła.
- Ścieżka do uptime i numeru seryjnego: `Admin → Info` (nie zakładka Status).

### Restart modemu 20.08.2026, godz. 10:03

Wykonany **ręcznie przeze mnie** (nie na polecenie Operatora — Play zalecał
twardy reset, którego nie wykonałem i nie wykonam; to był zwykły restart już
po zabezpieczeniu dowodów). Liczniki T3/T4, dziennik i `System up time`
wyzerowały się w tym momencie.

Dokładny czas z niezależnego monitoringu: przerwa **10:03:07 → 10:08:20**
(5 min 13 s = sam restart) oraz **10:10:30 → 10:11:11** (41 s = ponowna
rejestracja modemu w sieci po starcie).

Dla porządku — przerwy z doby poprzedzającej restart, 19.08.2026:
12:48:26 (12 s), 15:45:15 (27 s), 15:55:26 (17 s), 16:53:13 (20 s),
22:04:28 (16 s), 22:05:43 (19 s), 22:06:54 (17 s), 22:56:20 (13 s).
Trzy pod rząd w godz. 22:04–22:07 — charakterystyczny wzorzec ponawianego
rangingu. Usterka trwała więc **nadal w dniu poprzedzającym restart**.

- Poprzednie okno pomiarowe: **13.08.2026 19:48 → 20.08.2026 10:03**
  (6 dni 14 godz.), wynik **T3 = 190, T4 = 137**. Udokumentowane zrzutami
  z 17.08 i 20.08.
- Nowe okno liczy się od **20.08.2026 10:08**. Za 2–3 dni sprawdzić
  `Advanced settings → Tools → Network status → Upstream`. Jeżeli liczniki
  znów urosną — będą dwa niezależne okna i teza „jednorazowa usterka" upada.

### Czego świadomie NIE piszemy

- ⛔ **Nie ma zarzutu o prędkość.** MacBook na 5 GHz dał 227 Mbps —
  zarzut „5% z 600" byłby nieprawdziwy i wywróciłby całe pismo.
- ⛔ Nie piszemy o `[DFS] Radar signal detected, channel changed 112 → 48`
  (14.08 10:08) — to zachowanie zgodne z prawem, nie usterka, choć tłumaczy
  część zaników Wi-Fi na 5 GHz.
- ⛔ Nie powołujemy się na „Pre RS Errors 11,2 mld" z zakładki Downstream —
  wartość jest identyczna na wszystkich 24 kanałach, więc to najpewniej
  licznik słów kodowych, a nie błędów. Post RS Errors są niskie (36–202).

### Gdzie w panelu leżą dowody

`http://192.168.0.1` → Advanced settings → Tools → Network status →
zakładki **Upstream** (liczniki T3/T4), **Network Log** (wpisy critical),
**Downstream** (moc i SNR). Licznikami rządzi restart — **zrzuty zrobić przed
jakimkolwiek restartem modemu**, inaczej dowód wyzeruje się.

### Przyrząd ISP Watchdog — do poprawienia

- Host 192.168.0.108 stoi na Wi-Fi (w lokalu nie ma urządzeń na kablu —
  panel modemu pokazuje 8 urządzeń bezprzewodowych, 0 na Ethernet).
- Dlatego podział zdarzeń na `local` / `isp` jest **niewiarygodny** i w tej
  sprawie okazał się mylący (287 „local" vs 7 „isp", a faktyczną przyczyną
  była sieć operatora).
- Do zrobienia: odpytywać panel modemu o liczniki T3/T4 i wciągać je do bazy —
  wtedy przyrząd sam rozdzieli awarię operatora od zaników Wi-Fi.

### Komendy do załączników

```
curl -o raport.txt   "http://192.168.0.108:8084/report?days=30"
curl -o zdarzenia.csv "http://192.168.0.108:8084/events.csv?days=30"
curl -o probki.csv    "http://192.168.0.108:8084/export.csv?days=30"
```
