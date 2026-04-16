require("dotenv").config();

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const OpenAI = require("openai");
const { QdrantClient } = require("@qdrant/js-client-rest");

const app = express();
app.use(express.json());

// ================= CONFIG =================

const SECRET = "mysecret";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const qdrant = new QdrantClient({
  url: "http://localhost:6333",
});

const upload = multer({ dest: "uploads/" });

let users = [];

// ================= RECURSIVE CHUNKING =================

function recursiveChunk(text, chunkSize = 200, overlap = 20) {
  const separators = ["\n\n", "\n", ".", " "];

  function splitText(text, sepIndex) {
    if (text.length <= chunkSize) return [text];

    if (sepIndex >= separators.length) {
      let chunks = [];
      for (let i = 0; i < text.length; i += chunkSize - overlap) {
        chunks.push(text.slice(i, i + chunkSize));
      }
      return chunks;
    }

    const parts = text.split(separators[sepIndex]);
    let chunks = [];
    let current = "";

    for (let part of parts) {
      if ((current + part).length > chunkSize) {
        if (current) chunks.push(current);
        current = part;
      } else {
        current += separators[sepIndex] + part;
      }
    }

    if (current) chunks.push(current);

    return chunks.flatMap(chunk =>
      chunk.length > chunkSize
        ? splitText(chunk, sepIndex + 1)
        : [chunk]
    );
  }

  return splitText(text, 0);
}

// ================= AUTH =================

// Register
app.post("/register", async (req, res) => {
  const { username, password } = req.body;

  const hashedPassword = await bcrypt.hash(password, 10);
  users.push({ username, password: hashedPassword });

  res.send("User registered");
});

// Login
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  const user = users.find(u => u.username === username);
  if (!user) return res.send("User not found");

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.send("Wrong password");

  const token = jwt.sign({ username }, SECRET);
  res.json({ token });
});

// Middleware
function auth(req, res, next) {
  const token = req.headers["authorization"];

  if (!token) return res.send("Access denied");

  try {
    const data = jwt.verify(token, SECRET);
    req.user = data;
    next();
  } catch {
    res.send("Invalid token");
  }
}

// ================= INIT QDRANT =================

async function initQdrant() {
  try {
    await qdrant.createCollection("documents", {
      vectors: {
        size: 1536,
        distance: "Cosine",
      },
    });
    console.log("Qdrant collection created");
  } catch (err) {
    console.log("Collection already exists");
  }
}

initQdrant();

// ================= UPLOAD + INGEST =================

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;

    if (!file) {
      return res.send("No file uploaded");
    }

    const content = fs.readFileSync(file.path, "utf-8");

    // 🔹 Chunking
    const chunks = recursiveChunk(content, 200, 20);

    // 🔹 Store each chunk in Qdrant
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: chunk,
      });

      const embedding = embeddingResponse.data[0].embedding;

      await qdrant.upsert("documents", {
        points: [
          {
            id: Date.now() + i,
            vector: embedding,
            payload: {
              text: chunk,
            },
          },
        ],
      });
    }

    res.json({
      message: "File uploaded, chunked, and stored in Qdrant",
      total_chunks: chunks.length,
    });

  } catch (error) {
    console.error(error);
    res.status(500).send("Error processing file");
  }
});

// ================= SEARCH =================

app.post("/search", async (req, res) => {
  try {
    const { query } = req.body;

    // Convert query to embedding
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query,
    });

    const queryVector = embeddingResponse.data[0].embedding;

    // Search Qdrant
    const results = await qdrant.search("documents", {
      vector: queryVector,
      limit: 3,
    });

    res.json(results);

  } catch (error) {
    console.error(error);
    res.status(500).send("Search error");
  }
});
// ================= REDIS =================

const redis = require("redis");

const redisClient = redis.createClient();

redisClient.connect()
  .then(() => console.log("Redis connected"))
  .catch(console.error);

// ================= PROTECTED ROUTE =================

app.get("/dashboard", auth, (req, res) => {
  res.send("Welcome " + req.user.username);
});

// ================= SYSTEM PROMPT CHAT =================
function buildPrompt(context, query) {
  return `
You are an AI assistant that answers questions ONLY using the provided context.

Rules:
- Use only the given context
- If answer is not in context, say "Answer not found in provided data"
- Keep answer clear and concise
- Do not make up information

Context:
${context}

Question:
${query}

Answer:
`;
}
// ================= CHAT =================
app.post("/chat", async (req, res) => {
  try {
    const { query } = req.body;

    const cacheKey = `chat:${query}`;

    // 🔹 1. Check cache
    const cached = await redisClient.get(cacheKey);

    if (cached) {
      return res.json({
        source: "cache",
        answer: cached
      });
    }

    // 🔹 2. Query → embedding
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query,
    });

    const queryVector = embeddingResponse.data[0].embedding;

    // 🔹 3. Retrieve context
    const searchResults = await qdrant.search("documents", {
      vector: queryVector,
      limit: 3,
    });

    const context = searchResults.map(r => r.payload.text).join("\n");

    // 🔹 4. Generate answer
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: `Context:\n${context}\n\nQuestion:\n${query}`
        }
      ],
    });

    const answer = response.choices[0].message.content;

    // 🔹 5. Store in Redis (TTL = 1 hour)
    await redisClient.setEx(cacheKey, 3600, answer);

    res.json({
      source: "llm",
      answer: answer
    });

  } catch (error) {
    console.error(error);
    res.status(500).send("Error");
  }
});
// ================= CHAT-STREAM =================
app.post("/chat-stream", async (req, res) => {
  try {
    const { query } = req.body;

    // 🔹 Set headers for streaming
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Transfer-Encoding", "chunked");

    // 1. Query → embedding
    const embeddingResponse = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query,
    });

    const queryVector = embeddingResponse.data[0].embedding;

    // 2. Retrieve context
    const searchResults = await qdrant.search("documents", {
      vector: queryVector,
      limit: 3,
    });

    const context = searchResults
      .map(r => r.payload.text)
      .join("\n");

    // 3. Build prompt
    const prompt = `
You are an AI assistant. Answer only using the given context.

Context:
${context}

Question:
${query}

Answer:
`;

    // 4. Streaming response from LLM
    const stream = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      stream: true,
      messages: [
        { role: "user", content: prompt }
      ],
    });

    // 5. Send chunks to client
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        res.write(content); // send piece
      }
    }

    res.end(); // finish

  } catch (error) {
    console.error(error);
    res.status(500).send("Streaming error");
  }
});

// ================= SERVER =================

app.listen(3000, () => {
  console.log("Server running on port 3000");
});