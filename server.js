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
    // Сбрасываем активные адреса
    await client.query("UPDATE public.address_pool SET is_active = false WHERE is_active = true");
    client.release();
  })
  .catch((err) => {
    console.error("Ошибка подключения к БД:", err);
    process.exit(1);
  });

// Пул адресов
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

// Инициализация Telegram бота
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN не задана!");
  process.exit(1);
}
const bot = new TelegramBot(token, { polling: true });

let botUsername = "";
bot.getMe().then((info) => {
  botUsername = info.username;
  console.log(`Бот @${botUsername} запущен`);
});

// Выбираем окружение (dev => sepolia, prod => BSC)
const ENV = process.env.NODE_ENV || "dev"; // dev|prod
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

if (!rpcUrl || !usdtAddress || rpcUrl.length < 10 || usdtAddress.length < 10) {
  console.error("RPC или контрактный адрес не заданы!");
}

let provider;
try {
  provider = new ethers.JsonRpcProvider(rpcUrl);
} catch (err) {
  console.error("Ошибка создания провайдера:", err.message);
}

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
    console.log("Внимание: контракт не инициализирован!");
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

// --------------------- Создание поста /setPrice <число> ---------------------
bot.on("message", async (msg) => {
  if (!msg.text) return;
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") return;
  if (msg.from.id.toString() !== process.env.ADMIN_ID) return;

  const regex = /\/setPrice\s+(\d+(\.\d+)?)/;
  const found = msg.text.match(regex);
  if (!found) return;

  const amountFloat = parseFloat(found[1]);
  const description = msg.text.replace(regex, "").trim();

  try {
    const bigAmount = BigInt(Math.floor(amountFloat * 10 ** decimals)).toString();
    const insertPost = await pool.query(
      `INSERT INTO public.posts (message_id, amount, description, chat_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [0, bigAmount, description, msg.chat.id]
    );
    const postId = insertPost.rows[0].id;

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

    await pool.query(
      "UPDATE public.posts SET message_id = $1 WHERE id = $2",
      [postMsg.message_id, postId]
    );

    bot.sendMessage(msg.chat.id, `✅ Пост создан. ID: ${postId}, message_id: ${postMsg.message_id}`);
  } catch (err) {
    console.error("Ошибка создания поста:", err.message);
  }
});

// --------------------- /start buy_subscription_<postId> ---------------------
bot.onText(/\/start(?:@[^ ]+)?(?: (.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const args = match[1] ? match[1].split("_") : [];
  const isPrivate = (msg.chat.type === "private");

  if (!isPrivate) {
    if (args.length === 3 && args[0] === "buy" && args[1] === "subscription") {
      const postId = parseInt(args[2], 10);
      const link = `https://t.me/${botUsername}?start=buy_subscription_${postId}`;
      return bot.sendMessage(chatId, `Перейдите в личный чат: [ссылка](${link})`, { parse_mode: "Markdown" });
    }
    return;
  }

  try {
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

    if (args.length === 3 && args[0] === "buy" && args[1] === "subscription") {
      if (!usdtContract) {
        return bot.sendMessage(chatId, "⚠️ Контракт не инициализирован. Свяжитесь с админом.");
      }

      const postId = parseInt(args[2], 10);
      const postRes = await pool.query(
        "SELECT id, amount, chat_id FROM public.posts WHERE id = $1",
        [postId]
      );
      if (postRes.rowCount === 0) {
        return bot.sendMessage(chatId, "❌ Пост не найден.");
      }

      if (userCheck.rows[0].state === userStates.WAITING_PAYMENT) {
        return bot.sendMessage(chatId, "⚠️ У вас уже есть неоплаченная услуга.");
      }

      const { amount, chat_id: groupChatId } = postRes.rows[0];
      const baseUnits = amount.toString();
      const neededUSDT = parseFloat(baseUnits) / (10 ** decimals);

      const tempAddress = await getFreeAddress();
      if (!tempAddress) {
        return bot.sendMessage(chatId, "⚠️ Нет свободных адресов, повторите позже.");
      }

      // Вызываем balanceOf
      let initBal = "0";
      try {
        const initBalRaw = await usdtContract.balanceOf(tempAddress);
        initBal = initBalRaw.toString();
      } catch (e) {
        console.error("Не удалось вызвать balanceOf:", e.message);
        return bot.sendMessage(chatId, "⚠️ Ошибка контракта (balanceOf). Свяжитесь с админом.");
      }

      const deadline = new Date(Date.now() + 60 * 60 * 1000); // 1 час
      await pool.query(
        `INSERT INTO public.services
         (service_name, amount, temp_address, initial_balance, payment_deadline, user_id, group_chat_id, post_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          "Premium Access",
          baseUnits,
          tempAddress,
          initBal,
          deadline,
          msg.from.id,
          groupChatId,
          postId
        ]
      );
      await pool.query(
        "UPDATE public.users SET state = $1 WHERE user_id = $2",
        [userStates.WAITING_PAYMENT, msg.from.id]
      );

      bot.sendMessage(
        chatId,
        `🛠️ Услуга: Premium Access\n💰 Сумма: ${neededUSDT} USDT\n🔗 Адрес: ${tempAddress}\n⏰ Оплата в течение 1 часа`
      );
      monitorAddressPayment(msg.from.id, chatId, tempAddress, neededUSDT, deadline);
    } else {
      bot.sendMessage(chatId, `Добро пожаловать! Ваш ID: ${userUniqueId}`);
    }
  } catch (err) {
    console.error("Ошибка в /start:", err.message);
    bot.sendMessage(chatId, "❌ Ошибка");
  }
});

// --------------------- Отмена оплаты ---------------------
bot.on("callback_query", async (query) => {
  const userId = query.from.id;
  const data = query.data;
  const fromChatId = query.message.chat.id;

  try {
    if (data.startsWith("cancel_payment_")) {
      const tempAddress = data.split("_")[2];
      const s = await pool.query(
        `SELECT id FROM public.services
         WHERE temp_address = $1 AND user_id = $2 AND is_paid = false AND is_expired = false`,
        [tempAddress, userId]
      );
      if (s.rowCount === 0) {
        bot.sendMessage(fromChatId, "❌ Услуга не найдена или уже оплачена.");
        return bot.answerCallbackQuery(query.id);
      }
      const srvId = s.rows[0].id;
      await pool.query("UPDATE public.services SET is_expired = true WHERE id = $1", [srvId]);
      await pool.query("UPDATE public.users SET state = $1 WHERE user_id = $2", [userStates.IDLE, userId]);
      await releaseAddress(tempAddress);
      bot.sendMessage(fromChatId, `Оплата отменена, адрес освобождён: ${tempAddress}`);
      return bot.answerCallbackQuery(query.id);
    }

    bot.answerCallbackQuery(query.id, { text: "Неизвестная кнопка." });
  } catch (err) {
    console.error("Ошибка callback_query:", err.message);
    bot.answerCallbackQuery(query.id);
  }
});

// --------------------- Мониторинг одного адреса ---------------------
function monitorAddressPayment(userId, privateChatId, tempAddress, expectedAmount, deadline) {
  if (!usdtContract) {
    bot.sendMessage(privateChatId, "⚠️ Контракт не инициализирован, мониторинг невозможен.");
    return;
  }

  const expectedBN = BigInt(Math.floor(expectedAmount * 10 ** decimals));
  const intervalMs = 120_000; // проверяем каждые 2 минуты, чтобы не спамить

  const timer = setInterval(async () => {
    try {
      if (new Date() > deadline) {
        clearInterval(timer);
        await pool.query("UPDATE public.users SET state = $1 WHERE user_id = $2", [userStates.IDLE, userId]);
        await pool.query(
          `UPDATE public.services SET is_expired = true
           WHERE temp_address = $1 AND user_id = $2 AND is_paid = false AND is_expired = false`,
          [tempAddress, userId]
        );
        await releaseAddress(tempAddress);
        bot.sendMessage(privateChatId, `⏰ Время оплаты истекло. Адрес ${tempAddress} освобождён.`);
        return;
      }

      const sr = await pool.query(
        `SELECT initial_balance
         FROM public.services
         WHERE temp_address = $1 AND user_id = $2 AND is_paid = false AND is_expired = false
         LIMIT 1`,
        [tempAddress, userId]
      );
      if (sr.rowCount === 0) {
        clearInterval(timer);
        return;
      }

      const initBalBN = BigInt(sr.rows[0].initial_balance.split(".")[0] || "0");
      let currentBN = BigInt(0);
      try {
        const bal = await usdtContract.balanceOf(tempAddress);
        currentBN = BigInt(bal.toString());
      } catch (err) {
        // если 429 Too Many Requests или другое
        console.error("Ошибка balanceOf:", err.message);
        return; // пропускаем, в следующем цикле попробуем снова
      }

      const delta = currentBN - initBalBN;
      if (delta >= expectedBN) {
        clearInterval(timer);
        await pool.query(
          `UPDATE public.services SET is_paid = true, paid_at = NOW()
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
  }, intervalMs);
}

// --------------------- Глобальный мониторинг (каждые 2 мин) ---------------------
const monitorAllServices = async () => {
  if (!usdtContract) return;
  try {
    const res = await pool.query(
      `SELECT temp_address, payment_deadline, amount, user_id
       FROM public.services
       WHERE is_paid = false AND is_expired = false`
    );
    for (const row of res.rows) {
      const user = row.user_id;
      const baseUnits = BigInt(row.amount.toString());
      const needed = parseFloat(baseUnits.toString()) / (10 ** decimals);
      const dd = row.payment_deadline;
      const addr = row.temp_address;

      if (new Date(dd) < new Date()) {
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
setInterval(monitorAllServices, 120_000);

// --------------------- Восстановление мониторинга при старте ---------------------
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
      const baseUnits = BigInt(row.amount.toString());
      const needed = parseFloat(baseUnits.toString()) / (10 ** decimals);
      const dd = row.payment_deadline;
      const addr = row.temp_address;

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

// --------------------- Запуск Express ---------------------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}. Сеть: ${chainName}`);
});

// Завершение
function gracefulShutdown() {
  console.log("Остановка приложения...");
  pool.end(() => {
    console.log("PostgreSQL отключён");
    process.exit(0);
  });
}
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
