#!/bin/bash

# Переменные
DB_USER="tolyper"
DB_PASSWORD="demontools"
DB_NAME="mydatabase"
SQL_SCRIPT="init_db.sql"

# Загрузка переменных окружения из .env файла
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
else
  echo ".env файл не найден. Пожалуйста, создайте его и задайте необходимые переменные."
  exit 1
fi

# Проверка существования пользователя
USER_EXISTS=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'")

if [ "$USER_EXISTS" != "1" ]; then
  echo "Создание пользователя PostgreSQL: $DB_USER"
  sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';"
else
  echo "Пользователь PostgreSQL $DB_USER уже существует. Пропуск создания."
fi

# Проверка существования базы данных
DB_EXISTS=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'")

if [ "$DB_EXISTS" != "1" ]; then
  echo "Создание базы данных: $DB_NAME"
  sudo -u postgres createdb -O $DB_USER $DB_NAME
else
  echo "База данных $DB_NAME уже существует. Пропуск создания."
fi

# Проверка наличия необходимых переменных окружения для приватных ключей и адресов
if [ -z "$PRIVATE_KEY_1" ] || [ -z "$PRIVATE_KEY_2" ] || [ -z "$PRIVATE_KEY_3" ]; then
  echo "Необходимо задать PRIVATE_KEY_1, PRIVATE_KEY_2 и PRIVATE_KEY_3 в .env файле."
  exit 1
fi

if [ -z "$ADDRESS_1" ] || [ -z "$ADDRESS_2" ] || [ -z "$ADDRESS_3" ]; then
  echo "Необходимо задать ADDRESS_1, ADDRESS_2 и ADDRESS_3 в .env файле."
  exit 1
fi

# Замена переменных в SQL-скрипте и выполнение
echo "Создание таблиц и добавление адресов в базе данных: $DB_NAME"
envsubst < $SQL_SCRIPT | PGPASSWORD=$DB_PASSWORD psql -U $DB_USER -d $DB_NAME -h localhost

echo "Инициализация базы данных завершена успешно."