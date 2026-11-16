# Установка на свой VPS

Проверенная ветка: Ubuntu 24.04, Node.js 24, pnpm 11.25.0, FFmpeg, SQLite, Caddy, OpenAI, AssemblyAI. Создайте свои аккаунты и новый бот. Доступ к приложению ограничивается allowlist; другие приложения на сервере не удаляются.

## 1. Сервер и доступ

Нужны VPS (ориентир 4 vCPU / 8 ГБ RAM и диск с запасом под исходники/рендер), SSH-ключ и домен. A-запись направьте на VPS; AAAA — только при рабочем IPv6. В панели/файрволе откройте TCP 80/443 и свой SSH-порт, сохранив SSH-доступ. Порт 3048 наружу не открывается.

`editor.example.com`, `YOUR_SERVER` и путь к ключу — заполнители. Заменяйте их своими значениями. При первом подключении сверяйте host fingerprint с панелью провайдера. Не отключайте StrictHostKeyChecking и не отправляйте пароль или содержимое ключа в чат.

На VPS от root:

```sh
apt-get update
apt-get install -y git
git clone https://github.com/Daniil33-dev/speechcut-telegram-miniapp.git /opt/speechcut-setup
cd /opt/speechcut-setup
```

Прочитайте `deploy/bootstrap-ubuntu.sh`, затем на новом Ubuntu VPS выполните:

```sh
bash deploy/bootstrap-ubuntu.sh
```

Скрипт ставит системные пакеты, официальный Node 24.22.3 с проверкой SHA-256 архива, pnpm и при отсутствии Caddy — официальный пакет Caddy, создаёт пользователя и каталоги. Он не создаёт ключи, не меняет сайты Caddy и не запускает приложение. Для существующего Speechcut используйте [обновление](../deploy/VPS.md). Если сервер занят другими приложениями, сначала оцените совместимость Node/Caddy и ресурсы.

Источники: [Node.js](https://nodejs.org/en/download), [pnpm](https://pnpm.io/installation), [официальный Caddy](https://caddyserver.com/docs/install#debian-ubuntu-raspbian).

## 2. Отдельный релиз

Команды далее выполняются на VPS от root. Имя релиза должно быть новым:

```sh
release_dir="/opt/speechcut/releases/$(date -u +%Y%m%dT%H%M%SZ)"
git clone https://github.com/Daniil33-dev/speechcut-telegram-miniapp.git "$release_dir"
cd "$release_dir"
pnpm install --frozen-lockfile
pnpm run setup:env --vps
chmod 600 .env.local
```

`setup:env` не перезаписывает существующий файл и генерирует уникальные MEDIA_SIGNING_SECRET и TELEGRAM_WEBHOOK_SECRET. Не копируйте секреты другой установки.

## 3. Свои бот и API

Создайте нового бота в [BotFather](https://t.me/BotFather) через `/newbot`. В каталоге релиза запустите:

```sh
node --import tsx scripts/setup-telegram.ts
```

Оставьте этот терминал открытым. На своём компьютере во втором терминале:

```sh
ssh -i /path/to/your_ssh_key -N -L 3079:127.0.0.1:3079 root@YOUR_SERVER
```

Откройте `http://127.0.0.1:3079` на компьютере. Вставьте токен в локальную форму, откройте её ссылку на бота, нажмите «Запустить», затем определите владельца кнопкой формы. Токен и allowlist сохранятся в `.env.local` на VPS. После успеха остановите форму и туннель Ctrl+C. При перезапуске заново откройте главную страницу формы. Порт 3079 наружу не открывайте.

В [AssemblyAI](https://www.assemblyai.com/) создайте свой API-ключ. В комплекте используется `universal-3-6-pro-preview` с русским языком и таймкодами слов; проверьте доступность и тариф.

В [OpenAI Platform](https://platform.openai.com/) выберите организацию/проект, создайте свой ключ, проверьте API-баланс и срок ключа. Подписка ChatGPT не доказывает наличие API-кредитов. Нужна модель с Responses, JSON Schema Structured Outputs и `reasoning.effort=low`. На исходной установке проверялась `gpt-6-luna`; доступность в вашем проекте не гарантируется. Если другая модель не принимает параметры, агент проверяет официальный API и адаптирует запрос, а не меняет только baseURL.

Откройте `.env.local` в редакторе:

```sh
nano .env.local
```

Заполните своими значениями, без пробелов вокруг `=`:

```dotenv
APP_URL=https://editor.example.com
NODE_ENV=production
DEV_AUTH_ENABLED=false
OPENAI_API_KEY=
LLM_MODEL=
ASSEMBLYAI_API_KEY=
```

Пустые значения заменяются вашими. Остальные сгенерированные настройки сохраняются. Не печатайте env в чат. Тарифы и дату заполняйте только после проверки; без них стоимость остаётся неизвестной. Все переменные: [CONFIGURATION.md](CONFIGURATION.md).

## 4. Модель и проверки

```sh
runuser -u speechcut -- env MEDIA_TOOLS_DIR=/var/lib/speechcut/models /usr/local/bin/node --import tsx scripts/prepare-media.ts
pnpm run check
pnpm test
pnpm run test:media
pnpm run db:migrate
pnpm run doctor
pnpm run build
pnpm run audit:public
```

Не продолжайте при ошибках. Doctor проверяет настройки, исходящий HTTPS, FFmpeg с фильтрами, шрифт и настоящий VAD inference. Он не проверяет баланс и качество конкретной модели. `doctor --offline` годится для подготовки без аккаунтов, но не доказывает полную готовность.

Обычные тесты и test:media не вызывают платные API. Настоящую запись проверяйте после подключения отдельно. На 4K/HDR нужны ресурсы CPU/RAM; при OOM сначала изучите журнал и лимиты, не отключайте QA.

## 5. Службы

```sh
install -m 600 -o root -g root .env.local /etc/speechcut.env
rm .env.local
chown -R speechcut:speechcut /var/lib/speechcut
install -m 644 deploy/speechcut-*.service deploy/speechcut-*.timer /etc/systemd/system/
install -m 755 deploy/backup.sh /usr/local/sbin/speechcut-backup
systemctl daemon-reload
bash deploy/switch-release.sh "$release_dir"
systemctl enable speechcut-web speechcut-worker
systemctl enable --now speechcut-backup.timer speechcut-cleanup.timer
systemctl is-active speechcut-web speechcut-worker
curl --fail http://127.0.0.1:3048/api/health
```

Worker ограничен двумя CPU и 2 ГиБ RAM, web — 768 МиБ. После измерения можно настроить пределы, оставив ресурсы ОС и другим приложениям. Релиз доступен speechcut на чтение, а секреты передаёт systemd. Данные находятся вне релиза.

## 6. HTTPS

Замените домен в шаблоне Caddy, например:

```sh
APP_DOMAIN=editor.example.com
sed "s/editor.example.com/${APP_DOMAIN}/g" deploy/Caddyfile.site > /etc/caddy/speechcut.caddy
```

Сделайте копию `/etc/caddy/Caddyfile`. Добавьте туда отдельную строку `import /etc/caddy/speechcut.caddy`, сохранив прежние сайты. DNS и порты 80/443 должны работать.

```sh
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
curl --fail https://editor.example.com/api/health
```

Лимит Caddy 9MB относится к одной части 8 МиБ, а не всему исходнику. Не используйте внешний proxy, мешающий такой загрузке.

## 7. Webhook и Mini App

В каталоге релиза на VPS:

```sh
node --env-file=/etc/speechcut.env --import tsx scripts/connect-telegram.ts
```

Настраиваются webhook с secret, `/start` и меню собственного бота. При необходимости задайте Main Mini App в BotFather с тем же HTTPS URL. Не запускайте polling одновременно с webhook. Готовые видео в чат не отправляются.

Откройте бота аккаунтом из allowlist. Постороннему доступ должен быть закрыт. Health должен подтверждать настройки и свежий heartbeat worker.

## 8. Приёмка

Загрузите свою короткую запись, затем отдельно большой MOV/MP4. Проверьте текст, удаление фразы со звуком, ИИ-правку, версии, одобрение, субтитры, паузы и MP4. Проверьте сохранение на телефоне и компьютере: найдите файл и откройте его, одного callback загрузчика недостаточно.

Закройте Mini App после полной загрузки: сервер должен закончить обработку. Отмену и restart worker проверяйте на отдельной разрешённой тестовой операции. Прослушайте склейки и весь результат; автоматические метрики не заменяют прослушивание.

Заполните собственную приёмку по [ACCEPTANCE.md](../ACCEPTANCE.md). Отчёт автора не доказывает готовность вашей установки. Реальные API-запросы расходуют ваши кредиты; сначала диагностируйте ошибку, затем повторяйте нужный этап.

Обслуживание: [deploy/VPS.md](../deploy/VPS.md). Ошибки: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
