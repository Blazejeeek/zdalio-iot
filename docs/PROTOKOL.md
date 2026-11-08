# Protokół komunikacyjny IoT Zdalio (MQTT) – wersja 1 (zaakceptowana 08.11.2026, tematy wg komentarza użytkownika)

Dotyczy: urządzenia IoT ↔ broker MQTT ↔ serwer pośredniczący („most”) ↔ Supabase. Moduły: e-drukarka (pierwszy), brama, liczniki, wizualizacja, ekrany, e-schrony.
Dokument jest kontraktem dla autorów firmware'u i serwera. Słowa MUSI / NIE WOLNO są wiążące.

## 1. Zasady

1. Temat zawiera **typ urządzenia i jego niezmienny numer seryjny**, nie obiekt ani klienta. Typ pozwala uruchamiać osobne serwery pośredniczące dla drukarek, bram czy ekranów. Przeniesienie lub wymiana urządzenia nie zmienia firmware'u ani ACL.
2. O przypisaniu urządzenia do obiektu i klienta decyduje tylko baza. Pola o obiekcie wysłane przez urządzenie to informacja, nie autorytet.
3. Tożsamość nadawcy wynika z tematu sprawdzonego przez ACL brokera. Identyfikator w treści, jeśli jest, musi się zgadzać z tematem.
4. Urządzenia nie rozmawiają ze sobą. Komunikuje się tylko para urządzenie ↔ most.
5. Dane ważne (zdarzenia) są potwierdzane **po zapisie w bazie**. PUBACK MQTT oznacza tylko przyjęcie przez broker.
6. Każda wiadomość jest idempotentna: duplikat niczego nie psuje.
7. Nieznane pola się ignoruje, nowe pola nie zmieniają wersji. Zmiana niezgodna = nowa wersja w temacie (`v2`).

## 2. Identyfikatory: egzemplarz i miejsce montażu

Wymiana zepsutej drukarki ma zachować historię, dlatego rozdzielamy dwa pojęcia:

| Pojęcie | Znaczenie | Przykład | Trwałość |
|---|---|---|---|
| **Egzemplarz** (`hw_id`) | fizyczna płytka; logowanie do brokera, tematy | `7K3M-9QXT-4AB` | na całe życie płytki |
| **Punkt** (`point_id`, UUID) | logiczna rola w obiekcie: „Drukarka centrali, Galeria Północ”; do niego należy historia | wiersz `printers` / `gates` / `meters` | niezależny od sprzętu |
| **Powiązanie** (`device_bindings`) | który egzemplarz obsługuje który punkt, od kiedy do kiedy | `valid_from`, `valid_to` | pełna historia zmian |

**Format numeru seryjnego `hw_id`:** 48 bitów adresu MAC (eFuse) zapisane w Crockford Base32 (10 znaków) + 1 znak kontrolny (mod 37).
- Numer jest **programowany w urządzeniu** (NVS) przy produkcji, razem z typem i hasłem. Narzędzie produkcyjne wylicza go z MAC, więc jest niepowtarzalny bez centralnej puli, a znak kontrolny wyłapuje literówkę przy wpisywaniu.
- Urządzenie bez zaprogramowanego numeru NIE łączy się z brokerem produkcyjnym.
- W tematach i bazie: wielkie litery, bez myślników (`7K3M9QXT4AB`). Na etykiecie i w aplikacji: grupy z myślnikami i kod QR. Aplikacja przy wpisywaniu zamienia `O→0`, `I/L→1`, małe litery na wielkie i usuwa myślniki.
- Urządzenie bez własnego MAC-a dostaje numer z rejestru z ustawionym bitem „locally administered”.
- Identyfikator nie jest sekretem. Sekretem jest hasło urządzenia (rozdział 8).

**Dotychczasowy numer** (`TS-RS485-188B0E9283A4`, `shellyplus1-…`) zostaje w polu `vendor_sn` jako informacja.

**Wymiana urządzenia** (funkcja `replace_device(point_id, nowy_hw_id)`, wywoływana w aplikacji):
1. Zamyka powiązanie starego egzemplarza (`valid_to = now()`) i otwiera powiązanie nowego.
2. Unieważnia dane logowania starego egzemplarza, gdy wymiana jest trwała.
3. Historia zostaje przy punkcie, a każdy wpis pamięta, z którego egzemplarza pochodzi.
4. Spóźnione dane starego egzemplarza trafiają do punktu zgodnie z chwilą powiązania obowiązującą dla ich `ts`. Dane bez wiarygodnego czasu idą do kwarantanny.

**Podurządzenia** (liczniki za bramką M-Bus, kilka wejść sterownika): jedno logowanie i jeden `hw_id` bramki, a podurządzenie wskazuje pole `sub` w treści (np. numer licznika).

## 3. Drzewo tematów

Prefiks: `<typ>/<hw_id>/v1/`, np. `e-print/7K3M9QXT4AB/v1/evt/ssp`

| Typ | Urządzenia |
|---|---|
| `e-print` | e-drukarka (bramka RS485, #75) |
| `e-gate` | brama, szlaban |
| `e-meter` | liczniki |
| `e-viz` | wizualizacja |
| `e-screen` | ekrany |
| `e-shelter` | e-schrony |

Nowy rodzaj urządzenia = nowy typ, bez zmian w firmware istniejących urządzeń. Wymiana (rozdział 2) jest możliwa tylko w obrębie tego samego typu. Typ w temacie musi się zgadzać z typem urządzenia w bazie; niezgodność = kwarantanna.

| Temat (po prefiksie) | Kierunek | QoS | Retain | Zastosowanie |
|---|---|---|---|---|
| `status` | ↑ | 1 | tak | `online` / `offline`, także Last Will |
| `info` | ↑ | 1 | tak | metryczka: firmware, model, moduły, konfiguracja |
| `tele/<nazwa>` | ↑ | 0 | nie | telemetria okresowa, strata jednej próbki bez znaczenia |
| `evt/<nazwa>` | ↑ | 1 | nie | zdarzenia wymagające zapisu; potwierdzane przez `ack` |
| `ack` | ↓ | 1 | nie | potwierdzenie zapisu zdarzeń |
| `cmd/<nazwa>` | ↓ | 1 | nie | polecenie |
| `res` | ↑ | 1 | nie | wynik polecenia |
| `cfg` | ↓ | 1 | tak | konfiguracja żądana |

`<nazwa>` zależy od typu (rozdział 6). Nazwa `sys` jest wspólna dla wszystkich typów (`tele/sys`, `cmd/sys/rotate`).

Retain stosujemy tylko do stanu (`status`, `info`, `cfg`). Polecenia NIE MOGĄ być retained: brama nie może otworzyć się po restarcie brokera lub urządzenia.

## 4. Koperta wiadomości

Treść to JSON w UTF-8, maks. **1024 B** (limit bufora firmware'u; większe dane dzielimy na części, patrz 5.3).

```json
{"v":1,"boot":"a1b2c3d4","seq":1290,"ts":"2026-11-03T18:40:00.123Z","ts_ok":true,"up_ms":5234567,"data":{}}
```

| Pole | Typ | Znaczenie |
|---|---|---|
| `v` | int | wersja schematu treści danego modułu |
| `boot` | string, 8 hex | losowy identyfikator uruchomienia, nowy przy każdym starcie |
| `seq` | int | licznik rosnący od 0 w ramach `boot`, wspólny dla `evt` |
| `ts` / `ts_ok` | string lub null / bool | czas UTC z NTP; przy `ts_ok:false` jest `ts:null` |
| `up_ms` | int | czas od startu |
| `sub` | string, opcjonalne | podurządzenie |
| `data` | obiekt | treść zależna od modułu |

**Klucz deduplikacji zdarzenia:** (`hw_id`, `boot`, `seq`). Ten sam klucz z inną treścią = błąd integralności i alarm techniczny; rekord nie jest nadpisywany.

Losowy `boot` zastępuje obecny licznik uruchomień, który wyzerowałby się po skasowaniu pamięci i dałby powtórzone klucze. W bazie `boot_id` (UUID) = UUIDv5 z (`hw_id`, `boot`), więc kolumna się nie zmienia.

## 5. Przepływy

### 5.1. Start i obecność

1. Połączenie z LWT `status` = `{"st":"offline"}`, retain, QoS 1, `clean session = true`, keepalive 60 s. Sesja czysta jest celowa: polecenia wysłane do niedostępnego urządzenia nie czekają w brokerze, tylko kończą się statusem `timeout`, a utracony `ack` naprawia ponowne wysłanie zdarzenia.
2. Publikacja `status` = `{"st":"online","boot":"…"}` oraz `info`, potem subskrypcja `cmd/#`, `ack`, `cfg`.
3. Subskrypcje współdzielone (`$share`) nie dostają wiadomości retained, dlatego instancja mostu po starcie czyta stan z `status` i `info` zwykłą subskrypcją, a następnie ją zamyka. Zapis stanu jest idempotentny.
4. `tele/sys` co 60 s (obecne pole `stats`). Most oznacza urządzenie jako niedostępne, gdy przez 120 s nie przyszło nic (parametr).

### 5.2. Zdarzenie z potwierdzeniem

```
urządzenie                broker           most                     baza
  | evt/ssp          ---->  |  ---$share--> |  ingest_event() COMMIT --> |
  | <---- ack (po zapisie)  | <------------ |                            |
  usuwa z bufora
```

- Odpowiedź w `ack`: `{"boot":"a1b2c3d4","upto":1290}` (wszystko do `upto` zapisane) lub `{"boot":"…","seq":[1288,1290]}`.
- Brak `ack` po 30 s → ponowne wysłanie z tym samym `boot` i `seq`, narastające opóźnienie do 5 min, wysyłane najstarsze jako pierwsze.
- Duplikat dostaje kolejny `ack` bez nowego rekordu.
- Gdy nie działa żadna instancja mostu, broker może odrzucić wiadomość. Brak `ack` powoduje ponowne wysłanie, więc zdarzenie nie ginie, dopóki mieści się w buforze urządzenia.
- Kolejność dostarczenia nie jest gwarantowana przy wielu instancjach. Kolejność ustala baza po (`boot`, `seq`), nigdy kolejność przyjścia.
- Przy awarii bazy most nie wysyła `ack`. Urządzenie buforuje, a przepełnienie zgłasza licznikiem `lost` w `tele/sys`.

### 5.3. Dane większe niż limit

Ramka podzielona: `data` zawiera `part` (od 1), `parts` i `msg` (identyfikator całości). Każda część to osobne zdarzenie z własnym `seq`; most składa całość po `msg`.

### 5.4. Polecenie i wynik (np. otwarcie bramy)

```
aplikacja -> gate_open() [uprawnienia w bazie] -> wiersz device_commands (pending)
most (claim: FOR UPDATE SKIP LOCKED) -> cmd/open -> urządzenie -> res -> most -> status done/failed
```

```json
{"v":1,"cid":"01JC8Z4M","exp":1793893200,"data":{"pulse_ms":800}}
```
```json
{"cid":"01JC8Z4M","st":"ok","data":{"limit":"open"}}
```

- `cid`: identyfikator polecenia; urządzenie pamięta ostatnie 16 i nie wykonuje drugi raz, tylko powtarza wynik.
- `exp`: ważność (UTC, sekundy). Po czasie albo bez wiarygodnego zegara dla poleceń niebezpiecznych urządzenie NIE wykonuje, zwraca `st:"expired"`.
- `st`: `ok`, `err`, `expired`, `busy`, `unsupported` + opcjonalne `code`, `msg`.
- Brak `res` w czasie zależnym od polecenia (brama: 5 s) → status `timeout` i komunikat w aplikacji. Most **nie ponawia** poleceń niebezpiecznych automatycznie.
- Polecenia niebezpieczne z QoS 1 korzystają z ochrony przez `cid` i `exp`.

### 5.5. Konfiguracja

`cfg` (retained) zawiera `{"rev":17,"data":{…}}`. Urządzenie stosuje konfigurację i potwierdza numer w `info.cfg_rev`. Różnica `rev` = konfiguracja niezastosowana.

## 6. Moduły

| Typ | Tematy (po prefiksie) | Zapis w bazie | Uwagi |
|---|---|---|---|
| **e-print** | `evt/ssp`, `evt/raw`, `tele/printer`, `cmd/send` | `raw_messages` + zdarzenia | `data` = obecny format z `docs/MQTT.md`. Deduplikacja historii centrali: (`nr`, `czas`, `linie[0]`). Bosch SSP i kolejne centrale rozróżnia `protokol` |
| **e-gate** | `cmd/open`, `res`, `evt/input`, `tele/gate` | `gate_actions`, `device_commands` | Faza A: Shelly przez adapter (rozdział 7) |
| **e-meter** | `tele/meter` lub `evt/reading` | `meter_readings` | odczyty rozliczeniowe jako `evt`; bieżące jako `tele`; `sub` = numer licznika |
| **e-viz** | `tele/viz`, `evt/state` | do uzgodnienia z modułem SSP | na razie tylko rezerwacja nazwy |
| **e-screen** | `cmd/refresh`, `status` | `screens` | ekrany obecnie działają przez publiczny link; MQTT opcjonalnie |
| **e-shelter** | `cmd/*` | do zaprojektowania | automatyczne otwieranie drzwi na alert RCB wymaga osobnej analizy bezpieczeństwa, nie wchodzi w v1 |

## 7. Urządzenia obcych producentów

Most ma warstwę **adapterów** tłumaczących cudzy format na model wewnętrzny (zdarzenie, polecenie, stan). Shelly Gen2+ ustawiamy na prefiks `e-gate/<hw_id>/shelly`, a temat `<prefix>/rpc` i odpowiedzi obsługuje adapter. ACL ma osobną regułę na gałąź `shelly`. Identyfikator, wymiana i historia działają tak samo.

## 8. Bezpieczeństwo

Reguły są niezależne od brokera: `${username}` w EMQX odpowiada `%u` w Mosquitto.

| Odcinek | Mechanizm |
|---|---|
| Urządzenie → broker | MQTT przez TLS (`cezary173.mikrus.xyz:40022`) z weryfikacją serwera względem własnego CA wgranego do firmware'u, bez corocznej wymiany; `username` = `hw_id`, indywidualne hasło przechowywane w bazie tylko jako skrót |
| Most → broker | osobne konto serwisowe, TLS lub sieć wewnętrzna Dockera; oddzielne hasło na środowisko |
| Most → baza | połączenie Postgres, własna rola `iot_bridge` z dostępem tylko do funkcji `ingest_*` i `device_commands`, bez `service_role` |
| Aplikacja → urządzenie | zawsze przez bazę i most; aplikacja nie łączy się z brokerem |

**Reguły ACL (domyślnie wszystko zabronione):**

| Kto | Akcja | Temat |
|---|---|---|
| urządzenie `${username}` | publikuje | `+/${username}/v1/status`, `info`, `tele/#`, `evt/#`, `res` |
| urządzenie `${username}` | subskrybuje | `+/${username}/v1/cmd/#`, `ack`, `cfg` |
| konto `bridge` | subskrybuje | `<typ>/+/v1/#` i `e-gate/+/shelly/#` (także przez `$share/<typ>/…`) |
| konto `bridge` | publikuje | `<typ>/+/v1/cmd/#`, `ack`, `cfg` |
| wszyscy inni | – | zabronione w gałęziach `e-*/#` |

Dzięki tym regułom urządzenia nie widzą się nawzajem, a przejęcie jednego nie daje dostępu do pozostałych. Znak `+` na pozycji typu pozwala urządzeniu użyć innego typu tylko dla własnego numeru; taką wiadomość odrzuca most (rozdział 3). Każdy typ może mieć osobne konto mostu, np. `bridge-e-print`, ograniczone do swojej gałęzi.

Dane logowania: hasło generuje narzędzie produkcyjne i zapisuje w NVS, w bazie zostaje skrót. Wymiana hasła = polecenie `cmd/sys/rotate` z potwierdzeniem i okresem przejściowym.

## 9. Zmiany względem obecnego firmware'u (#75, fw 1.0.0-dev.9)

| Obecnie | Protokół v1 |
|---|---|
| `obiekty/<obiekt>/<urządzenie>/…` | `e-print/<hw_id>/v1/…` |
| `boot` – licznik, `sn` w każdej ramce | `boot` – losowy, `hw_id` w temacie |
| `rs485/rx`, `ssp/zdarzenie` | `evt/raw`, `evt/ssp` |
| `rs485/send` | `cmd/send` + `res` |
| `stats` | `tele/sys` |
| `status`: `online` jako tekst | JSON `{"st":"online"}` |
| brak aplikacyjnego `ack`, bufor w RAM | `ack` po zapisie; bufor do potwierdzenia, docelowo trwały (flash) |
| MQTT bez TLS (test) | TLS z własnym CA i indywidualnym hasłem |
| maks. rozmiar zdarzenia 528 B | mieści się w limicie 1024 B |

## 10. Kody i wersjonowanie

Kody błędów w `res.code` i błędy walidacji po stronie mostu są rejestrowane w `technical_events`. Wiadomość niepoprawna trafia do kwarantanny (nie jest gubiona) i nie dostaje `ack`.
Przejście na `v2`: most obsługuje jednocześnie `v1` i `v2` do czasu aktualizacji urządzeń.

## 11. Kontrakt most ↔ baza

Most woła wyłącznie te funkcje (rola `iot_bridge`). Migracje i kod mostu MUSZĄ trzymać się tych sygnatur.

| Funkcja | Wynik | Znaczenie |
|---|---|---|
| `iot.ingest_event(p_type text, p_hw_id text, p_boot text, p_seq bigint, p_name text, p_ts timestamptz, p_payload jsonb)` | `text`: `stored`, `duplicate`, `conflict`, `quarantined` | zapis zdarzenia w transakcji; `ack` tylko po `stored` lub `duplicate` |
| `iot.ingest_state(p_type text, p_hw_id text, p_kind text, p_payload jsonb)` | `void` | `status`, `info`, `tele/sys`; idempotentne |
| `iot.claim_commands(p_types text[], p_limit int)` | wiersze `device_commands` | pobranie poleceń przez `FOR UPDATE SKIP LOCKED` |
| `iot.finish_command(p_cid text, p_status text, p_result jsonb)` | `void` | wynik: `done`, `failed`, `expired`, `timeout` |
| `iot.replace_device(p_point_id uuid, p_new_hw_id text)` | `void` | wymiana egzemplarza z rozdziału 2, wywoływana przez aplikację |

