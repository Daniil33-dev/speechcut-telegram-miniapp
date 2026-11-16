# Эксплуатация VPS

Первичная установка: [docs/INSTALL.md](../docs/INSTALL.md). Используются свои домен, бот, env и данные.

- Код: `/opt/speechcut/releases/<release>`, symlink `/opt/speechcut/current`.
- Данные: `/var/lib/speechcut/data/editor.sqlite`, source/output/uploads/work.
- Модель: `/var/lib/speechcut/models/`; секреты `/etc/speechcut.env`, root 0600.
- Web: localhost:3048; systemd `speechcut-web`, `speechcut-worker`.
- Один worker: 2 CPU / 2 ГиБ, web 768 МиБ. При смене порта синхронно правьте units, Caddy и APP_URL.

## Обновление и откат

1. Дождитесь окончания активных операций. Создайте согласованную backup БД командой `/usr/local/sbin/speechcut-backup`.
2. Клонируйте новый commit в новый release directory. Не пересобирайте обслуживающий релиз.
3. `pnpm install --frozen-lockfile`, check, test, test:media, полный doctor, build. Для env используйте `node --env-file=/etc/speechcut.env --import tsx scripts/doctor.ts` и аналогичные команды либо закрытую временную `.env.local` (0600), удалив её после проверки. Не выводите env.
4. Примените миграции с production env после backup, проверив совместимость отката. Миграции этой версии добавляющие; будущие изменения требуют анализа.
5. `bash deploy/switch-release.sh /opt/speechcut/releases/NEW_RELEASE` переключает только свои web/worker. Проверьте HTTPS health и сохранение прежнего результата.

Откат кода: тот же switch-release.sh с известным рабочим релизом. Данные остаются вне релиза; откат symlink не откатывает SQL. Не восстанавливайте БД ради обычного retry.

## Backup / restore

Timer ежедневно в 03:20 UTC запускает sqlite3 `.backup`, integrity_check и хранит копии 7 суток в `/var/backups/speechcut`. Видео не включены. Копия на том же VPS не защищает от потери диска; оффсайт настраивается отдельно.

Restore заменяет текущие задания и версии, выполняется только по явному решению владельца. Сначала выберите backup, проверьте integrity; затем остановите свои службы и сделайте страховочную копию текущей БД. Замените CHOSEN на выбранный файл:

```sh
sqlite3 /var/backups/speechcut/CHOSEN.sqlite 'PRAGMA integrity_check'
systemctl stop speechcut-web speechcut-worker
/usr/local/sbin/speechcut-backup
sqlite3 /var/lib/speechcut/data/editor.sqlite ".restore '/var/backups/speechcut/CHOSEN.sqlite'"
chown speechcut:speechcut /var/lib/speechcut/data/editor.sqlite
systemctl start speechcut-web speechcut-worker
```

Версия схемы и файлы должны соответствовать восстановленной БД. Утраченные видео backup БД не вернёт.

## Наблюдение

```sh
systemctl status speechcut-web speechcut-worker caddy
systemctl list-timers speechcut-backup.timer speechcut-cleanup.timer
journalctl -u speechcut-worker -n 50 --no-pager
curl --fail https://editor.example.com/api/health
df -h /
```

Перед передачей журналов удалите ключи, initData, подписанные URL и личные тексты. `setup_required` — незавершённая настройка, а не успешная приёмка.

Cleanup ежечасно удаляет просроченные временные загрузки, отменённые части и неактивные orphan outputs. Зарегистрированные source/output и диагностические карты сохраняются; оригиналы автоматически не удаляются. Не очищайте data через rm -rf.
