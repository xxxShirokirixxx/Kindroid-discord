// embeddings.js — fully hardened, async-safe, type-safe

const fs = require('fs');
const cosine = require('cosine-similarity');

let OpenAI = null;
let client = null;
let embeddingFailedOnce = false;

const EMBEDDINGS_ENABLED = process.env.EMBEDDINGS_ENABLED !== 'false';

// ---------- OPENAI INIT ----------
if (process.env.OPENAI_API_KEY && EMBEDDINGS_ENABLED) {
  try {
    OpenAI = require('openai');
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    console.log('✅ Using OpenAI embeddings (text-embedding-3-small)');
  } catch (e) {
    console.warn('⚠️ OpenAI init failed, using local embeddings:', e.message);
    client = null;
  }
} else {
  console.warn('⚠️ No OPENAI_API_KEY set — using local embeddings only.');
}

// ---------- LOCAL EMBEDDING ----------
function localEmbed(text) {
  const safe =
    typeof text === 'string'
      ? text
      : JSON.stringify(text ?? '');

  const words = safe.toLowerCase().split(/\W+/).filter(Boolean);
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  return freq;
}

function cosineLocal(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0, na = 0, nb = 0;
  for (const k of keys) {
    const x = a[k] || 0;
    const y = b[k] || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ---------- CHUNK TEXT ----------
function chunkText(text, size = 200) {
  if (!text) return [];
  const words = String(text).split(/\s+/);
  const chunks = [];
  let buf = [];
  let len = 0;

  for (const w of words) {
    if (len + w.length > size && buf.length) {
      chunks.push(buf.join(''));
      buf = [];
      len = 0;
    }
    buf.push(w + ' ');
    len += w.length;
  }

  if (buf.length) chunks.push(buf.join('').trim());
  return chunks;
}

// ---------- EMBED ----------
async function embedText(text) {
  const safe =
    typeof text === 'string'
      ? text
      : JSON.stringify(text ?? '');

  if (!safe.trim()) return localEmbed('');

  if (client) {
    try {
      const res = await client.embeddings.create({
        model: 'text-embedding-3-small',
        input: safe,
      });

      const emb = res?.data?.[0]?.embedding;
      if (Array.isArray(emb)) return emb;

      throw new Error('Empty embedding');
    } catch (e) {
      if (!embeddingFailedOnce) {
        console.warn('⚠️ Embeddings failed, disabling OpenAI:', e.message);
        embeddingFailedOnce = true;
      }
      client = null;
    }
  }

  return localEmbed(safe);
}

// ---------- BUILD STORE ----------
async function buildVectorStore(files) {
  const store = [];
  const MAX = 1000;

  for (const [label, file] of Object.entries(files)) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const chunks = chunkText(text);

    for (const chunk of chunks) {
      if (store.length >= MAX) break;
      const embedding = await embedText(chunk);
      store.push({ label, chunk, embedding });
    }
  }

  return store;
}

// ---------- SEARCH ----------
async function searchVectorStore(query, store, topK = 5) {
  const qEmbed = await embedText(query);

  const scored = store.map(item => {
    try {
      const a = qEmbed;
      const b = item.embedding;

      let score = 0;
      if (Array.isArray(a) && Array.isArray(b)) {
        score = cosine(a, b);
      } else {
        score = cosineLocal(
          typeof a === 'object' ? a : localEmbed(query),
          typeof b === 'object' ? b : localEmbed(item.chunk)
        );
      }

      return { ...item, score };
    } catch {
      return { ...item, score: -Infinity };
    }
  });

  return scored
    .filter(i => Number.isFinite(i.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

module.exports = {
  buildVectorStore,
  searchVectorStore,
  embedText,
  localEmbed,
};
