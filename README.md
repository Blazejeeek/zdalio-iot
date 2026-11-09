# zdalio-iot – most MQTT ↔ Supabase

Serwer pośredniczący między urządzeniami IoT a bazą. Kontrakt: [docs/PROTOKOL.md](docs/PROTOKOL.md).

Instancja obsługuje typy z `MODULES`, a kolejne instancje dzielą ruch przez `$share/<typ>/<typ>/+/v1/#`. Potwierdzenie `ack` idzie dopiero po zapisie w bazie. Wiadomości niepoprawne trafiają do kwarantanny; `ack` dostają tylko zdarzenia z poprawną kopertą, po zapisie w kwarantannie. Polecenia są wysyłane raz, z `exp`; brak wyniku kończy się statusem `timeout`, bez ponawiania.

## Uruchomienie

```
npm ci
npm test
npm run build
MQTT_URL=mqtts://host:port MODULES=e-print DATABASE_URL=postgres://... npm start
```

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `MQTT_URL` | wymagana | adres brokera |
| `MQTT_USERNAME`, `MQTT_PASSWORD` | brak | konto mostu |
| `MQTT_CA_FILE` | brak | plik własnego CA (przy `mqtts://`) |
| `DATABASE_URL` | wymagana | Postgres, rola `iot_bridge` |
| `MODULES` | wymagana | np. `e-print,e-gate`; nieznany typ zatrzymuje start |
| `HTTP_PORT` | 8080 | `/health` (200 albo 503), `/metrics` (format Prometheus) |
| `INSTANCE_ID` | nazwa hosta | część identyfikatora klienta MQTT |
| `COMMAND_POLL_MS`, `COMMAND_BATCH` | 1000, 20 | pobieranie poleceń |
| `RETAINED_WINDOW_MS` | 3000 | jak długo trwa odczyt retained po połączeniu |
| `MAX_INFLIGHT`, `MAX_QUEUE` | 32, 2000 | równoległość i kolejka; nadmiar jest odrzucany bez `ack` |
| `SHUTDOWN_GRACE_MS` | 10000 | czas na dokończenie zapisów po SIGTERM |
| `FINISH_RETRY_MS` | 1000 | przerwa między próbami zapisu wyniku polecenia |

## Skalowanie na Coolify

Coolify nadaje kontenerom stałą nazwę (`container_name`), więc `scale` i `deploy.replicas` w compose kończą się błędem wdrożenia. Kolejna kopia to osobna usługa w `docker-compose.yml` (np. `bridge-2`, z tymi samymi zmiennymi) albo osobna aplikacja Coolify. Podział ruchu daje `$share`, identyfikator klienta bierze się z nazwy hosta.

## Zależności od bazy (migracja `20261108000019_iot.sql` w fireprint)

1. Rozdział 11 nie ma funkcji kwarantanny, więc wiadomość odrzuconą przez most (np. bez `boot` lub `seq`) przekazuje `iot.ingest_state(..., 'quarantine', payload)`. Baza zapisuje ją w `iot.quarantine` z powodem `bad_kind` (lub `unknown_device`), a właściwy powód jest w `payload.reason`.
2. `iot.claim_commands` zwraca wiersze `iot.device_commands` (`cid`, `type`, `hw_id`, `name`, `payload`, `expires_at`). Polecenie bez `expires_at` nie jest wysyłane.
3. `iot.finish_command`: pierwszy wynik wygrywa, bo wynik może przyjść do innej instancji niż ta, która wysłała polecenie. Nieznany `cid` (PT404) trafia do kwarantanny.
4. Do uzupełnienia: polecenia w stanie `sent` po awarii instancji nie mają dziś właściciela timera i nic ich nie kończy.

## Ograniczenia v1

- `tele/<nazwa>` inne niż `tele/sys` są liczone w metrykach, ale niezapisywane: kontrakt bazy ich nie obejmuje.
- Części dużych wiadomości (rozdział 5.3) są zapisywane jako osobne zdarzenia; składanie po `msg` jeszcze nie istnieje.
- Znak kontrolny `hw_id` nie jest sprawdzany, tylko format.
- Niedostępność po 120 s ciszy (rozdział 5.1) wymaga stanu wspólnego dla instancji, więc należy do bazy.
- Moduł `e-gate` nie ma jeszcze adaptera Shelly.
