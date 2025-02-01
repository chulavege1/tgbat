// server.js

import { ethers } from "ethers";
import pkg from "pg";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";

dotenv.config();
const { Pool } = pkg;

const app = express();
app.use(express.json());
app.use(cors());

// Подключение к PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL_ACTIVE,
  ssl: process.env.NODE_ENV === "prod" ? { rejectUnauthorized: false } : false,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000,
});

pool.connect()
  .then(async (client) => {
    console.log("Подключено к PostgreSQL");
    await client.query("SELECT current_database()");
    // Сбрасываем активные адреса при старте
    await client.query("UPDATE public.address_pool SET is_active = false WHERE is_active = true");
    client.release();
  })
  .catch((err) => {
    console.error("Ошибка подключения к БД:", err);
    process.exit(1);
  });

// Функции работы с пулом адресов
const getFreeAddress = async () => {
  try {
    const res = await pool.query(
      "SELECT address FROM public.address_pool WHERE is_active = false LIMIT 1 FOR UPDATE SKIP LOCKED"
    );
    if (res.rowCount > 0) {
      const address = res.rows[0].address;
      await pool.query("UPDATE public.address_pool SET is_active = true WHERE address = $1", [address]);
      return address;
    }
    return null;
  } catch (err) {
    console.error("Ошибка getFreeAddress:", err.message);
    return null;
  }
};

const releaseAddress = async (address) => {
  try {
    await pool.query("UPDATE public.address_pool SET is_active = false WHERE address = $1", [address]);
  } catch (err) {
    console.error("Ошибка releaseAddress:", err.message);
  }
};

// Инициализация бота
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN не задана!");
  process.exit(1);
}
const bot = new TelegramBot(token, { polling: true });

// Узнаём username бота
let botUsername = "";
bot.getMe().then((info) => {
  botUsername = info.username;
  console.log(`Бот @${botUsername} запущен`);
});

// Определяем окружение
// dev  => Sepolia Testnet (6 decimals, для примерного ERC20)
// prod => BSC Mainnet (18 decimals, для BUSD/USDT и т.д.)
const ENV = process.env.NODE_ENV;
const CONFIG = {
  prod: {
    rpcUrl: process.env.BSC_RPC_URL,
    usdtAddress: process.env.BUSD_CONTRACT_ADDRESS,
    chainName: "BSC Mainnet",
    decimals: 18,
  },
  dev: {
    rpcUrl: process.env.SEPOLIA_RPC_URL,
    usdtAddress: process.env.SEPOLIA_USDT_CONTRACT_ADDRESS,
    chainName: "Sepolia Testnet",
    decimals: 6,
  },
};
const { rpcUrl, usdtAddress, chainName, decimals } = CONFIG[ENV] || {};

// Проверяем RPC и адрес
if (!rpcUrl || !usdtAddress || rpcUrl.length < 10 || usdtAddress.length < 10) {
  console.error("Ошибка: RPC или адрес контракта не заданы/некорректны!");
  console.error(`NODE_ENV=${ENV}`);
  console.error(`rpcUrl=${rpcUrl}`);
  console.error(`usdtAddress=${usdtAddress}`);
}

// Инициализация провайдера
let provider;
try {
  provider = new ethers.JsonRpcProvider(rpcUrl);
} catch (err) {
  console.error("Ошибка создания провайдера:", err.message);
}

// Инициализация контракта
const erc20ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 amount) returns (bool)",
];
let usdtContract = null;
try {
  if (provider && usdtAddress && usdtAddress.length > 0) {
    usdtContract = new ethers.Contract(usdtAddress, erc20ABI, provider);
    console.log("Контракт USDT/BUSD инициализирован");
  } else {
    console.warn("Внимание: контракт не инициализирован (проверьте переменные окружения)!");
  }
} catch (err) {
  console.error("Ошибка инициализации контракта:", err.message);
}

// Состояния
const userStates = {
  WAITING_PAYMENT: "WAITING_PAYMENT",
  IDLE: "IDLE",
};

const generateUserId = () => `USR-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

// -----------------------------------------------------
// 1. Создание поста в группе через "/setPrice <число>"
// -----------------------------------------------------
bot.on("message", async (msg) => {
  if (!msg.text) return;
  // Игнорируем всё, кроме группы/супергруппы
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") return;

  // Проверяем, что пишет админ
  if (msg.from.id.toString() !== process.env.ADMIN_ID) return;

  const pattern = /\/setPrice\s+(\d+(\.\d+)?)/;
  const found = msg.text.match(pattern);
  if (!found) return;

  const amountFloat = parseFloat(found[1]);
  const description = msg.text.replace(pattern, "").trim();

  try {
    // Преобразуем в базовые единицы
    const bigAmount = BigInt(Math.floor(amountFloat * 10 ** decimals)).toString();
    // Сохраняем пост, message_id = 0
    const insertPost = await pool.query(
      `INSERT INTO public.posts (message_id, amount, description, chat_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [0, bigAmount, description, msg.chat.id]
    );
    const postId = insertPost.rows[0].id;

    // Отправляем сообщение в группу с кнопкой
    const postMsg = await bot.sendMessage(
      msg.chat.id,
      `📢 *Новый пост*\n💰 *Сумма:* ${amountFloat} USDT\n${description}\nНажмите кнопку, чтобы оплатить (через бот).`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Оплатить",
                url: `https://t.me/${botUsername}?start=buy_subscription_${postId}`
              }
            ]
          ]
        }
      }
    );

    // Сохраняем message_id
    await pool.query(
      "UPDATE public.posts SET message_id = $1 WHERE id = $2",
      [postMsg.message_id, postId]
    );

    // Сообщаем результат
    bot.sendMessage(msg.chat.id, `✅ Пост создан. ID: ${postId}, message_id: ${postMsg.message_id}`);
  } catch (err) {
    console.error("Ошибка создания поста:", err.message);
  }
});

// ---------------------------------------------------------------------
// 2. /start buy_subscription_<postId> — пользователь начинает оплату
// ---------------------------------------------------------------------
bot.onText(/\/start(?:@[^ ]+)?(?: (.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const args = match[1] ? match[1].split("_") : [];
  const isPrivate = (msg.chat.type === "private");

  // Если пришло не из лички
  if (!isPrivate) {
    if (args.length === 3 && args[0] === "buy" && args[1] === "subscription") {
      const postId = parseInt(args[2], 10);
      const link = `https://t.me/${botUsername}?start=buy_subscription_${postId}`;
      return bot.sendMessage(
        chatId,
        `Пожалуйста, перейдите в личный чат с ботом: [ссылка](${link})`,
        { parse_mode: "Markdown" }
      );
    }
    return;
  }

  // В личке
  try {
    // Проверка/создание пользователя
    let userCheck = await pool.query("SELECT * FROM public.users WHERE user_id = $1", [msg.from.id]);
    let userUniqueId;
    if (userCheck.rowCount === 0) {
      userUniqueId = generateUserId();
      await pool.query(
        `INSERT INTO public.users (user_id, user_unique_id, state, last_interaction)
         VALUES ($1, $2, $3, NOW())`,
        [msg.from.id, userUniqueId, userStates.IDLE]
      );
    } else {
      userUniqueId = userCheck.rows[0].user_unique_id;
      await pool.query("UPDATE public.users SET last_interaction = NOW() WHERE user_id = $1", [msg.from.id]);
    }

    // Если это "buy_subscription_<postId>"
    if (args.length === 3 && args[0] === "buy" && args[1] === "subscription") {
      const postId = parseInt(args[2], 10);

      // Ищем пост
      const postRes = await pool.query(
        "SELECT id, amount, chat_id FROM public.posts WHERE id = $1",
        [postId]
      );
      if (postRes.rowCount === 0) {
        return bot.sendMessage(chatId, "❌ Пост не найден!");
      }

      // Если контракт не готов
      if (!usdtContract) {
        return bot.sendMessage(chatId, "⚠️ Контракт не инициализирован. Свяжитесь с админом.");
      }

      const { amount, chat_id: groupChatId } = postRes.rows[0];
      const neededUSDT = parseFloat(amount.toString()) / (10 ** decimals);

      // Проверяем состояние пользователя
      if (userCheck.rowCount > 0 && userCheck.rows[0].state === userStates.WAITING_PAYMENT) {
        return bot.sendMessage(chatId, "⚠️ У вас уже есть неоплаченная услуга.");
      }

      // Берём свободный адрес из пула
      const tempAddress = await getFreeAddress();
      if (!tempAddress) {
        return bot.sendMessage(chatId, "⚠️ Нет свободных адресов, попробуйте позже.");
      }

      // Создаём запись услуги
      const deadline = new Date(Date.now() + 60 * 60 * 1000); // 1 час
      let initBal = "0";
      try {
        // Вызываем balanceOf, если всё ок
        const rawBal = await usdtContract.balanceOf(tempAddress);
        initBal = rawBal.toString();
      } catch (e) {
        console.error("Не удалось вызвать balanceOf:", e.message);
        return bot.sendMessage(chatId, "⚠️ Ошибка контракта (balanceOf). Свяжитесь с админом.");
      }

      await pool.query(
        `INSERT INTO public.services
         (service_name, amount, temp_address, initial_balance, payment_deadline, user_id, group_chat_id, post_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          "Premium Access",
          amount,            // в базе храним как BigInt (строка)
          tempAddress,
          initBal,
          deadline,
          msg.from.id,
          groupChatId,
          postId
        ]
      );
      // переводим пользователя в состояние "ожидание оплаты"
      await pool.query(
        "UPDATE public.users SET state = $1 WHERE user_id = $2",
        [userStates.WAITING_PAYMENT, msg.from.id]
      );

      // Уведомление в личку
      bot.sendMessage(
        chatId,
        `🛠️ Услуга: Premium Access\n💰 Сумма: ${neededUSDT} USDT\n🔗 Адрес: ${tempAddress}\n⏰ Оплатите в течение 1 часа`
      );

      // Старт мониторинга
      monitorAddressPayment(msg.from.id, chatId, tempAddress, neededUSDT, deadline);
    } else {
      // Просто /start
      bot.sendMessage(chatId, `Привет! Ваш user_unique_id: ${userUniqueId}`);
    }
  } catch (err) {
    console.error("Ошибка в /start:", err.message);
    bot.sendMessage(chatId, "❌ Ошибка");
  }
});

// --------------------------------------------------------
// 3. Inline-кнопка "Отмена оплаты"
// --------------------------------------------------------
bot.on("callback_query", async (query) => {
  const userId = query.from.id;
  const data = query.data;
  const fromChatId = query.message.chat.id;

  try {
    if (data.startsWith("cancel_payment_")) {
      const tempAddress = data.split("_")[2];
      const findService = await pool.query(
        `SELECT id FROM public.services
         WHERE temp_address = $1 AND user_id = $2 AND is_paid = false AND is_expired = false`,
        [tempAddress, userId]
      );
      if (findService.rowCount === 0) {
        await bot.sendMessage(fromChatId, "❌ Услуга не найдена или уже оплачена.");
        return bot.answerCallbackQuery(query.id);
      }

      const srvId = findService.rows[0].id;
      await pool.query("UPDATE public.services SET is_expired = true WHERE id = $1", [srvId]);
      await pool.query("UPDATE public.users SET state = $1 WHERE user_id = $2", [userStates.IDLE, userId]);
      await releaseAddress(tempAddress);
      await bot.sendMessage(fromChatId, `Оплата отменена, адрес освобождён: ${tempAddress}`);
      return bot.answerCallbackQuery(query.id);
    }

    bot.answerCallbackQuery(query.id, { text: "Неизвестная кнопка." });
  } catch (err) {
    console.error("Ошибка callback_query:", err.message);
    bot.answerCallbackQuery(query.id);
  }
});

// --------------------------------------------------------
// 4. Функция мониторинга адреса (каждые 30с, сообщает в ЛС)
// --------------------------------------------------------
function monitorAddressPayment(userId, privateChatId, tempAddress, expectedAmount, deadline) {
  if (!usdtContract) {
    bot.sendMessage(privateChatId, "⚠️ Контракт не инициализирован, мониторинг невозможен.");
    return;
  }
  const expectedBN = BigInt(Math.floor(expectedAmount * 10 ** decimals));

  const timer = setInterval(async () => {
    try {
      if (new Date() > deadline) {
        clearInterval(timer);
        // Помечаем услугу как просроченную
        await pool.query("UPDATE public.users SET state = $1 WHERE user_id = $2", [userStates.IDLE, userId]);
        await pool.query(
          `UPDATE public.services SET is_expired = true
           WHERE temp_address = $1 AND user_id = $2 AND is_paid = false AND is_expired = false`,
          [tempAddress, userId]
        );
        await releaseAddress(tempAddress);

        bot.sendMessage(privateChatId, `⏰ Время для оплаты истекло. Адрес ${tempAddress} освобождён.`);
        return;
      }

      // Ищем услугу
      const srv = await pool.query(
        `SELECT initial_balance
         FROM public.services
         WHERE temp_address = $1
           AND user_id = $2
           AND is_paid = false
           AND is_expired = false
         LIMIT 1`,
        [tempAddress, userId]
      );
      if (srv.rowCount === 0) {
        clearInterval(timer);
        return;
      }

      const initBalBN = BigInt(srv.rows[0].initial_balance.split(".")[0] || "0");

      // Вызываем balanceOf
      let currentRaw = BigInt(0);
      try {
        const bal = await usdtContract.balanceOf(tempAddress);
        currentRaw = BigInt(bal.toString());
      } catch (err) {
        console.error("Ошибка balanceOf:", err.message);
        // Если временная ошибка сети — повторим на следующем интервале
        return;
      }

      const delta = currentRaw - initBalBN;
      if (delta >= expectedBN) {
        clearInterval(timer);
        // Ставим флаг оплачено
        await pool.query(
          `UPDATE public.services
           SET is_paid = true, paid_at = NOW()
           WHERE temp_address = $1 AND user_id = $2`,
          [tempAddress, userId]
        );
        await pool.query("UPDATE public.users SET state = $1 WHERE user_id = $2", [userStates.IDLE, userId]);
        await releaseAddress(tempAddress);

        bot.sendMessage(
          privateChatId,
          `✅ Оплата получена!\nАдрес: ${tempAddress}\nСкрытый контент: https://example.com/secret`
        );
      }
    } catch (err) {
      console.error("Ошибка monitorAddressPayment:", err.message);
    }
  }, 30000);
}

// --------------------------------------------------------
// 5. Глобальный мониторинг всех услуг (каждые 30с)
// --------------------------------------------------------
const monitorAllServices = async () => {
  if (!usdtContract) return; // Если контракт не готов
  try {
    const res = await pool.query(
      `SELECT temp_address, payment_deadline, amount, user_id
       FROM public.services
       WHERE is_paid = false AND is_expired = false`
    );
    for (const row of res.rows) {
      const user = row.user_id;
      const addr = row.temp_address;
      const bigStr = row.amount.toString();
      const needed = parseFloat(bigStr) / (10 ** decimals);
      const dd = row.payment_deadline;

      if (new Date(dd) < new Date()) {
        // Просрочено
        await pool.query("UPDATE public.services SET is_expired = true WHERE temp_address = $1", [addr]);
        await releaseAddress(addr);
      } else {
        monitorAddressPayment(user, user, addr, needed, dd);
      }
    }
  } catch (err) {
    console.error("Ошибка monitorAllServices:", err.message);
  }
};
setInterval(monitorAllServices, 30000);

// --------------------------------------------------------
// 6. Восстановление мониторинга при старте
// --------------------------------------------------------
(async () => {
  if (!usdtContract) return;
  try {
    const pending = await pool.query(
      `SELECT temp_address, payment_deadline, amount, user_id
       FROM public.services
       WHERE is_paid = false AND is_expired = false`
    );
    for (const row of pending.rows) {
      const user = row.user_id;
      const addr = row.temp_address;
      const bigStr = row.amount.toString();
      const needed = parseFloat(bigStr) / (10 ** decimals);
      const dd = row.payment_deadline;

      if (new Date(dd) < new Date()) {
        await pool.query("UPDATE public.services SET is_expired = true WHERE temp_address = $1", [addr]);
        await releaseAddress(addr);
      } else {
        monitorAddressPayment(user, user, addr, needed, dd);
      }
    }
  } catch (err) {
    console.error("Ошибка при восстановлении:", err.message);
  }
})();

// --------------------------------------------------------
// Запуск Express-сервера
// --------------------------------------------------------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}. Сеть: ${chainName}`);
});

// Аккуратное завершение
function gracefulShutdown() {
  console.log("Остановка приложения...");
  pool.end(() => {
    console.log("PostgreSQL отключён");
    process.exit(0);
  });
}
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
