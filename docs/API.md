# API, данные и операции

Все приватные запросы требуют `x-telegram-init-data`. Проверяются HMAC, срок 1 час, отсутствие повторных параметров, allowlist и принадлежность каждой сущности владельцу. Режим разработки работает только при явном флаге, вне production и на localhost. CORS с чужими origin не разрешён.

| Метод и маршрут | Назначение |
| --- | --- |
| GET /api/health | Минимальный статус: настройки и свежий heartbeat worker |
| POST /api/telegram | Secret header, дедупликация update_id, долговечные ответы /start |
| GET/POST /api/jobs | Список текущего владельца / создание |
| GET/DELETE /api/jobs/:id | Состояние / подтверждённое удаление с revision |
| POST /api/jobs/:id/uploads | Сессия, lease, размер, revision |
| PUT /api/uploads/:id/parts/:n | Часть 8 МиБ, SHA-256, защита повтора |
| POST /api/uploads/:id/complete | Проверка частей/контейнера, атомарная привязка и очередь |
| DELETE /api/uploads/:id | Инвалидация lease |
| PATCH /api/jobs/:id/draft | Черновик units/text/request с revision и baseVersionId |
| POST /api/jobs/:id/script/manual | Новая версия из известных узлов |
| POST /api/jobs/:id/script/edit | Запрос ИИ, idempotencyKey, 202 operationId |
| POST /api/jobs/:id/script/select | Выбор прежней версии |
| POST /api/jobs/:id/approve | versionId + hash + revision |
| PATCH /api/jobs/:id/settings | Снимок настроек |
| POST /api/jobs/:id/render | Точная approved version, settings, idempotencyKey |
| GET /api/operations/:id | Состояние и этап без provider checkpoints/секретов |
| POST /api/operations/:id/cancel | Терминальная отмена и запрет позднего результата |
| POST /api/operations/:id/retry | Новая ограниченная операция с сохранёнными checkpoint |
| POST /api/jobs/:id/source-link | Signed source preview |
| POST /api/jobs/:id/media-link | Новые media/save ссылки выбранного результата |
| GET/HEAD /media/:id | Подпись, срок, streaming, Range 206/416 |
| GET/HEAD /media/:id?download=1 | Отдельная подпись download, attachment MP4, CORS только для web.telegram.org |
| GET /save/:id | Signed страница результата; не запускает рендер |

Часть загрузки передаётся с `x-upload-lease`. Остальные команды используют JSON. Ошибка: `{error:{code,message,retryable}}`. Конфликты revision и idempotency — 409. Размер — 413; невалидные данные — 422; авторизация — 401/403. Неподключённый сервис не возвращает фиктивный успех.

media-link возвращает отдельные mediaUrl для встроенного видео и downloadUrl для Telegram.WebApp.downloadFile. Навигационный запрос Sec-Fetch-Dest: document к обычному mediaUrl возвращается в Mini App с кодом 303; fetch и video получают поток. В интерфейсе нет навигационной ссылки на MP4. downloadUrl использует другую подпись и заголовки attachment/CORS, рекомендованные [Telegram](https://core.telegram.org/bots/webapps#downloadfileparams). На телефоне кнопка сначала подготавливает File, затем новый жест открывает Web Share. На компьютере «Скачать видео» сразу использует Telegram.downloadFile, даже если macOS предлагает Web Share.

## Схема

Миграции 001–002 создают jobs, transcripts, versions, assets, uploads/upload_parts, operations, artifacts, usage_events, outbox, telegram_updates/telegram_replies, rate_limits и heartbeat. Связи, уникальные ключи и индексы находятся в SQL. Видео хранится в приватных файлах, а не в SQLite.

Job содержит выбранную и одобренную версии раздельно. У версий есть parent и hash, у artifacts — неизменные version/settings/rendererRevision. Ручная правка проверяет ID, группы исходных слов и порядок; одинаковые слова различаются идентичностями. Исправления названий могут объединять исходные ID без потери их звука. План ИИ не может вернуть удалённое/чужое слово или повторить хук.

## Очередь и отмена

SQLite `BEGIN IMMEDIATE` захватывает queued/stale операцию. Lease 45 секунд обновляется каждые 3 секунды. systemd/flock запрещает второй экземпляр worker. На этом VPS один worker выполняет одну операцию за раз. После трёх прерываний требуется явный ручной повтор.

ASR ticket сохраняется до polling; готовый transcript и проверенные чанки текста переиспользуются. Render checkpoint содержит revision и hash входов; публикация восстанавливает перемещение готового файла. Неоднозначный сетевой сбой до получения provider request ID может потребовать новый оплачиваемый запрос — exactly-once внешнего API не обещается.

Отмена немедленно делает результат недействительным; работающий процесс получает AbortSignal через heartbeat. Завершение транзакционно проверяет активную операцию. Возврат к списку не является отменой. Готовые прошлые artifacts переживают ошибку новой операции.

Успешные уведомления идут через outbox после commit. Telegram-ответы имеют отдельную долговечную очередь. Сбой доставки не повторяет платный монтаж; неоднозначный сетевой сбой самой доставки может дать повтор сообщения.

## Медиа

Единый edit-map содержит source checksum, версию, settings hash, акустические и исходные границы, ranges, output offsets, подписи, padding и pause audit. ASR timings не переписываются. Только энергетически/VAD-подтверждённые интервалы >300 мс вырезаются, по 100 мс защищают применимые речевые границы. Числа FFmpeg передаются в десятичном формате, без scientific notation.

Тихая речь дополнительно проверяется по энергии 10-мс окон относительно измеренного шумового фона. Для этого нужна поддержка VAD или исходных ASR-подсказок: один растянутый таймкод не защищает пустую тишину. Перед классификацией паузы из кандидата вычитаются поддержанные речевые участки; строгое >300 мс применяется уже к оставшемуся непрерывному интервалу.

Готовый MP4 декодируется повторно; невалидные параметры, потерянные ID, выход субтитров за пределы и оставшиеся подтверждённые паузы блокируют публикацию. Кроме ID, проверяются сохранность измеренной речевой энергии в edit-map и совпадение звуковых фрагментов каждого выбранного слова с источником, с допуском на кодек/ресемплирование. Диагностика сохраняется в source-analysis.json, output-audit.json и word-audit.json. qaSummary.wordSignalCheck содержит число проверенных слов, минимальную корреляцию, максимальное изменение уровня и смещение.

Результат со сбоем word/pause QA не публикуется. Автоматическое сравнение звука не заменяет прослушивание эмоциональной подачи и всех склеек человеком.
