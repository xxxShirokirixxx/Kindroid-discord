import dotenv from "dotenv";
import { Client, GatewayIntentBits, Events } from "discord.js";
import fetch from "node-fetch";

dotenv.config();

/**
 * Bot configuration type
 */
interface BotConfig {
  id: string;
  discordBotToken: string;
  sharedAiCode: string;
  enableFilter: boolean;
}

/**
 * Load bot configurations from environment variables
 * Looks for pairs of SHARED_AI_CODE_N and BOT_TOKEN_N where N starts from 1
 * @returns Array of bot configurations
 */
function loadBotConfigs(): BotConfig[] {
  const configs: BotConfig[] = [];
  let currentIndex = 1;
  let hasMoreConfigs = true;
  while (hasMoreConfigs) {
    const sharedAiCode = process.env[`SHARED_AI_CODE_${currentIndex}`];
    const botToken = process.env[`BOT_TOKEN_${currentIndex}`];
    // If either required value is missing, we've reached the end of our configs
    if (!sharedAiCode || !botToken) {
      hasMoreConfigs = false;
      break;
    }
    // Get optional settings
    const enableFilter =
      process.env[`ENABLE_FILTER_${currentIndex}`]?.toLowerCase() === "true";
    configs.push({
      id: `bot${currentIndex}`,
      discordBotToken: botToken,
      sharedAiCode,
      enableFilter,
    });
    currentIndex++;
  }
  return configs;
}

/**
 * Validate environment variables
 * @throws Error if required variables are missing
 */
function validateEnv(): void {
  const requiredVars = [
    "KINDROID_INFER_URL",
    "KINDROID_API_KEY",
    "SHARED_AI_CODE_1", // At least one bot is required
    "BOT_TOKEN_1",
    "GEMINI_API_KEY", // Added for fallback
  ] as const;
  const missing = requiredVars.filter((varName) => !process.env[varName]);
  if (missing.length > 0) {
    console.error(
      "Missing required environment variables:",
      missing.join(", ")
    );
    process.exit(1);
  }
  // Validate bot config pairs
  let currentIndex = 1;
  let hasMoreConfigs = true;
  while (hasMoreConfigs) {
    const hasSharedAiCode = !!process.env[`SHARED_AI_CODE_${currentIndex}`];
    const hasBotToken = !!process.env[`BOT_TOKEN_${currentIndex}`];
    // If neither exists, we're done checking
    if (!hasSharedAiCode && !hasBotToken) {
      hasMoreConfigs = false;
      break;
    }
    // If one exists without the other, that's an error
    if (hasSharedAiCode !== hasBotToken) {
      console.error(
        `Error: Bot ${currentIndex} must have both SHARED_AI_CODE_${currentIndex} and BOT_TOKEN_${currentIndex} defined`
      );
      process.exit(1);
    }
    currentIndex++;
  }
}

/**
 * Initialize a single bot
 * @param config Bot configuration
 * @returns The initialized Discord client
 */
function initializeBot(config: BotConfig): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on(Events.ClientReady, () => {
    console.log(`Bot [${config.id}] logged in as ${client.user?.tag}`);
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.mentions.has(client.user!)) return;

    const userInput = message.content.replace(new RegExp(`<@!?${client.user!.id}>`, 'g'), '').trim();
    let replyText: string | null = null;

    try {
      // Kindroid API call
      const response = await fetch(process.env.KINDROID_INFER_URL!, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.KINDROID_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          shared_ai_code: config.sharedAiCode,
          message: userInput,
          enable_filter: config.enableFilter
        })
      });

      if (!response.ok) {
        throw new Error(`Kindroid error: ${response.status} - ${await response.text()}`);
      }

      const data = await response.json();
      replyText = data.reply?.message?.content || data.reply;
    } catch (e) {
      console.error('Kindroid error for bot ' + config.id + ':', e);
      
      // Gemini fallback
      try {
        const prompt = `You are 2B from Nier: Automata. Keep replies short, witty, slightly melancholic. Respond to: ${userInput}`;
        const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.7, maxOutputTokens: 200 }
          })
        });

        if (!geminiResponse.ok) {
          throw new Error(`Gemini error: ${geminiResponse.status}`);
        }

        const data = await geminiResponse.json();
        replyText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
      } catch (fallbackError) {
        console.error('Gemini fallback error for bot ' + config.id + ':', fallbackError);
      }
    }

    if (replyText) {
      await message.reply(replyText);
    } else {
      await message.reply('Error occurred. Try again.');
    }
  });

  client.login(config.discordBotToken).catch((error) => {
    console.error(`Login failed for bot ${config.id}:`, error);
    throw error;
  });

  return client;
}

/**
 * Initialize all bots
 * @param configs Array of bot configurations
 * @returns Array of initialized clients
 */
async function initializeAllBots(configs: BotConfig[]): Promise<Client[]> {
  console.log(`Initializing ${configs.length} bots...`);

  const clients: Client[] = [];
  let successCount = 0;

  for (const config of configs) {
    try {
      const client = initializeBot(config);
      clients.push(client);
      successCount++;
    } catch (error) {
      console.error(`Failed to initialize bot ${config.id}:`, error);
    }
  }

  console.log(`Successfully initialized ${successCount} out of ${configs.length} bots`);

  return clients;
}

/**
 * Shutdown all bots gracefully
 * @param clients Array of Discord clients
 */
async function shutdownAllBots(clients: Client[]): Promise<void> {
  for (const client of clients) {
    await client.destroy();
  }
}

async function main(): Promise<void> {
  try {
    // Validate environment
    validateEnv();
    // Load bot configurations
    const botConfigs = loadBotConfigs();
    if (botConfigs.length === 0) {
      console.error(
        "No valid bot configurations found in environment variables"
      );
      process.exit(1);
    }
    console.log(`Found ${botConfigs.length} bot configurations`);
    // Initialize all bots
    const clients = await initializeAllBots(botConfigs);
    console.log("All bots initialized successfully!");
    // Handle graceful shutdown
    process.on("SIGINT", async () => {
      console.log("\nReceived SIGINT. Shutting down...");
      await shutdownAllBots(clients);
      process.exit(0);
    });
    process.on("SIGTERM", async () => {
      console.log("\nReceived SIGTERM. Shutting down...");
      await shutdownAllBots(clients);
      process.exit(0);
    });
  } catch (error) {
    console.error("Fatal error during initialization:", error);
    process.exit(1);
  }
}

// Start the application
main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
