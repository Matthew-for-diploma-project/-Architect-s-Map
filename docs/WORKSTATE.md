# Текущее состояние работы

Порядок продолжения — [README 19.9](../README.md#checkpoint-workflow). Доставку проверять по GitHub.

| Поле | Значение |
| --- | --- |
| Пункт | P19: защищённая загрузка изображения в PostgreSQL |
| Статус | Границы и план установлены, продуктовый код ещё не изменён |
| Контрольная точка | `P19-C01` |
| Ветка | `iteration-032-p19-image-upload` |
| База и подтверждённый main | `2070644f1922f57efdc13c0dec1993d7036a897a`, принятое P18 PR #19 |
| Версия | База 31; при первом функциональном изменении — 32 |

## Границы и решения

- Пользователь поручил P19 с промежуточными коммитами; продолжается ранее порученное слияние принятых завершённых веток. Действующий To do list найден. P20–P32 не начинать.
- Подключить images.create в tools/serve.mjs: Router P18 проверяет method/Origin/session и ограниченный multipart/полное содержимое до handler. Новый image-upload.mjs получает проверенные серверные поля, владелец — только trusted auth из guard; повторная проверка identity перед получением transaction client.
- Использовать createImageRepository P17 и общий withTransaction: байты+метаданные одной строкой images, JSON {image} со статусом 201 построить внутри транзакции и вернуть только после подтверждённого COMMIT. Ответ без owner/байтов/секретов; ID/размер/начальные ревизия/даты задаёт сервер/БД.
- Один запрос — один файл. Отдельные запросы независимы; одинаковые имена не означают дубликат. Ошибка INSERT/ответа откатывает только текущую транзакцию, успех предыдущих файлов сохраняется. Не повторять POST автоматически при неопределённом COMMIT/потерянном ответе.
- P20 GET/list/file, P21 PATCH, P22 DELETE и настройки слоя пока 501 после guards. Клиент пока работает локально; подключение загрузки UI — P24. Новые миграции/зависимости не нужны; Worker и исторические материалы сохраняются.

## План контрольных точек

1. C01 — база, границы и план (эта точка).
2. C02 — handler/production wiring, обычные и базовые реальные HTTP/PG-проверки, версия 32.
3. C03 — отказ/rollback/параллельные и независимые загрузки/неопределённый COMMIT, реальный tools/serve.mjs; сохранить до полной регрессии.
4. C04 — npm ci/build/test/test:db и браузерные регрессии, README/журнал/метаданные/остаток плана, тег/PR/слияние. При выявленных исправлениях допустима дополнительная точка.

## Проверки и следующий шаг

- Удалённый main 2070644 и принятое дерево P18 подтверждены, рабочая копия исходно чистая. Прежние результаты P18 не являются приёмкой P19.
- Новые проверки ещё не запускались. Следующий шаг: изучить withTransaction и production Node helper, реализовать handler без повторного декодирования P18, проверить authenticated/guest/Origin, точные поля/байты/defaults и безопасный 201 после COMMIT.
- Отдельно проверить ошибки БД/сериализации/COMMIT, отсутствие автоматического retry и утечек данных; согласовать прежний 501 POST-smoke с новым handler, сохранив 501 чтений/изменений будущих пунктов.

## Воспроизводимое окружение и доставка

Зависимости приложения — `npm ci`. QA-пакеты вне Git: `@sparticuz/chromium@153.0.0`, `@embedded-postgres/linux-x64@17.11.0-beta.19`; выполнить `node <qa>/node_modules/@embedded-postgres/linux-x64/scripts/hydrate-symlinks.js`. До импорта Chromium задать TMPDIR в доступный каталог; `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = await chromium.executablePath()`. Полный Chromium ранее не создавал Unix-сокет; Headless Shell подтверждён заново.

PostgreSQL: `initdb -D <qa>/db -U <admin> --encoding=UTF8 --locale=C`, запуск `postgres -D <qa>/db -h 127.0.0.1 -p <pg-port> -k '' -c dynamic_shared_memory_type=mmap`. Создать две отдельные БД с суффиксом `_test` и разные обычные роли для browser/integration. TCP обычных ролей требует SCRAM; неверный пароль подтверждён кодом 28P01. Пароли генерировать локально, не сохранять в Git.

Для browser БД: DATABASE_URL, DATABASE_SSL=disable, PUBLIC_ORIGIN=http://127.0.0.1:3018; выполнить `node tools/migrate.mjs`, затем `node tools/serve.mjs` с HOST=127.0.0.1/PORT=3018. Для integration: NODE_ENV=test и TEST_DATABASE_URL другой БД/роли, обе миграции (`node tools/migrate.mjs --test`); создать локальный `.env.test` для `npm run test:db`. P13_BASE_URL/P14_BASE_URL/P16_BASE_URL равны PUBLIC_ORIGIN; P14_TEST_DATABASE_URL — БД браузерного Node. QA AUTH_REGISTER_MAX_ATTEMPTS/AUTH_LOGIN_MAX_ATTEMPTS=1000. Запускать процессы и тесты в одной команде из-за изоляции loopback; завершать процессы после проверки. PNG/диагностика — P13_ARTIFACT_DIR/P14_ARTIFACT_DIR/P16_ARTIFACT_DIR вне Git.

Доставка — GitHub Git API, обычные последовательные коммиты с подтверждением SHA/дерева. Теги плагин не публикует; git push раньше не был авторизован. Sites не поручен. Живые картографические источники, физический телефон и HTTPS proxy отдельно не проверяются; прежняя проблема свёрнутых панелей остаётся P31.

Целевой P18-прогон: `node --env-file=.env.test --test tests/integration/image-validation.test.mjs`. В текущем QA используются p18_browser_test/p18_regression_test с разными обычными ролями и PostgreSQL на 127.0.0.1:55618; browser Origin — http://127.0.0.1:3018. Логи/PNG вне Git. После приёмки процессы остановлены.

Новые Node-зависимости устанавливаются обычным npm ci с optional dependencies. Целевые тесты: node --test tests/image-metadata.test.mjs tests/image-multipart.test.mjs tests/image-validation.test.mjs; отдельный HTTP/PG — node --env-file=.env.test --test tests/integration/image-validation.test.mjs. Полные команды/условия — журнал README P18. После приёмки процессы остановлены, логи/PNG вне Git.

## История

- `P19-C01` — установлены база, границы и план проверки.
