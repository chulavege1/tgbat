-- ОБНОВЛЁННАЯ СХЕМА init_db.sql

-- Используем numeric(78,0), чтобы избежать "out of range for type bigint" для очень больших чисел:
-- (Постгресовский bigint лимит ~9.22e18, а 21 токен с 18 decimals = 2.1e19)
-- numeric(78,0) позволяет хранить значения до 78 цифр без запятой.

CREATE TABLE IF NOT EXISTS public.users (
    user_id BIGINT PRIMARY KEY,
    user_unique_id VARCHAR(50) UNIQUE,
    username VARCHAR(50),
    fullname VARCHAR(100),
    state VARCHAR(20) NOT NULL,
    last_interaction TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.address_pool (
    id SERIAL PRIMARY KEY,
    address VARCHAR(42) UNIQUE NOT NULL,
    private_key TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.posts (
    id SERIAL PRIMARY KEY,
    message_id INTEGER NOT NULL,
    amount numeric(78,0) NOT NULL,
    description TEXT,
    chat_id BIGINT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.services (
    id SERIAL PRIMARY KEY,
    service_name VARCHAR(100) NOT NULL,
    amount numeric(78,0) NOT NULL,
    temp_address VARCHAR(42) NOT NULL,
    initial_balance numeric(78,0) NOT NULL DEFAULT 0,
    payment_deadline TIMESTAMP NOT NULL,
    message_id INTEGER,
    is_paid BOOLEAN NOT NULL DEFAULT FALSE,
    is_expired BOOLEAN NOT NULL DEFAULT FALSE,
    paid_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    user_id BIGINT NOT NULL REFERENCES public.users(user_id),
    group_chat_id BIGINT NOT NULL,
    exclusive_content TEXT,
    post_id INTEGER
);

CREATE TABLE IF NOT EXISTS public.settings (
    key VARCHAR(50) PRIMARY KEY,
    value VARCHAR(100) NOT NULL
);

-- Пример заранее добавленных адресов в пул:
INSERT INTO public.address_pool (address, private_key, is_active) VALUES
('0xa1334eA681121126D8a30F120aDc8DEAE13dCD18', '65b60be5f476fe31373ec5390a505955ab7957ab0607f0d19f94352c9c923585', false),
('0x40A79c6F7861186F2D3a0c8C943f6303469e2267', '421a03f2509380f3160d62f92ed9a636a1bb3cb76cb2427f6850b56640058bf7', false),
('0x7b8d02d4a6972320680113fAf18933352f41F054', '99d4c8d66534a4caf2564b747260bd15dd17708bd4392e09b350cc7a3fcf0d6d', false)
ON CONFLICT (address) DO NOTHING;

-- Пример добавления администратора (замените ID/имя при необходимости)
INSERT INTO public.users (user_id, user_unique_id, state, last_interaction, username, fullname)
VALUES
(1087968824, 'USR-ADMIN001', 'IDLE', NOW(), 'AdminUser', 'Admin FullName')
ON CONFLICT (user_id) DO NOTHING;
