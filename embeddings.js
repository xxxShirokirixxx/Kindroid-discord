// embeddings.js — patched with robust error handling and spam suppression
const fs = require("fs");
const cosine = require("cosine-similarity");
let OpenAI = null;
let client = null;

// If true, only log the first OpenAI embedding failure (avoid log spam)
let embeddingFailedOnce = false;

// Allow disabling OpenAI embeddings via env var: EMBEDDINGS_ENABLED='false'
const EMBEDDINGS_ENABLED = process.env.EMBEDDINGS_ENABLED !== "false";

// Initialize OpenAI client if available
if (process.env.OPENAI_API_KEY && EMBEDDINGS_ENABLED) {
  try {
    OpenAI = require("openai");
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    console.log("✅ Using OpenAI embeddings (text-embedding-3-small)");
  } catch (e) {
    console.warn("⚠️ Failed to init OpenAI client, falling back to local:", e.message);
    client = null;
  }
} else {
  if (!process.env.OPENAI_API_KEY) {
    console.warn("⚠️ No OPENAI_API_KEY set — using local embeddings only.");
  } else {
    console.log("ℹ️ EMBEDDINGS_ENABLED=false — using local embeddings only.");
  }
  client = null;
}

// --- Local fallback embedding (bag-of-words vector) ---
function localEmbed(text) {
  const words = (text || "").toLowerCase().split(/\W+/).filter(Boolean);
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  return freq;
}

function cosineLocal(vecA, vecB) {
  const keys = new Set([...Object.keys(vecA), ...Object.keys(vecB)]);
  let dot = 0, normA = 0, normB = 0;
  for (const k of keys) {
    const a = vecA[k] || 0;
    const b = vecB[k] || 0;
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

// --- Chunk text into ~200-word pieces ---
function chunkText(str, size = 200) {
  if (!str) return [];
  const words = str.split(/\s+/);
  const chunks = [];
  let current = [];
  let len = 0;

  for (const w of words) {
    if (len + w.length > size && current.length) {
      chunks.push(current.join(" "));
      current = [];
      len = 0;
    }
    current.push(w);
    len += w.length + 1;
  }
  if (current.length) chunks.push(current.join(" "));
  return chunks;
}

// --- Embed text with OpenAI (once), fallback to local ---
async function embedText(text) {
  if (!text || !String(text).trim()) return localEmbed("");

  if (client) {
    try {
      const res = await client.embeddings.create({
        model: "text-embedding-3-small",
        input: text
      });
      const emb = res?.data?.[0]?.embedding;
      if (Array.isArray(emb) && emb.length) return emb;

      if (!embeddingFailedOnce) {
        console.warn("⚠️ OpenAI returned empty embedding, falling back to local.");
        embeddingFailedOnce = true;
      }
      client = null;
    } catch (e) {
      if (!embeddingFailedOnce) {
        console.warn("⚠️ Embedding API failed, disabling OpenAI embeddings:", e.message || e);
        embeddingFailedOnce = true;
      } else {
        if (process.env.DEBUG) console.debug("Embedding API still failing:", e.message || e);
      }
      client = null; // disable to avoid repeated calls
    }
  }

  return localEmbed(text);
}

// --- Build vector store from files ---
async function buildVectorStore(files, outFile = "vector_store.json") {
  const MAX_TOTAL_CHUNKS = 1000;
  const store = [];

  for (const [label, file] of Object.entries(files)) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    const chunks = chunkText(text);

    for (const chunk of chunks) {
      if (store.length >= MAX_TOTAL_CHUNKS) break;
      try {
        const embedding = await embedText(chunk);
        store.push({ label, chunk, embedding });
      } catch (err) {
        console.warn("⚠️ embedText error, skipping chunk:", err.message || err);
      }
    }
  }

  try {
    fs.writeFileSync(outFile, JSON.stringify(store, null, 2));
  } catch (e) {
    console.warn("⚠️ Failed writing vector store:", e.message || e);
  }

  return store;
}

// --- Search vector store (handles mixed OpenAI/local embeddings) ---
async function searchVectorStore(query, store, topK = 5) {
  if (!query || !String(query).trim()) return [];

  const qEmbed = await embedText(query);
  if (!qEmbed) return [];

  const qIsArray = Array.isArray(qEmbed);
  const qIsLocal = typeof qEmbed === "object" && !Array.isArray(qEmbed);

  const scored = store.map(item => {
    try {
      const itemEmb = item.embedding;
      const itemIsArray = Array.isArray(itemEmb);
      const itemIsLocal = typeof itemEmb === "object" && !Array.isArray(itemEmb);

      let score;
      if (qIsArray && itemIsArray) {
        score = cosine(qEmbed, itemEmb);
      } else {
        const qLocal = qIsLocal ? qEmbed : localEmbed(query);
        const itemLocal = itemIsLocal ? itemEmb : localEmbed(item.chunk || "");
        score = cosineLocal(qLocal, itemLocal);
      }

      return { ...item, score };
    } catch (e) {
      if (process.env.DEBUG) console.debug("Error scoring item:", e);
      return { ...item, score: -Infinity };
    }
  });

  return scored
    .filter(i => Number.isFinite(i.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

module.exports = { buildVectorStore, searchVectorStore, embedText, localEmbed };



