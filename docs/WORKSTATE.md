# Текущее состояние работы

Порядок продолжения — [README 19.9](../README.md#checkpoint-workflow). Доставку проверять по GitHub.

| Поле | Значение |
| --- | --- |
| Пункт | P19: защищённая загрузка изображения в PostgreSQL |
| Статус | P19 завершена; полная приёмка пройдена. Доставку сверять по PR/main |
| Контрольная точка | `P19-C04`, итоговая приёмка |
| Ветка | `iteration-032-p19-image-upload` |
| База и подтверждённый main | `2070644f1922f57efdc13c0dec1993d7036a897a`, принятое P18 |
| Версия | 32; тег iteration-032 только локальный после C04 |
| PR P19 | [#20](https://github.com/Matthew-for-diploma-project/-Architect-s-Map/pull/20) |

## Границы и решения

- Пользователь поручил P19 с промежуточными коммитами; продолжается прежнее поручение слияния принятых завершённых веток. P20–P32 не начинать.
- image-upload.mjs подключён в tools/serve.mjs как images.create. P18 и method/Origin/session guard работают до handler/получения write client. Владелец только из trusted auth, requireImageOwner повторно проверяет identity до connect, не подменяет проверку cookie. Декодирование не держит транзакцию.
- Один client/BEGIN/INSERT images (bytea+metadata одной строкой), safe JSON {image} до COMMIT, 201 только после подтверждения COMMIT. Сохраняются исходные байты/параметры, server ID/defaults/ревизия/даты; ответ без owner/байтов/секретов/cookie. P17-query behavior сохранён, экспортирован общий identity helper; миграции/зависимости/клиент/Worker не менялись.
- Отдельные запросы независимы, одинаковые имена создают разные ID, layer_settings не меняется. Ошибка INSERT/построения ответа откатывает только текущий запрос. Потеря подтверждения уже выполненного COMMIT может оставить сохранённую строку при 503; сервер не обещает успех и не делает retry, client уничтожается. Не повторять POST вслепую; список — P20.
- GET/list/file, PATCH/DELETE и настройки пока 501 после guards. Клиентская отправка — P24, текущие рисунки по-прежнему локальны.

## Полная приёмка

Результаты на C03 `f6dbae2`; C04 меняет только документацию.

- Чистый npm ci, npm run build, npm test — 148/148; полный npm run test:db — 92/92. Ошибок/отмен/пропусков нет. Новые 6 unit и 9 HTTP/PG/process P19: 8 изолированных p19_test_<uuid> и 1 настоящий tools/serve.mjs.
- Точные PNG/JPEG/WebP байты/metadata/defaults, A/B и server IDs, safe 201 после COMMIT, ранние guest/revoked/expired/Origin/413, неверные файлы/подмена/дубликаты без write transaction подтверждены.
- Настоящее AFTER INSERT исключение и ошибка JSON после реального INSERT откатывают строку; неуспешный файл не отменяет прежние/чужие, настройки слоя сохранены. Два INSERT удерживаются до COMMIT: отдельная connection видит 0 строк и ответы ещё не получены, затем два 201 с верными owner/байтами и разными ID. Lost-COMMIT-reply: 503, одна сохранённая строка, один INSERT, retry нет, client уничтожен.
- Production Node с действующей cookie/Origin сохраняет файл и safe metadata, fileUrl пока 501; stdout не содержит токен/пароль. Собственные UUID-данные и изолированные схемы очищаются.
- account — 7/7 (шесть размеров до 320×240), account-api — 10/10 (настоящие сессии/Origin/отказы), drawings — 3/3 (P16 широкий/мобильный). Это регрессия; UI-отправка в API не добавлялась.
- PostgreSQL 17.11, отдельные обычные роли/БД, SCRAM/28P01 и отсутствие SUPERUSER/CREATEDB/CREATEROLE, обе миграции подтверждены. Node 24.22.1 / npm 11.9.0 / Playwright 1.62.1 / Chromium 153.0.8010.0.
- Worker побайтово прежний: 7671f8cde768dee738b690100776713e57c9c712de4cad9a9d99d09e5870fb48. Синтаксис, git diff --check, Markdown/локальные ссылки, VERSION/current_application, P20–P32 и исторические метаданные/материалы проверены.

## Доставка и следующий шаг

- C01–C03 сохранены и сверены по SHA/дереву. Сохранить/сверить C04, создать локальный тег, перевести PR #20 в ready, проверить head/reviews/checks/mergeable, слить обычным merge с ожидаемым head и подтвердить удалённый main/дерево. Не нужен дополнительный коммит ради собственного merge SHA.
- При восстановлении сначала проверить PR #20 и main: если merged и принятое дерево соответствует итоговой точке, доставка закончена. P20 — следующая самостоятельная задача; без поручения не начинается.
- Теги не публикуются доступным плагином, git push не авторизован; коммиты/merge доступны через API. Sites не публиковался; живые картографические источники, физический телефон и HTTPS proxy отдельно не проверялись.

## Воспроизводимое окружение и доставка

Зависимости приложения — `npm ci`. QA-пакеты вне Git: `@sparticuz/chromium@153.0.0`, `@embedded-postgres/linux-x64@17.11.0-beta.19`; выполнить `node <qa>/node_modules/@embedded-postgres/linux-x64/scripts/hydrate-symlinks.js`. До импорта Chromium задать TMPDIR в доступный каталог; `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = await chromium.executablePath()`. Полный Chromium ранее не создавал Unix-сокет; Headless Shell подтверждён заново.

PostgreSQL: `initdb -D <qa>/db -U <admin> --encoding=UTF8 --locale=C`, запуск `postgres -D <qa>/db -h 127.0.0.1 -p <pg-port> -k '' -c dynamic_shared_memory_type=mmap`. Создать две отдельные БД с суффиксом `_test` и разные обычные роли для browser/integration. TCP обычных ролей требует SCRAM; неверный пароль подтверждён кодом 28P01. Пароли генерировать локально, не сохранять в Git.

Для browser БД: DATABASE_URL, DATABASE_SSL=disable, PUBLIC_ORIGIN=http://127.0.0.1:3019; выполнить `node tools/migrate.mjs`, затем `node tools/serve.mjs` с HOST=127.0.0.1/PORT=3019. Для integration: NODE_ENV=test и TEST_DATABASE_URL другой БД/роли, обе миграции (`node tools/migrate.mjs --test`); создать локальный `.env.test` для `npm run test:db`. P13_BASE_URL/P14_BASE_URL/P16_BASE_URL равны PUBLIC_ORIGIN; P14_TEST_DATABASE_URL — БД браузерного Node. QA AUTH_REGISTER_MAX_ATTEMPTS/AUTH_LOGIN_MAX_ATTEMPTS=1000. Запускать процессы и тесты в одной команде из-за изоляции loopback; завершать процессы после проверки. PNG/диагностика — P13_ARTIFACT_DIR/P14_ARTIFACT_DIR/P16_ARTIFACT_DIR вне Git.

Доставка — GitHub Git API, обычные последовательные коммиты с подтверждением SHA/дерева. Теги плагин не публикует; git push раньше не был авторизован. Sites не поручен. Живые картографические источники, физический телефон и HTTPS proxy отдельно не проверяются; прежняя проблема свёрнутых панелей остаётся P31.

Целевой P19-прогон: `node --env-file=.env.test --test tests/integration/image-upload.test.mjs`. В текущем QA используются p19_browser_test/p19_regression_test с разными обычными ролями и PostgreSQL на 127.0.0.1:55619; browser Origin — http://127.0.0.1:3019. Логи/PNG вне Git. После приёмки процессы остановлены.

Целевые команды P19: node --test tests/image-upload.test.mjs; node --env-file=.env.test --test tests/integration/image-upload.test.mjs tests/integration/database.test.mjs. QA p19_browser_test/p19_regression_test на 127.0.0.1:55619, browser Origin http://127.0.0.1:3019. Полные условия — журнал README P19. Процессы после приёмки остановлены, логи/PNG вне Git.

## История

- `P19-C01` (`d245987`) — база, границы и план.
- `P19-C02` (`62a7841`) — handler/production POST, общий auth helper, версия 32; 148 обычных и 3 целевых HTTP/PG.
- `P19-C03` (`f6dbae2`) — rollback/независимость/конкуренция/неопределённый COMMIT и production upload; 148 обычных и 23 целевых PostgreSQL.
- `P19-C04` — полная приёмка 148/92/7/10/3, README/метаданные/остаток плана, тег/PR #20 и доставка.
