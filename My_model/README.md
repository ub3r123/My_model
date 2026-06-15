# DAG Genesis Rotation Simulator

Симулятор DAG-модели с P2P-сетью, локальными DAG у узлов, validation blocks, PoS-весами, финализацией слотов и атаками конфликтными транзакциями.

## Что нужно установить

Для запуска с нуля нужны:

- **Node.js 18+** - запускает локальный HTTP-сервер и сам симулятор в браузере.
- **Python 3.10+** - используется для генерации PNG-графиков через Matplotlib.
- **pip** - ставит Python-зависимости из `requirements.txt`.

Проверка установки:

```powershell
node --version
npm --version
python --version
pip --version
```

Важно: команда `python` должна быть доступна из терминала, потому что сервер вызывает Python-скрипт генерации графиков.

## Установка зависимостей

Перейти в папку проекта:

```powershell
cd "C:\lab\4 kurs\8sem\NIR\My_model"
```

Установить Python-зависимости:

```powershell
python -m pip install -r requirements.txt
```

В проекте нет внешних JavaScript-библиотек, поэтому отдельная установка npm-зависимостей не обязательна. Команда `npm start` работает через стандартный Node.js.

При желании можно создать локальное Python-окружение:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
```

Если PowerShell запрещает активацию окружения, разрешить ее только для текущего окна:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
```

## Запуск симулятора

Из папки `My_model`:

```powershell
npm start
```

По умолчанию сервер запускается на:

```text
http://127.0.0.1:8090/
```

Если порт занят, сервер автоматически попробует следующий порт и напишет адрес в консоль, например:

```text
My_model simulator: http://127.0.0.1:8091
```

Можно явно задать порт:

```powershell
$env:PORT=8092
npm start
```

Остановить сервер:

```text
Ctrl + C
```

## Как пользоваться

1. Открыть адрес сервера в браузере.
2. Настроить параметры сети, DAG, validation blocks и атаки.
3. Нажать **Старт** для запуска симуляции.
4. Нажать **Пауза**, чтобы зафиксировать состояние.
5. Нажать **Создать PNG**, чтобы сохранить графики.

Графики создаются только на паузе. Файлы сохраняются в папку:

```text
My_model/exports
```

Логи симуляции создаются в папке:

```text
My_model/logs
```

## Основные возможности

- P2P-сеть из виртуальных узлов.
- Gossip-распространение транзакций и validation blocks.
- Локальная видимость DAG у каждого узла.
- Выбор родителей обычными транзакциями по локальным tips.
- Выбор `past cone` validation blocks жадным алгоритмом покрытия.
- PoS-веса валидаторов и финализация по порогу `2/3`.
- Состояния транзакций: `PENDING`, `ACCEPTED`, `REJECTED`, `ACCEPTED_CONFLICT_LOST`.
- Локальное состояние позднего получения транзакции.
- Сворачивание эпох и переход к новому genesis.
- Атаки конфликтными транзакциями.
- Экспорт графиков через Python/Matplotlib.

## Структура проекта

```text
My_model/
  index.html              # интерфейс симулятора
  style.css               # стили интерфейса
  server.js               # локальный HTTP-сервер, экспорт графиков и логов
  package.json            # npm-команда запуска
  requirements.txt        # Python-зависимости для графиков
  src/
    sim/                  # логика симуляции DAG, сети, VB и атак
    ui/                   # логика интерфейса
  scripts/
    render_charts.py      # генерация PNG-графиков через Matplotlib
  exports/                # созданные графики
  logs/                   # NDJSON-логи прогонов
  docs/                   # описание правил симуляции для отчета
```

## Частые проблемы

### `python` не найден

Установить Python и включить опцию **Add Python to PATH**. После этого открыть новый терминал и проверить:

```powershell
python --version
```

### Ошибка при создании PNG

Проверить, что установлен Matplotlib:

```powershell
python -m pip install -r requirements.txt
```

Также важно запускать проект через сервер (`npm start`), а не просто открывать `index.html` двойным кликом.

### Порт занят

Сервер обычно сам выбирает следующий свободный порт. Также можно задать порт вручную:

```powershell
$env:PORT=8095
npm start
```

## Документация для отчета

- [Правила симуляции DAG, P2P-сети и выбора параметров](./docs/simulation_rules_and_parameters.md)
