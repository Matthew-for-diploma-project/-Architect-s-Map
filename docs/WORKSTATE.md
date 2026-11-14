# Текущее состояние работы

Порядок продолжения — [README 19.9](../README.md#checkpoint-workflow). Доставку проверять по GitHub.

| Поле | Значение |
| --- | --- |
| Пункт | P18: серверная проверка файлов и геопривязки |
| Статус | P18 завершена; полная приёмка пройдена. Доставку сверять по PR/main |
| Контрольная точка | `P18-C04`, итоговая приёмка |
| Ветка | `iteration-031-p18-image-validation` |
| База и подтверждённый main | `cbb11b1a75a692e289577e69b342da8e58453bbd`, принятое P17 |
| Версия | 31; тег iteration-031 только локальный после C04 |
| PR P18 | [#19](https://github.com/Matthew-for-diploma-project/-Architect-s-Map/pull/19) |

## Границы и решения

- Пользователь поручил P18 с промежуточными коммитами; продолжается прежнее поручение слияния принятых веток. P19–P32 не начинать.
- image-metadata.mjs проверяет WGS84 bounds, угол/прозрачность/boolean фиксацию, defaults/patch/revision и базовое Unicode-имя. Owner/ID/серверные размеры не принимаются. image-multipart.mjs с busboy 1.6.0 читает ровно file+metadata, считает реальные file/field/body байты и не собирает полное multipart-тело. Лимиты 20 МиБ/8 КиБ/21 МиБ включены; parser-limit+1 сохраняет точную верхнюю границу, превышение останавливает чтение.
- image-validation.mjs проверяет сигнатуру/MIME и контейнер: PNG чанки/CRC/IEND, JPEG сегменты/сканы/EOI, WebP RIFF/чанки/паддинг; лишние хвосты и APNG/animated WebP не допускаются. До декодирования оси до 16384 и максимум 40000000 пикселей. Sharp 0.35.5/libvips 8.18.7: failOn=warning, limitInputPixels=40000000, limitInputChannels=5, unlimited=false; metadata плюс stats по реальным пикселям. Buffer копируется до await и возвращается без перекодирования, пути не принимаются.
- Router перед будущими images.create/images.update вызывает валидацию; method/Origin/session и отсутствие handler проверяются раньше тела. Production tools/serve.mjs не подключает эти handlers, после guards остаётся 501. Тестовые sinks не пишут images; сохранение — P19.
- Изменены Node-модули/Router, tests и зависимости busboy/sharp+lockfile. Клиент, Worker, P17, миграции и исторические материалы не менялись. Корневое происхождение экспортных метаданных сохранено.

## Полная приёмка

Результаты получены на коде C03 `7c7eaf6`; C04 меняет только документацию.

- Чистый npm ci с native sharp, npm run build, npm test — 142/142. Из них 17 новых P18: строгие параметры/Unicode, потоковые пределы/ранняя остановка/обрывы/подмена длины, декодирование форматов, ложный MIME/расширение, CRC/RIFF/хвост, анимации/размерные бомбы и повреждённые пиксели при корректных заголовках. JPEG ровно 20 МиБ и точные числовые границы проходят; мутация оригинального Buffer не меняет проверенную копию.
- Полный npm run test:db — 83/83, включая 4 P18 HTTP/PG: точные данные/доверенная сессия доходят до sink, ошибки файлов/metadata — нет; 401/403/413/501 приходят JSON до отправки тела, patch сохраняет включённый предел 8 КиБ. Изолированные схемы p18_test_<uuid> очищены, images не записываются.
- Браузерная регрессия: account — 7/7 (шесть размеров до 320×240), account-api — 10/10 (реальные сессии/Origin/отказы), drawings — 3/3 (P16 широкий/мобильный). Ошибок/отмен/пропусков нет.
- PostgreSQL 17.11, отдельные QA-БД/обычные роли, SCRAM и 28P01 неверного пароля, отсутствие SUPERUSER/CREATEDB/CREATEROLE подтверждены; обе миграции в обеих БД. Node 24.22.1 / npm 11.9.0 / Playwright 1.62.1 / Chromium 153.0.8010.0 / sharp 0.35.5 / vips 8.18.7.
- Worker SHA-256 прежний: 7671f8cde768dee738b690100776713e57c9c712de4cad9a9d99d09e5870fb48. Синтаксис, git diff --check, Markdown/локальные ссылки, VERSION/current_application, дословная сохранность P19–P32/исторических метаданных/материалов проверены. Версии прежних lockfile-пакетов не изменены.

## Доставка и следующий шаг

- C01–C03 сохранены и сверены по SHA/дереву. Сохранить/сверить C04, создать локальный тег, перевести PR #19 в ready, проверить head/reviews/checks/mergeable, выполнить обычный merge с ожидаемым head и подтвердить удалённое дерево/main. Не нужен дополнительный коммит ради собственного SHA слияния.
- При восстановлении сначала проверить PR #19 и main: если PR уже merged и принятое дерево соответствует итоговой точке, доставка закончена. P19 — следующая самостоятельная задача; без поручения не начинается.
- Теги не публикуются доступным плагином, git push не авторизован; коммиты/merge доступны через API. Sites не публиковался; живые картографические источники, физический телефон и HTTPS proxy отдельно не проверялись.

## Воспроизводимое окружение и доставка

Зависимости приложения — `npm ci`. QA-пакеты вне Git: `@sparticuz/chromium@153.0.0`, `@embedded-postgres/linux-x64@17.11.0-beta.19`; выполнить `node <qa>/node_modules/@embedded-postgres/linux-x64/scripts/hydrate-symlinks.js`. До импорта Chromium задать TMPDIR в доступный каталог; `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = await chromium.executablePath()`. Полный Chromium ранее не создавал Unix-сокет; Headless Shell подтверждён заново.

PostgreSQL: `initdb -D <qa>/db -U <admin> --encoding=UTF8 --locale=C`, запуск `postgres -D <qa>/db -h 127.0.0.1 -p <pg-port> -k '' -c dynamic_shared_memory_type=mmap`. Создать две отдельные БД с суффиксом `_test` и разные обычные роли для browser/integration. TCP обычных ролей требует SCRAM; неверный пароль подтверждён кодом 28P01. Пароли генерировать локально, не сохранять в Git.

Для browser БД: DATABASE_URL, DATABASE_SSL=disable, PUBLIC_ORIGIN=http://127.0.0.1:3018; выполнить `node tools/migrate.mjs`, затем `node tools/serve.mjs` с HOST=127.0.0.1/PORT=3018. Для integration: NODE_ENV=test и TEST_DATABASE_URL другой БД/роли, обе миграции (`node tools/migrate.mjs --test`); создать локальный `.env.test` для `npm run test:db`. P13_BASE_URL/P14_BASE_URL/P16_BASE_URL равны PUBLIC_ORIGIN; P14_TEST_DATABASE_URL — БД браузерного Node. QA AUTH_REGISTER_MAX_ATTEMPTS/AUTH_LOGIN_MAX_ATTEMPTS=1000. Запускать процессы и тесты в одной команде из-за изоляции loopback; завершать процессы после проверки. PNG/диагностика — P13_ARTIFACT_DIR/P14_ARTIFACT_DIR/P16_ARTIFACT_DIR вне Git.

Доставка — GitHub Git API, обычные последовательные коммиты с подтверждением SHA/дерева. Теги плагин не публикует; git push раньше не был авторизован. Sites не поручен. Живые картографические источники, физический телефон и HTTPS proxy отдельно не проверяются; прежняя проблема свёрнутых панелей остаётся P31.

Целевой P18-прогон: `node --env-file=.env.test --test tests/integration/image-validation.test.mjs`. В текущем QA используются p18_browser_test/p18_regression_test с разными обычными ролями и PostgreSQL на 127.0.0.1:55618; browser Origin — http://127.0.0.1:3018. Логи/PNG вне Git. После приёмки процессы остановлены.

Новые Node-зависимости устанавливаются обычным npm ci с optional dependencies. Целевые тесты: node --test tests/image-metadata.test.mjs tests/image-multipart.test.mjs tests/image-validation.test.mjs; отдельный HTTP/PG — node --env-file=.env.test --test tests/integration/image-validation.test.mjs. Полные команды/условия — журнал README P18. После приёмки процессы остановлены, логи/PNG вне Git.

## История

- `P18-C01` (`ea8472f`) — база, границы и план.
- `P18-C02` (`febed7f`) — metadata/имя и потоковый multipart, версия 31 и зависимости, 135 обычных тестов.
- `P18-C03` (`7c7eaf6`) — содержимое/статичность/размеры/декодирование и Router, 142 обычные и 4 целевые Node/PostgreSQL-проверки.
- `P18-C04` — полная приёмка 142/83/7/10/3, README/метаданные/остаток плана, тег/PR #19 и доставка.
