require("dotenv").config();

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();

// CORS manual e explícito
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  next();
});

app.use(express.json());

const PORT = process.env.PORT || 3000;

const DB_PATH = path.join(__dirname, "db");
const APOSTAS_FILE = path.join(DB_PATH, "apostas.json");
const HISTORICO_FILE = path.join(DB_PATH, "historico.json");

if (!fs.existsSync(DB_PATH)) fs.mkdirSync(DB_PATH);
if (!fs.existsSync(APOSTAS_FILE)) fs.writeFileSync(APOSTAS_FILE, "[]");
if (!fs.existsSync(HISTORICO_FILE)) fs.writeFileSync(HISTORICO_FILE, "[]");

function lerJSON(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function salvarJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function normalizarNome(nome) {
  if (!nome) return "";
  return nome
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

app.get("/", (req, res) => {
  res.json({ status: "BeTennis API rodando 🚀" });
});

app.get("/apostas", (req, res) => {
  try {
    const apostas = lerJSON(APOSTAS_FILE);

    const formatadas = apostas.map((a) => ({
      player1: a.jogador1,
      player2: a.jogador2,
      escolha: a.palpite,
      odd: a.odd || 1,
      stake: a.stake || 100,
    }));

    res.json(formatadas);
  } catch (error) {
    console.error("Erro ao listar apostas:", error);
    res.status(500).json({ error: "Erro ao ler apostas." });
  }
});

app.post("/apostas", (req, res) => {
  try {
    const apostas = lerJSON(APOSTAS_FILE);

    const nova = {
      id: Date.now().toString(),
      jogador1: req.body.jogador1,
      jogador2: req.body.jogador2,
      torneio: req.body.torneio || "",
      data: req.body.data || null,
      odd: req.body.odd || null,
      stake: req.body.stake || 100,
      palpite: req.body.palpite || req.body.jogador1,
      status: "pendente",
      createdAt: new Date().toISOString(),
    };

    apostas.push(nova);
    salvarJSON(APOSTAS_FILE, apostas);

    res.json(nova);
  } catch (error) {
    console.error("Erro ao criar aposta:", error);
    res.status(500).json({ error: "Erro ao criar aposta." });
  }
});

app.delete("/apostas/:id", (req, res) => {
  try {
    const apostas = lerJSON(APOSTAS_FILE);
    const novas = apostas.filter((a) => a.id !== req.params.id);

    salvarJSON(APOSTAS_FILE, novas);
    res.json({ ok: true });
  } catch (error) {
    console.error("Erro ao remover aposta:", error);
    res.status(500).json({ error: "Erro ao remover aposta." });
  }
});

app.get("/historico", (req, res) => {
  try {
    res.json(lerJSON(HISTORICO_FILE));
  } catch (error) {
    console.error("Erro ao listar histórico:", error);
    res.status(500).json({ error: "Erro ao ler histórico." });
  }
});

app.post("/validar", async (req, res) => {
  try {
    const { data } = req.body;

    if (!data) {
      return res.status(400).json({ error: "Campo 'data' é obrigatório." });
    }

    const apostas = lerJSON(APOSTAS_FILE);
    const historico = lerJSON(HISTORICO_FILE);

    const response = await axios.get(process.env.API_TENNIS_BASE_URL, {
      params: {
        method: "get_fixtures",
        APIkey: process.env.API_TENNIS_KEY,
        date_start: data,
        date_stop: data,
      },
    });

    const jogos = response.data.result || [];
    const restantes = [];
    const validadas = [];

    for (const aposta of apostas) {
      if (aposta.data !== data) {
        restantes.push(aposta);
        continue;
      }

      const j1 = normalizarNome(aposta.jogador1);
      const j2 = normalizarNome(aposta.jogador2);

      const jogo = jogos.find((j) => {
        const a = normalizarNome(j.event_first_player);
        const b = normalizarNome(j.event_second_player);
        return (a === j1 && b === j2) || (a === j2 && b === j1);
      });

      if (!jogo || !jogo.event_winner) {
        restantes.push(aposta);
        continue;
      }

      const vencedor =
        jogo.event_winner === "First Player"
          ? jogo.event_first_player
          : jogo.event_second_player;

      const status =
        normalizarNome(vencedor) === normalizarNome(aposta.palpite)
          ? "green"
          : "red";

      const final = {
        ...aposta,
        status,
        vencedor,
        placar: jogo.event_final_result,
        validadoEm: new Date().toISOString(),
      };

      historico.push(final);
      validadas.push(final);
    }

    salvarJSON(APOSTAS_FILE, restantes);
    salvarJSON(HISTORICO_FILE, historico);

    res.json({
      total: validadas.length,
      validadas,
    });
  } catch (error) {
    console.error("Erro ao validar resultados:", error);
    res.status(500).json({ error: "Erro ao validar resultados." });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});