-- init_db.sql (ОБНОВЛЁННЫЙ)

-- Таблица пользователей
CREATE TABLE IF NOT EXISTS public.users (
    user_id BIGINT PRIMARY KEY,         -- Telegram user ID
    user_unique_id VARCHAR(50) UNIQUE,  -- Наш сгенерированный ID (USR-...)
    username VARCHAR(50),
    fullname VARCHAR(100),
    state VARCHAR(20) NOT NULL,
    last_interaction TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Таблица адресов (пул)
CREATE TABLE IF NOT EXISTS public.address_pool (
    id SERIAL PRIMARY KEY,
    address VARCHAR(42) UNIQUE NOT NULL,
    private_key TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Таблица постов
CREATE TABLE IF NOT EXISTS public.posts (
    id SERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL,
    amount BIGINT NOT NULL,  -- цена в минимальных единицах
    description TEXT,
    chat_id BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Таблица услуг/покупок
-- ВАЖНО: добавляем столбец post_id INTEGER, потому что server.js на него ссылается
CREATE TABLE IF NOT EXISTS public.services (
    id SERIAL PRIMARY KEY,
    service_name VARCHAR(100) NOT NULL,
    amount BIGINT NOT NULL,
    temp_address VARCHAR(42) NOT NULL,
    initial_balance BIGINT NOT NULL DEFAULT 0,
    payment_deadline TIMESTAMP NOT NULL,
    message_id INTEGER,
    is_paid BOOLEAN NOT NULL DEFAULT FALSE,
    is_expired BOOLEAN NOT NULL DEFAULT FALSE,
    paid_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    user_id BIGINT NOT NULL REFERENCES public.users(user_id),
    group_chat_id BIGINT NOT NULL,
    exclusive_content TEXT,
    post_id INTEGER  -- добавлен для связи с public.posts
);

-- (Опционально) Таблица settings
CREATE TABLE IF NOT EXISTS public.settings (
    key VARCHAR(50) PRIMARY KEY,
    value VARCHAR(100) NOT NULL
);

-- Пример заранее добавленных адресов в пул:
INSERT INTO public.address_pool (address, private_key, is_active) VALUES
('$ADDRESS_1', '${PRIVATE_KEY_1}', false),
('$ADDRESS_2', '${PRIVATE_KEY_2}', false),
('$ADDRESS_3', '${PRIVATE_KEY_3}', false)
ON CONFLICT (address) DO NOTHING;

-- Пример добавления администратора (замените ID/имя при необходимости)
INSERT INTO public.users (user_id, user_unique_id, state, last_interaction, username, fullname)
VALUES
(1087968824, 'USR-ADMIN001', 'IDLE', NOW(), 'AdminUser', 'Admin FullName')
ON CONFLICT (user_id) DO NOTHING;
