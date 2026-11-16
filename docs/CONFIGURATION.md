# Конфигурация

`.env.example` содержит только пустые ключи и общие значения. `setup:env` создаёт приватный файл, production переносит его в `/etc/speechcut.env` (0600). Никогда не коммитьте заполненный env.

| Переменная | Назначение |
| --- | --- |
| `APP_URL` | Публичный HTTPS адрес без завершающего слеша; localhost только для разработки. |
| `APP_RUNTIME` | Метка vps. Не переключает хранилище на другую инфраструктуру. |
| `PORT` | Справочное значение 3048. Команды Next.js и units задают порт явно; менять согласованно. |
| `DEV_AUTH_ENABLED` | false по умолчанию; true только локально вне production. Production запрещает true. |
| `DEV_USER_ID` | Синтетический ID только для явно включённой локальной разработки. |
| `BOT_TOKEN` | Токен вашего нового бота; сохраняется локальной формой. Секрет. |
| `ALLOWED_TELEGRAM_USER_IDS` | Разрешённые Telegram ID через запятую, без пробелов; форма определяет владельца. |
| `TELEGRAM_WEBHOOK_SECRET` | Уникальный случайный secret webhook, генерируется setup:env. Секрет. |
| `MEDIA_SIGNING_SECRET` | Уникальный случайный ключ подписи медиа, генерируется setup:env. Секрет. |
| `ASSEMBLYAI_API_KEY` | Собственный ключ AssemblyAI. Секрет. |
| `ASSEMBLYAI_MODEL` | Русская модель с word timestamps; preview может менять доступность/условия. |
| `ASSEMBLYAI_USD_PER_HOUR` | Подтверждённый тариф выбранной модели за час USD; пусто = неизвестный. |
| `ASSEMBLYAI_PRICING_DATE` | Дата проверенного тарифа ASR, например YYYY-MM-DD. |
| `LLM_PROVIDER` | Метка openai. Адаптер OpenRouter не реализован, менять флаг недостаточно. |
| `LLM_MODEL` | Доступная вашему API-проекту модель Responses + strict JSON Schema + reasoning low. |
| `OPENAI_API_KEY` | Ключ собственного OpenAI проекта. Секрет; следите за сроком и лимитами. |
| `OPENAI_INPUT_USD_PER_MILLION` | USD за 1 млн обычных входных токенов выбранной модели. |
| `OPENAI_CACHED_USD_PER_MILLION` | USD за 1 млн чтений кэшированных входных токенов. |
| `OPENAI_OUTPUT_USD_PER_MILLION` | USD за 1 млн выходных токенов. |
| `OPENAI_CACHE_WRITE_USD_PER_MILLION` | Необязательная отдельная ставка записи в кэш на 30 минут, если применима. |
| `OPENAI_CACHE_WRITE_12H_USD_PER_MILLION` | Необязательная ставка записи в кэш на 12 часов, если применима. |
| `OPENAI_PRICING_DATE` | Дата проверенного тарифа OpenAI. Без обязательных ставок и даты стоимость неизвестна. |
| `DATA_DIR` | Приватный каталог данных; production /var/lib/speechcut/data. |
| `SQLITE_PATH` | Путь SQLite вне релиза; production /var/lib/speechcut/data/editor.sqlite. |
| `FFMPEG_PATH` | Исполняемый FFmpeg; по умолчанию ffmpeg из PATH. |
| `FFPROBE_PATH` | Исполняемый FFprobe; по умолчанию ffprobe из PATH. |
| `FONT_PATH` | Абсолютный путь к DejaVuSans-Bold.ttf с кириллицей. |
| `VAD_MODEL_PATH` | Абсолютный путь проверенной silero-v5.1.2.onnx. |
| `MAX_UPLOAD_BYTES` | 524288000 = 500 МиБ. Клиентский предел тоже проверяется в UI; менять согласованно. |
| `MAX_DURATION_SECONDS` | 900 = 15 минут. Проверяется сервером через FFprobe. |
| `MAX_OWNER_STORAGE_BYTES` | 10737418240 = 10 ГиБ исходников/результатов на владельца. |
| `FILE_RETENTION_DAYS` | Оставить 0. Автоматический TTL пользовательских файлов не реализован; ненулевое значение не включает его. |

Дополнительно `NODE_ENV=production` обязателен на сервере. `MEDIA_TOOLS_DIR` — только каталог загрузки VAD в prepare-media.ts, не путь runtime модели. После смены env перезапускаются свои web/worker. Ключи не передаются в NEXT_PUBLIC_*.

Тарифы не подставляются автоматически. Для исходной модели код учитывает её особый длинный контекст; при смене модели проверьте формулу в providers/llm.ts. Ставки записи кэша заменяют соответствующие обычные входные токены, не прибавляются к ним дважды. Неизвестные ставки сохраняют стоимость null.
