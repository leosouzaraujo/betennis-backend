const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

const apostasFile = path.join(__dirname, "apostas.json");

app.use(express.json());

app.use(
  cors({
    origin: "https://betennis.lovable.app",
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type"],
  })
);

function garantirArquivoApostas() {
  if (!fs.existsSync(apostasFile)) {
    fs.writeFileSync(apostasFile, "[]", "utf-8");
  }
}

function lerApostas() {
  garantirArquivoApostas();

  try {
    const dados = fs.readFileSync(apostasFile, "utf-8");
    return JSON.parse(dados);
  } catch (error) {
    console.error("Erro ao ler apostas.json:", error.message);
    return [];
  }
}

function salvarApostas(apostas) {
  try {
    fs.writeFileSync(apostasFile, JSON.stringify(apostas, null, 2), "utf-8");
  } catch (error) {
    console.error("Erro ao salvar apostas.json:", error.message);
  }
}

function normalizarNome(nome) {
  return String(nome || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function calcularLucro(aposta) {
  const stake = Number(aposta?.stake) || 0;
  const odd = Number(aposta?.odd) || 0;
  const status = aposta?.status;
  const resultado = aposta?.resultado;

  if (status !== "finalizada") {
    return 0;
  }

  if (resultado === "win") {
    return Number((stake * (odd - 1)).toFixed(2));
  }

  if (resultado === "loss") {
    return Number((-stake).toFixed(2));
  }

  if (resultado === "void") {
    return 0;
  }

  return 0;
}

function atualizarLucroAposta(aposta) {
  return {
    ...aposta,
    odd: Number(aposta?.odd) || 0,
    stake: Number(aposta?.stake) || 0,
    lucro: calcularLucro(aposta),
  };
}

function extrairVencedorDoResultado(jogo) {
  const resultado = jogo?.event_final_result;
  if (!resultado) return null;

  const partes = String(resultado)
    .split("-")
    .map((p) => Number(String(p).trim()));

  if (partes.length < 2 || Number.isNaN(partes[0]) || Number.isNaN(partes[1])) {
    return null;
  }

  const [sets1, sets2] = partes;

  if (sets1 === sets2) return null;

  return sets1 > sets2 ? jogo.event_first_player : jogo.event_second_player;
}

function matchJogador(nomeApi, nomeAposta) {
  const apiNormalizado = normalizarNome(nomeApi);
  const apostaNormalizada = normalizarNome(nomeAposta);

  if (!apiNormalizado || !apostaNormalizada) {
    return false;
  }

  if (apiNormalizado === apostaNormalizada) {
    return true;
  }

  const api = apiNormalizado.split(" ");
  const aposta = apostaNormalizada.split(" ");

  if (!api.length || !aposta.length) {
    return false;
  }

  const sobrenomeApi = api[api.length - 1];
  const sobrenomeAposta = aposta[aposta.length - 1];

  const inicialApi = api[0] ? api[0][0] : "";
  const inicialAposta = aposta[0] ? aposta[0][0] : "";

  return sobrenomeApi === sobrenomeAposta && inicialApi === inicialAposta;
}

app.get("/", (req, res) => {
  res.json({ status: "BeTennis API rodando 🚀" });
});

app.get("/apostas", (req, res) => {
  const apostas = lerApostas();
  const apostasAtualizadas = apostas.map(atualizarLucroAposta);

  salvarApostas(apostasAtualizadas);
  res.json(apostasAtualizadas);
});

app.post("/apostas", (req, res) => {
  const { player1, player2, escolha, odd, stake } = req.body;

  if (!player1 || !player2 || !escolha || !odd || !stake) {
    return res.status(400).json({
      erro: "Campos obrigatórios: player1, player2, escolha, odd, stake",
    });
  }

  const apostas = lerApostas();

  const novaAposta = {
    id: Date.now().toString(),
    player1,
    player2,
    escolha,
    odd: Number(odd),
    stake: Number(stake),
    status: "pendente",
    resultado: null,
    lucro: 0,
    createdAt: new Date().toISOString(),
  };

  apostas.push(novaAposta);
  salvarApostas(apostas);

  res.status(201).json(novaAposta);
});

app.put("/apostas/:id", (req, res) => {
  const { id } = req.params;
  const { status, resultado, odd, stake, escolha, player1, player2 } = req.body;

  const apostas = lerApostas();
  const index = apostas.findIndex((aposta) => aposta.id === id);

  if (index === -1) {
    return res.status(404).json({ erro: "Aposta não encontrada" });
  }

  if (status !== undefined) apostas[index].status = status;
  if (resultado !== undefined) apostas[index].resultado = resultado;
  if (odd !== undefined) apostas[index].odd = Number(odd);
  if (stake !== undefined) apostas[index].stake = Number(stake);
  if (escolha !== undefined) apostas[index].escolha = escolha;
  if (player1 !== undefined) apostas[index].player1 = player1;
  if (player2 !== undefined) apostas[index].player2 = player2;

  apostas[index].lucro = calcularLucro(apostas[index]);
  apostas[index].updatedAt = new Date().toISOString();

  salvarApostas(apostas);

  res.json(apostas[index]);
});

app.delete("/apostas/:id", (req, res) => {
  const { id } = req.params;

  const apostas = lerApostas();
  const novasApostas = apostas.filter((aposta) => aposta.id !== id);

  if (novasApostas.length === apostas.length) {
    return res.status(404).json({ erro: "Aposta não encontrada" });
  }

  salvarApostas(novasApostas);

  res.json({ mensagem: "Aposta removida com sucesso" });
});

app.get("/jogos-hoje", async (req, res) => {
  try {
    const apiKey = process.env.API_TENNIS_KEY;

    if (!apiKey) {
      return res.status(200).json({
        erro: "API_TENNIS_KEY não configurada no Railway",
        jogos: [],
      });
    }

    const hoje = new Date().toISOString().split("T")[0];

    const response = await axios.get("https://api.api-tennis.com/tennis/", {
      params: {
        method: "get_fixtures",
        APIkey: apiKey,
        date_start: hoje,
        date_stop: hoje,
      },
      timeout: 15000,
    });

    const jogos = Array.isArray(response.data?.result) ? response.data.result : [];

    const filtrados = jogos
      .filter((jogo) => {
        const tipo = jogo.event_type_type || "";
        return tipo === "Atp Singles" || tipo === "Wta Singles";
      })
      .map((jogo) => ({
        id:
          jogo.event_key ||
          `${jogo.event_first_player}-${jogo.event_second_player}-${jogo.event_date}`,
        player1: jogo.event_first_player || "",
        player2: jogo.event_second_player || "",
        tournament: jogo.tournament_name || "",
        time: jogo.event_time || "",
        date: jogo.event_date || hoje,
        status: jogo.event_status || "Not Started",
        type: jogo.event_type_type || "",
      }));

    return res.status(200).json({
      jogos: filtrados,
    });
  } catch (error) {
    console.error(
      "Erro ao buscar jogos do dia:",
      error.response?.data || error.message
    );

    return res.status(200).json({
      erro: "Falha ao buscar jogos na API externa",
      detalhe: error.response?.data || error.message,
      jogos: [],
    });
  }
});

app.get("/validar-apostas", async (req, res) => {
  try {
    const apiKey = process.env.API_TENNIS_KEY;

    if (!apiKey) {
      return res.status(200).json({
        erro: "API_TENNIS_KEY não configurada no Railway",
        atualizadas: 0,
        apostas: [],
      });
    }

    const hoje = new Date();
    const tresDiasAtras = new Date();
    tresDiasAtras.setDate(hoje.getDate() - 3);

    const formatarData = (data) => data.toISOString().split("T")[0];

    const response = await axios.get("https://api.api-tennis.com/tennis/", {
      params: {
        method: "get_fixtures",
        APIkey: apiKey,
        date_start: formatarData(tresDiasAtras),
        date_stop: formatarData(hoje),
      },
      timeout: 15000,
    });

    const jogosApi = Array.isArray(response.data?.result) ? response.data.result : [];
    const apostas = lerApostas();

    const atualizadas = [];

    for (const aposta of apostas) {
      if (
        aposta.resultado === "win" ||
        aposta.resultado === "loss" ||
        aposta.resultado === "void"
      ) {
        aposta.lucro = calcularLucro(aposta);
        continue;
      }

      const jogo = jogosApi.find((j) => {
        const ordemNormal =
          matchJogador(j.event_first_player, aposta.player1) &&
          matchJogador(j.event_second_player, aposta.player2);

        const ordemInvertida =
          matchJogador(j.event_first_player, aposta.player2) &&
          matchJogador(j.event_second_player, aposta.player1);

        return ordemNormal || ordemInvertida;
      });

      if (!jogo) {
        aposta.lucro = calcularLucro(aposta);
        continue;
      }

      if (String(jogo.event_status || "").toLowerCase() !== "finished") {
        aposta.lucro = calcularLucro(aposta);
        continue;
      }

      const vencedor = extrairVencedorDoResultado(jogo);

      if (!vencedor) {
        aposta.status = "finalizada";
        aposta.resultado = "void";
        aposta.lucro = calcularLucro(aposta);
        aposta.updatedAt = new Date().toISOString();
        atualizadas.push(aposta);
        continue;
      }

      aposta.status = "finalizada";
      aposta.resultado =
        normalizarNome(aposta.escolha) === normalizarNome(vencedor)
          ? "win"
          : "loss";
      aposta.lucro = calcularLucro(aposta);
      aposta.updatedAt = new Date().toISOString();

      atualizadas.push(aposta);
    }

    const apostasComLucro = apostas.map(atualizarLucroAposta);
    salvarApostas(apostasComLucro);

    return res.status(200).json({
      mensagem: "Validação concluída",
      atualizadas: atualizadas.length,
      apostas: atualizadas.map(atualizarLucroAposta),
    });
  } catch (error) {
    console.error(
      "Erro ao validar apostas:",
      error.response?.data || error.message
    );

    return res.status(200).json({
      erro: "Erro ao validar apostas",
      detalhe: error.response?.data || error.message,
      atualizadas: 0,
      apostas: [],
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor BeTennis rodando na porta ${PORT}`);
});