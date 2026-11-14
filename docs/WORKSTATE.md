# Текущее состояние работы

Порядок продолжения — [README 19.9](../README.md#checkpoint-workflow). Доставку проверять по GitHub.

| Поле | Значение |
| --- | --- |
| Пункт | P18: серверная проверка файлов и геопривязки |
| Статус | План и границы установлены; продуктовый код ещё не изменён |
| Контрольная точка | `P18-C01` |
| Ветка | `iteration-031-p18-image-validation` |
| База и подтверждённый main | `cbb11b1a75a692e289577e69b342da8e58453bbd`, P17 принята в PR #18 |
| Версия | База 30; при первом функциональном изменении — 31 |

## Границы и решения

- Пользователь поручил выполнить P18 с промежуточными коммитами; продолжается ранее порученное слияние принятых завершённых веток. Действующий To do list найден. P19–P32 не начинать.
- Серверные модули проверят metadata/bounds/angle/opacity/locked и multipart: ровно file+metadata, файл 1–20 МиБ, metadata до 8 КиБ, тело до 21 МиБ. Реальные байты считаются в потоке, ложный Content-Length не обходит лимит. Имя — безопасное базовое Unicode-имя; owner/ID/серверные поля клиента не принимаются.
- Проверять сигнатуру/MIME/структурную целостность PNG/JPEG/WebP, статичный одиночный кадр и реальные размеры до полного декодирования: оси до 16384, всего до 40000000 пикселей. SVG/HTML/анимации/повреждения/несоответствие MIME отклоняются. Исходные байты не перекодируются.
- Для полноценного декодирования планируется Node-only sharp с failOn=warning/limitInputPixels; для потокового multipart — busboy с ограничениями. Закрепить версии и проверить native-зависимость через npm ci. Worker и браузер не должны импортировать эти библиотеки.
- Router будет использовать подготовленный валидатор при наличии будущего images.create handler. Сейчас production handler отсутствует, после guards остаётся 501 до чтения тела. Тестовый HTTP-handler проверит путь валидации отдельно от будущей записи P19. Миграции и контракт P17 сохраняются.

## План контрольных точек

1. C01 — база, границы, план и способ проверки (эта точка).
2. C02 — metadata/имя и ограниченный потоковый multipart, тесты пределов/обходов, версия 31.
3. C03 — сигнатуры/структура/полное декодирование PNG/JPEG/WebP, статичность/размеры, Router и тестовые HTTP/БД-сценарии; сохранить до полной регрессии.
4. C04 — итоговая приёмка build/test/test:db и браузерных регрессий, README/метаданные/остаток плана, тег/PR/слияние. Дополнительная точка допустима для выявленных исправлений.

## Проверки и следующий шаг

- Удалённый main cbb11b1 подтверждён; рабочая копия исходно чистая. Прежние результаты P17 не являются приёмкой P18.
- Новые проверки ещё не запускались. Сначала закрепить зависимости, реализовать metadata/имя и потоковые лимиты, проверить точные границы/прерывание/дубликаты/неверные типы/поля.
- Политика ошибок: 400 VALIDATION_ERROR/INVALID_IMAGE, 413 PAYLOAD_TOO_LARGE, 415 UNSUPPORTED_MEDIA_TYPE; детали декодера/SQL/байты не отражаются в ошибках.
- Первичные источники проверены: документация sharp constructor/metadata/stats (https://sharp.pixelplumbing.com/api-constructor/ и https://sharp.pixelplumbing.com/api-input/), busboy API (https://github.com/mscdex/busboy). metadata не декодирует пиксели; отдельный проход stats нужен для реальной проверки содержимого.

## Воспроизводимое окружение и доставка

Зависимости приложения — `npm ci`. QA-пакеты вне Git: `@sparticuz/chromium@153.0.0`, `@embedded-postgres/linux-x64@17.11.0-beta.19`; выполнить `node <qa>/node_modules/@embedded-postgres/linux-x64/scripts/hydrate-symlinks.js`. До импорта Chromium задать TMPDIR в доступный каталог; `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = await chromium.executablePath()`. Полный Chromium ранее не создавал Unix-сокет; Headless Shell подтверждён заново.

PostgreSQL: `initdb -D <qa>/db -U <admin> --encoding=UTF8 --locale=C`, запуск `postgres -D <qa>/db -h 127.0.0.1 -p <pg-port> -k '' -c dynamic_shared_memory_type=mmap`. Создать две отдельные БД с суффиксом `_test` и разные обычные роли для browser/integration. TCP обычных ролей требует SCRAM; неверный пароль подтверждён кодом 28P01. Пароли генерировать локально, не сохранять в Git.

Для browser БД: DATABASE_URL, DATABASE_SSL=disable, PUBLIC_ORIGIN=http://127.0.0.1:3017; выполнить `node tools/migrate.mjs`, затем `node tools/serve.mjs` с HOST=127.0.0.1/PORT=3017. Для integration: NODE_ENV=test и TEST_DATABASE_URL другой БД/роли, обе миграции (`node tools/migrate.mjs --test`); создать локальный `.env.test` для `npm run test:db`. P13_BASE_URL/P14_BASE_URL/P16_BASE_URL равны PUBLIC_ORIGIN; P14_TEST_DATABASE_URL — БД браузерного Node. QA AUTH_REGISTER_MAX_ATTEMPTS/AUTH_LOGIN_MAX_ATTEMPTS=1000. Запускать процессы и тесты в одной команде из-за изоляции loopback; завершать процессы после проверки. PNG/диагностика — P13_ARTIFACT_DIR/P14_ARTIFACT_DIR/P16_ARTIFACT_DIR вне Git.

Доставка — GitHub Git API, обычные последовательные коммиты с подтверждением SHA/дерева. Теги плагин не публикует; git push раньше не был авторизован. Sites не поручен. Живые картографические источники, физический телефон и HTTPS proxy отдельно не проверяются; прежняя проблема свёрнутых панелей остаётся P31.

Целевой P17-прогон: `node --env-file=.env.test --test tests/integration/image-repository.test.mjs`. В текущем QA используются p17_browser_test/p17_regression_test с разными обычными ролями и PostgreSQL на 127.0.0.1:55617; browser Origin — http://127.0.0.1:3017. Логи/PNG вне Git. После приёмки процессы остановлены.

## История

- `P18-C01` — установлена база, границы и план проверки.
