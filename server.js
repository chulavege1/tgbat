const { ethers } = require("ethers");
const { Pool } = require("pg");
const TelegramBot = require("node-telegram-bot-api");
require("dotenv").config();
const express = require("express");
const app = express();
app.use(express.json());
const cors = require('cors');
app.use(cors());


// Подключение к PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.ENV === "prod" ? { rejectUnauthorized: false } : false,
});

pool.connect()
  .then(() => console.log("Connected to PostgreSQL"))
  .catch((err) => {
    console.error("Failed to connect to PostgreSQL:", err.message);
    process.exit(1);
  });

// REST API для обновления и просмотра данных
app.post("/update-state", async (req, res) => {
  const { chatId, newState, username, fullname } = req.body;
  try {
    await pool.query(
      "UPDATE public.users SET state = $1, username = $2, fullname = $3 WHERE chat_id = $4",
      [newState, username, fullname, chatId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Error updating state:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});


app.get('/users', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT chat_id, user_id, state, username, fullname, subscription_until, last_interaction 
      FROM public.users
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching users:', err.message);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.delete("/delete-user/:chatId", async (req, res) => {
  const { chatId } = req.params;
  try {
    await pool.query("DELETE FROM public.users WHERE chat_id = $1", [chatId]);
    res.json({ success: true, message: "User deleted successfully." });
  } catch (err) {
    console.error("Error deleting user:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});



// Определение окружения
const ENV = process.env.NODE_ENV || "dev";
const CONFIG = {
  prod: {
    rpcUrl: process.env.BSC_RPC_URL,
    usdtAddress: process.env.BUSD_CONTRACT_ADDRESS,
    walletAddress: process.env.BSC_WALLET_ADDRESS,
    chainName: "BSC Mainnet",
    decimals: 18,
  },
  dev: {
    rpcUrl: process.env.SEPOLIA_RPC_URL,
    usdtAddress: process.env.SEPOLIA_USDT_CONTRACT_ADDRESS,
    walletAddress: process.env.SEPOLIA_WALLET_ADDRESS,
    chainName: "Sepolia Testnet",
    decimals: 6,
  },
};

const { rpcUrl, usdtAddress, walletAddress, chainName, decimals } = CONFIG[ENV];
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });
const provider = new ethers.JsonRpcProvider(rpcUrl);

// ABI контракта ERC20
const erc20ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// Инициализация контракта USDT
const usdtContract = new ethers.Contract(usdtAddress, erc20ABI, provider);

// Состояния пользователей
const userStates = { WAITING_PAYMENT: "WAITING_PAYMENT", IDLE: "IDLE" };
const generateUserId = () =>
  `DHEI-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;

// Приветственное сообщение
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const username = msg.from.username || null;
  const fullname = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim();

  try {
    const result = await pool.query("SELECT * FROM public.users WHERE chat_id = $1", [chatId]);
    let userId;
    if (result.rowCount === 0) {
      userId = generateUserId();
      await pool.query(
        "INSERT INTO public.users (chat_id, user_id, state, username, fullname, last_interaction) VALUES ($1, $2, $3, $4, $5, NOW())",
        [chatId, userId, userStates.IDLE, username, fullname]
      );
    } else {
      userId = result.rows[0].user_id;
      // Обновление последнего взаимодействия
      await pool.query(
        "UPDATE public.users SET last_interaction = NOW(), username = $1, fullname = $2 WHERE chat_id = $3",
        [username, fullname, chatId]
      );
    }

    bot.sendMessage(
      chatId,
      `Добро пожаловать! 🎉\nВаш ID: ${userId}\n\nВыберите действие:`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Получить доступ", callback_data: "access" }],
            [{ text: "Администрация", callback_data: "admin" }],
          ],
        },
      }
    );
  } catch (err) {
    console.error("Error accessing database:", err.message);
    bot.sendMessage(chatId, "❌ Ошибка доступа к базе данных.");
  }
});

// Обработка inline кнопок
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;

  try {
    const result = await pool.query("SELECT state, user_id FROM public.users WHERE chat_id = $1", [chatId]);
    if (query.data === "access") {
      if (result.rowCount && result.rows[0].state === userStates.WAITING_PAYMENT) {
        bot.sendMessage(chatId, "Вы уже ожидаете оплату. Завершите текущий процесс перед началом нового.");
        return bot.answerCallbackQuery(query.id);
      }

      const amount = "1"; // Сумма в USDT
      bot.sendMessage(
        chatId,
        `Отправьте ровно ${amount} USDT на адрес:\n${walletAddress}\nОплата будет обработана автоматически.`
      );

      await pool.query("UPDATE public.users SET state = $1 WHERE chat_id = $2", [userStates.WAITING_PAYMENT, chatId]);
      monitorUSDT(chatId, result.rows[0]?.user_id || generateUserId(), amount);
    } else if (query.data === "admin") {
      bot.sendMessage(chatId, `Admin Telegram ID: ${process.env.ADMIN_ID || "не задан"}`);
    }
  } catch (err) {
    console.error("Error handling callback:", err.message);
    bot.sendMessage(chatId, "❌ Ошибка обработки запроса.");
  }

  bot.answerCallbackQuery(query.id);
});

// Функция для мониторинга USDT
const monitorUSDT = async (chatId, userId, expectedAmount) => {
  console.log(
    `Monitoring payments to ${walletAddress} for USDT on ${chainName}, User ID: ${userId}`
  );

  try {
    const initialBalanceRaw = await usdtContract.balanceOf(walletAddress);
    const initialBalance = BigInt(initialBalanceRaw.toString());
    console.log(
      `Initial balance: ${initialBalance} (${ethers.formatUnits(
        initialBalance,
        decimals
      )} USDT)`
    );

    provider.on("block", async (blockNumber) => {
      console.log(`New block: ${blockNumber}`);

      try {
        const currentBalanceRaw = await usdtContract.balanceOf(walletAddress);
        const currentBalance = BigInt(currentBalanceRaw.toString());
        const receivedAmount = currentBalance - initialBalance;

        console.log(
          `Current balance: ${currentBalance} (${ethers.formatUnits(
            currentBalance,
            decimals
          )} USDT)`
        );
        console.log(
          `Received amount: ${receivedAmount} (${ethers.formatUnits(
            receivedAmount,
            decimals
          )} USDT)`
        );

        if (
          receivedAmount >= BigInt(ethers.parseUnits(expectedAmount, decimals).toString())
        ) {
          console.log(
            `Payment of ${ethers.formatUnits(
              receivedAmount,
              decimals
            )} USDT received for User ID: ${userId}`
          );
          bot.sendMessage(
            chatId,
            `✅ Оплата успешно зачислена!\nСумма: ${ethers.formatUnits(
              receivedAmount,
              decimals
            )} USDT\nВаш ID: ${userId}\nСеть: ${chainName}\nАдрес: ${walletAddress}`
          );

          provider.off("block");
          await pool.query("UPDATE public.users SET state = $1 WHERE chat_id = $2", [userStates.IDLE, chatId]);
        } else {
          console.log(`Waiting for the expected amount: ${expectedAmount} USDT`);
        }
      } catch (error) {
        console.error("Error during balance check:", error.message);
        bot.sendMessage(chatId, `❌ Ошибка при проверке баланса: ${error.message}`);
      }
    });
  } catch (error) {
    console.error("Error monitoring payment:", error.message);
    bot.sendMessage(chatId, `❌ Ошибка при мониторинге платежа: ${error.message}`);
  }
};

// Восстановление мониторинга при старте
const restorePendingPayments = async () => {
  try {
    const result = await pool.query("SELECT chat_id, user_id FROM public.users WHERE state = $1", [userStates.WAITING_PAYMENT]);
    result.rows.forEach(row => {
      monitorUSDT(row.chat_id, row.user_id, "1");
    });
    console.log("Restored pending payments.");
  } catch (err) {
    console.error("Error restoring pending payments:", err.message);
  }
};

// Запуск бота и API
restorePendingPayments();
console.log(`Bot is running on ${chainName}...`);
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
