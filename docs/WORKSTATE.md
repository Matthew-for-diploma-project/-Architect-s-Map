# Текущее состояние работы

Порядок продолжения — [README 19.9](../README.md#checkpoint-workflow). Доставку проверять по GitHub.

| Поле | Значение |
| --- | --- |
| Пункт | P19: защищённая загрузка изображения в PostgreSQL |
| Статус | Загрузка и отказ/атомарность проверены; полная регрессия ожидается |
| Контрольная точка | `P19-C03` |
| Ветка | `iteration-032-p19-image-upload` |
| База и подтверждённый main | `2070644f1922f57efdc13c0dec1993d7036a897a`, принятое P18 PR #19 |
| Версия | 32 в работе; тег ещё не создан |

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

## Сделано и проверки C02

- image-upload.mjs подключён как images.create в tools/serve.mjs. requireImageOwner из P17 экспортирован для общей проверки trusted identity до connect; поведение запросов P17 сохранено. Handler получает уже проверенные P18 поля, один client и INSERT сохраняют байты/метаданные, safe Response.json({image},201) строится до COMMIT, возвращается после подтверждения. Декодирование не держит client/транзакцию.
- npm run build, npm test — 148/148, из них 6 handler-тестов P19: гость/неверный auth не получает client, 201 ждёт COMMIT, байты/owner связываются, ошибки INSERT/connect/сериализации откатываются, неопределённый COMMIT/сломанный client не повторяет запись и безопасно освобождается.
- Целевые Node/PostgreSQL — 3/3: PNG/JPEG/WebP с defaults/custom metadata для A/B сохранены точно, JSON не содержит owner/байтов; гость/отозванная/истёкшая сессия и Origin/413 отвергаются до тела и write transaction. Неверный файл/MIME/анимация, подмена owner/ID/размеров, дубликаты metadata/файла, превышение размера не создают строку и не получают write client.
- Production smoke прежнего raw POST согласован: при подтверждённом входе неподдержанное тело теперь получает 415 вместо старой 501; GET и следующие операции остаются 501.
- VERSION/current_application=32/in_progress. Worker прежний: 7671f8cde768dee738b690100776713e57c9c712de4cad9a9d99d09e5870fb48. Полный test:db и браузеры P19 ещё не запускались; приёмка не закрыта.

## Сделано и проверки C03

- Реальные Node/PostgreSQL-сценарии дополнены до 8: AFTER INSERT ошибка откатывает байты/метаданные, ошибка после INSERT при сериализации тоже откатывает строку; неуспешный файл не отменяет прошлые/чужие успешные и не меняет layer_settings. Одинаковые имена создают разные серверные ID.
- Два HTTP-запроса с PNG/JPEG от A/B одновременно удерживаются после реальных INSERT до COMMIT. Другая connection видит 0 строк до освобождения gate, ответы ещё не получены; затем оба 201 и правильные owner/байты/разные ID.
- Потеря подтверждения COMMIT симулируется после реального COMMIT: HTTP получает безопасный 503, в БД ровно одна сохранённая строка, повторного INSERT/POST нет, client уничтожается. В этом случае факт записи неопределён для клиента; автоматический повтор запрещён.
- Добавлен настоящий процесс tools/serve.mjs: production POST с действующей cookie/Origin сохраняет PNG/metadata/defaults и отдаёт safe 201, fileUrl пока 501 (P20). Секреты не попадают в stdout; тест удаляет только собственного пользователя/каскадные данные.
- npm test — 148/148; целевой прогон P19 + database.test.mjs — 23/23 (8 загрузочных и 15 БД/процессных, включая новый production upload). Новые схемы p19_test_<uuid> очищены, роли обычные/SCRAM/28P01, обе миграции.
- Изменены только проверки/документация относительно C02; продуктовый код прежний. Полный PostgreSQL-набор теперь 92 проверки, ещё не запускался; браузеры P19 ещё не запускались. Пункт остаётся in_progress.

## Следующий шаг

Выполнить npm ci/build/test, полный test:db и браузерные регрессии на итоговом коде. После приёмки обновить журнал/README/метаданные, удалить только P19 с сохранением P20–P32, сохранить C04, тег/PR/слияние. P20 не начинать.

## Воспроизводимое окружение и доставка

Зависимости приложения — `npm ci`. QA-пакеты вне Git: `@sparticuz/chromium@153.0.0`, `@embedded-postgres/linux-x64@17.11.0-beta.19`; выполнить `node <qa>/node_modules/@embedded-postgres/linux-x64/scripts/hydrate-symlinks.js`. До импорта Chromium задать TMPDIR в доступный каталог; `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = await chromium.executablePath()`. Полный Chromium ранее не создавал Unix-сокет; Headless Shell подтверждён заново.

PostgreSQL: `initdb -D <qa>/db -U <admin> --encoding=UTF8 --locale=C`, запуск `postgres -D <qa>/db -h 127.0.0.1 -p <pg-port> -k '' -c dynamic_shared_memory_type=mmap`. Создать две отдельные БД с суффиксом `_test` и разные обычные роли для browser/integration. TCP обычных ролей требует SCRAM; неверный пароль подтверждён кодом 28P01. Пароли генерировать локально, не сохранять в Git.

Для browser БД: DATABASE_URL, DATABASE_SSL=disable, PUBLIC_ORIGIN=http://127.0.0.1:3018; выполнить `node tools/migrate.mjs`, затем `node tools/serve.mjs` с HOST=127.0.0.1/PORT=3018. Для integration: NODE_ENV=test и TEST_DATABASE_URL другой БД/роли, обе миграции (`node tools/migrate.mjs --test`); создать локальный `.env.test` для `npm run test:db`. P13_BASE_URL/P14_BASE_URL/P16_BASE_URL равны PUBLIC_ORIGIN; P14_TEST_DATABASE_URL — БД браузерного Node. QA AUTH_REGISTER_MAX_ATTEMPTS/AUTH_LOGIN_MAX_ATTEMPTS=1000. Запускать процессы и тесты в одной команде из-за изоляции loopback; завершать процессы после проверки. PNG/диагностика — P13_ARTIFACT_DIR/P14_ARTIFACT_DIR/P16_ARTIFACT_DIR вне Git.

Доставка — GitHub Git API, обычные последовательные коммиты с подтверждением SHA/дерева. Теги плагин не публикует; git push раньше не был авторизован. Sites не поручен. Живые картографические источники, физический телефон и HTTPS proxy отдельно не проверяются; прежняя проблема свёрнутых панелей остаётся P31.

Целевой P18-прогон: `node --env-file=.env.test --test tests/integration/image-validation.test.mjs`. В текущем QA используются p18_browser_test/p18_regression_test с разными обычными ролями и PostgreSQL на 127.0.0.1:55618; browser Origin — http://127.0.0.1:3018. Логи/PNG вне Git. После приёмки процессы остановлены.

Новые Node-зависимости устанавливаются обычным npm ci с optional dependencies. Целевые тесты: node --test tests/image-metadata.test.mjs tests/image-multipart.test.mjs tests/image-validation.test.mjs; отдельный HTTP/PG — node --env-file=.env.test --test tests/integration/image-validation.test.mjs. Полные команды/условия — журнал README P18. После приёмки процессы остановлены, логи/PNG вне Git.

## История

- `P19-C01` — установлены база, границы и план проверки.
- `P19-C02` — handler/production POST и общий auth helper, версия 32, 148 обычных и 3 целевые HTTP/PostgreSQL-проверки; приёмка ожидается.
- `P19-C03` — реальные отказы/rollback, независимые/параллельные загрузки, неопределённый COMMIT и production upload, 148 обычных и 23 целевые PostgreSQL-проверки; общая регрессия ожидается.
