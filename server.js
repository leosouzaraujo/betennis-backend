require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const apostasFile = path.join(__dirname, "apostas.json");

app.use(express.json());

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  })
);

// ==========================
// UTIL
// ==========================

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
    console.error("Erro ao ler apostas.json:", error);
    return [];
  }
}

function salvarApostas(apostas) {
  try {
    fs.writeFileSync(apostasFile, JSON.stringify(apostas, null, 2), "utf-8");
  } catch (error) {
    console.error("Erro ao salvar apostas.json:", error);
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

function normalizarTexto(texto) {
  if (!texto) return null;

  return String(texto)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function formatarData(data) {
  return data.toISOString().split("T")[0];
}

function formatarDataLocal(data = new Date()) {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, "0");
  const dia = String(data.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}

function calcularLucro(aposta) {
  const stake = Number(aposta?.stake) || 0;
  const odd = Number(aposta?.odd) || 0;
  const status = aposta?.status;
  const resultado = aposta?.resultado;

  if (status !== "finalizada") return 0;

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

function extrairSuperficie(jogo) {
  const candidatos = [
    jogo?.event_surface,
    jogo?.surface,
    jogo?.tournament_surface,
    jogo?.league_surface,
  ];

  for (const item of candidatos) {
    if (item && String(item).trim()) {
      return String(item).trim();
    }
  }

  const nomeTorneio =
    normalizarTexto(jogo?.tournament_name || "")?.toLowerCase() || "";

  if (
    nomeTorneio.includes("roland garros") ||
    nomeTorneio.includes("french open") ||
    nomeTorneio.includes("madrid") ||
    nomeTorneio.includes("rome") ||
    nomeTorneio.includes("monte carlo") ||
    nomeTorneio.includes("hamburg") ||
    nomeTorneio.includes("estoril") ||
    nomeTorneio.includes("barcelona") ||
    nomeTorneio.includes("marrakech") ||
    nomeTorneio.includes("bucharest")
  ) {
    return "Clay";
  }

  if (
    nomeTorneio.includes("wimbledon") ||
    nomeTorneio.includes("halle") ||
    nomeTorneio.includes("eastbourne") ||
    nomeTorneio.includes("mallorca") ||
    nomeTorneio.includes("queens")
  ) {
    return "Grass";
  }

  if (
    nomeTorneio.includes("australian open") ||
    nomeTorneio.includes("us open") ||
    nomeTorneio.includes("miami") ||
    nomeTorneio.includes("indian wells") ||
    nomeTorneio.includes("dubai") ||
    nomeTorneio.includes("doha") ||
    nomeTorneio.includes("rotterdam") ||
    nomeTorneio.includes("paris")
  ) {
    return "Hard";
  }

  return null;
}

function mapearStatusPartida(jogo) {
  const statusOriginal = String(
    jogo?.event_status || jogo?.status || jogo?.event_live || ""
  ).toLowerCase();

  const finalResult = String(jogo?.event_final_result || "").trim();

  if (finalResult) return "finished";

  if (
    statusOriginal.includes("finished") ||
    statusOriginal.includes("ended") ||
    statusOriginal.includes("final")
  ) {
    return "finished";
  }

  if (
    statusOriginal.includes("live") ||
    statusOriginal.includes("inplay") ||
    statusOriginal.includes("set") ||
    statusOriginal.includes("game")
  ) {
    return "live";
  }

  if (
    statusOriginal.includes("cancel") ||
    statusOriginal.includes("suspend") ||
    statusOriginal.includes("postpon") ||
    statusOriginal.includes("walkover") ||
    statusOriginal.includes("retired")
  ) {
    return "cancelled";
  }

  return "scheduled";
}

function calcularConfiancaBase(jogo) {
  let score = 50;

  const superficie = extrairSuperficie(jogo);
  if (superficie) score += 5;
  if (jogo?.tournament_name) score += 5;
  if (jogo?.event_time) score += 5;
  if (jogo?.event_first_player && jogo?.event_second_player) score += 5;

  return Math.min(score, 70);
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

  return sets1 > sets2
    ? jogo.event_first_player || null
    : jogo.event_second_player || null;
}

function isJogoFinalizado(jogo) {
  const status = String(jogo?.event_status || "")
    .trim()
    .toLowerCase();

  const finalStatuses = [
    "finished",
    "after ft",
    "ft",
    "final",
    "ended",
    "completed",
    "walkover",
    "wo",
    "retired",
    "cancelled",
    "canceled",
    "abandoned",
  ];

  if (finalStatuses.includes(status)) return true;
  if (jogo?.event_final_result) return true;

  return false;
}

function matchJogador(nomeApi, nomeAposta) {
  const apiNormalizado = normalizarNome(nomeApi);
  const apostaNormalizada = normalizarNome(nomeAposta);

  if (!apiNormalizado || !apostaNormalizada) return false;
  if (apiNormalizado === apostaNormalizada) return true;

  const api = apiNormalizado.split(" ");
  const aposta = apostaNormalizada.split(" ");

  const sobrenomeApi = api[api.length - 1];
  const sobrenomeAposta = aposta[aposta.length - 1];

  const inicialApi = api[0] ? api[0][0] : "";
  const inicialAposta = aposta[0] ? aposta[0][0] : "";

  return sobrenomeApi === sobrenomeAposta && inicialApi === inicialAposta;
}

function encontrarJogoDaAposta(jogosApi, aposta) {
  if (aposta?.eventId) {
    const jogoPorId = jogosApi.find(
      (j) => String(j.event_key || "") === String(aposta.eventId)
    );

    if (jogoPorId) return jogoPorId;
  }

  return jogosApi.find((j) => {
    const ordemNormal =
      matchJogador(j.event_first_player, aposta.player1) &&
      matchJogador(j.event_second_player, aposta.player2);

    const ordemInvertida =
      matchJogador(j.event_first_player, aposta.player2) &&
      matchJogador(j.event_second_player, aposta.player1);

    return ordemNormal || ordemInvertida;
  });
}

// ==========================
// EV / MODEL
// ==========================

function arredondar(valor, casas = 4) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(casas));
}

function calcularProbImplicita(odd) {
  const o = Number(odd);
  if (!Number.isFinite(o) || o <= 0) return null;
  return arredondar(1 / o, 4);
}

function calcularEV(probabilidade, odd) {
  const p = Number(probabilidade);
  const o = Number(odd);

  if (!Number.isFinite(p) || !Number.isFinite(o) || o <= 0) {
    return null;
  }

  return arredondar(p * o - 1, 4);
}

function classificarApostaPorEV(ev) {
  if (ev == null) {
    return {
      label: "Sem dados",
      apostar: false,
      faixa: "indefinida",
    };
  }

  if (ev >= 0.05) {
    return {
      label: "Value Bet Forte",
      apostar: true,
      faixa: "forte",
    };
  }

  if (ev >= 0.02) {
    return {
      label: "Value Bet",
      apostar: true,
      faixa: "moderada",
    };
  }

  if (ev > 0) {
    return {
      label: "Marginal",
      apostar: false,
      faixa: "fraca",
    };
  }

  return {
    label: "No Bet",
    apostar: false,
    faixa: "negativa",
  };
}

function definirRiskLevel(confidence, ev) {
  if (ev == null || confidence == null) return "unknown";

  if (ev >= 0.05 && confidence >= 65) return "low";
  if (ev >= 0.02 && confidence >= 55) return "medium";
  return "high";
}

function estimarProbabilidadeModeloPlaceholder(jogo) {
  const player1 = jogo?.event_first_player || "";
  const player2 = jogo?.event_second_player || "";

  if (!player1 || !player2) {
    return {
      probabilityPlayer1: null,
      probabilityPlayer2: null,
      source: "placeholder",
    };
  }

  return {
    probabilityPlayer1: 0.5,
    probabilityPlayer2: 0.5,
    source: "placeholder",
  };
}

// ==========================
// ROTA BASE
// ==========================

app.get("/", (_req, res) => {
  res.json({ status: "BeTennis API rodando 🚀" });
});

// ==========================
// CRUD APOSTAS
// ==========================

app.get("/apostas", (_req, res) => {
  const apostas = lerApostas().map(atualizarLucroAposta);
  salvarApostas(apostas);
  res.json(apostas);
});

app.get("/normalizar-apostas", (_req, res) => {
  try {
    const apostas = lerApostas();

    let atualizadas = 0;

    const apostasAtualizadas = apostas.map((aposta) => {
      let mudou = false;

      if (aposta.tournament === undefined) {
        aposta.tournament = null;
        mudou = true;
      }

      if (aposta.surface === undefined) {
        aposta.surface = null;
        mudou = true;
      }

      if (mudou) atualizadas++;

      return aposta;
    });

    fs.writeFileSync(
      apostasFile,
      JSON.stringify(apostasAtualizadas, null, 2),
      "utf-8"
    );

    res.json({
      mensagem: "Normalização concluída",
      resumo: {
        totalApostas: apostas.length,
        atualizadas,
      },
      apostas: apostasAtualizadas.map((a) => ({
        id: a.id,
        tournament: a.tournament,
        surface: a.surface,
      })),
    });
  } catch (error) {
    console.error("Erro ao normalizar apostas:", error.message);

    res.status(500).json({
      erro: "Erro ao normalizar apostas",
    });
  }
});

app.post("/apostas", (req, res) => {
  const {
    eventId = null,
    player1,
    player2,
    escolha,
    odd,
    stake,
    market = "match_winner",
    tournament = null,
    surface = null,
    probModelo = null,
    modeloVersao = "v1.0.0",
  } = req.body;

  if (!player1 || !player2 || !escolha || !odd || !stake) {
    return res.status(400).json({
      erro: "Campos obrigatórios: player1, player2, escolha, odd, stake",
    });
  }

  const oddNumerica = Number(odd);
  const stakeNumerica = Number(stake);
  const probImplicita =
    oddNumerica > 0 ? Number((1 / oddNumerica).toFixed(4)) : null;
  const edge =
    probModelo != null && probImplicita != null
      ? Number((Number(probModelo) - probImplicita).toFixed(4))
      : null;

  const agora = new Date().toISOString();
  const apostas = lerApostas();

  const novaAposta = {
    id: `pred_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    eventId,
    player1,
    player2,
    escolha,
    odd: oddNumerica,
    stake: stakeNumerica,
    market,
    tournament,
    surface,
    probModelo: probModelo != null ? Number(probModelo) : null,
    probImplicita,
    edge,
    modeloVersao,
    status: "pendente",
    resultado: null,
    winner: null,
    score: null,
    lucro: 0,
    createdAt: agora,
    updatedAt: agora,
  };

  apostas.push(novaAposta);
  salvarApostas(apostas);

  return res.status(201).json(novaAposta);
});

app.put("/apostas/:id", (req, res) => {
  const { id } = req.params;
  const {
    status,
    resultado,
    odd,
    stake,
    escolha,
    player1,
    player2,
    winner,
    score,
    eventId,
    market,
    tournament,
    surface,
    probModelo,
    modeloVersao,
  } = req.body;

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
  if (winner !== undefined) apostas[index].winner = winner;
  if (score !== undefined) apostas[index].score = score;
  if (eventId !== undefined) apostas[index].eventId = eventId;
  if (market !== undefined) apostas[index].market = market;
  if (tournament !== undefined) apostas[index].tournament = tournament;
  if (surface !== undefined) apostas[index].surface = surface;

  if (probModelo !== undefined) {
    apostas[index].probModelo =
      probModelo != null ? Number(probModelo) : null;
  }

  if (modeloVersao !== undefined) {
    apostas[index].modeloVersao = modeloVersao;
  }

  const oddAtual = Number(apostas[index].odd) || 0;
  const probImplicita =
    oddAtual > 0 ? Number((1 / oddAtual).toFixed(4)) : null;

  apostas[index].probImplicita = probImplicita;
  apostas[index].edge =
    apostas[index].probModelo != null && probImplicita != null
      ? Number(
          (Number(apostas[index].probModelo) - probImplicita).toFixed(4)
        )
      : null;

  apostas[index].lucro = calcularLucro(apostas[index]);
  apostas[index].updatedAt = new Date().toISOString();

  salvarApostas(apostas);
  return res.json(apostas[index]);
});

app.delete("/apostas/:id", (req, res) => {
  const { id } = req.params;

  const apostas = lerApostas();
  const novasApostas = apostas.filter((aposta) => aposta.id !== id);

  if (novasApostas.length === apostas.length) {
    return res.status(404).json({ erro: "Aposta não encontrada" });
  }

  salvarApostas(novasApostas);
  return res.json({ mensagem: "Aposta removida com sucesso" });
});

// ==========================
// PARTIDAS HOJE COM EV
// ==========================

app.get("/partidas-hoje", async (_req, res) => {
  try {
    const apiKey = process.env.API_TENNIS_KEY;

    if (!apiKey) {
      return res.status(500).json({
        erro: "API_TENNIS_KEY não configurada",
      });
    }

    const hoje = new Date();
    const amanha = new Date();
    amanha.setDate(hoje.getDate() + 1);

    const dataHoje = formatarData(hoje);
    const dataAmanha = formatarData(amanha);

    const response = await axios.get("https://api.api-tennis.com/tennis/", {
      params: {
        method: "get_fixtures",
        APIkey: apiKey,
        date_start: dataHoje,
        date_stop: dataAmanha,
      },
      timeout: 20000,
    });

    const jogosApi = Array.isArray(response.data?.result)
      ? response.data.result
      : [];

    const partidas = jogosApi.map((jogo) => {
      const player1 = jogo?.event_first_player || null;
      const player2 = jogo?.event_second_player || null;
      const tournament = jogo?.tournament_name || null;
      const surface = extrairSuperficie(jogo);
      const status = mapearStatusPartida(jogo);

      const rawId =
        jogo?.event_key ||
        jogo?.event_id ||
        `${player1 || "p1"}-${player2 || "p2"}-${jogo?.event_date || dataHoje}`;

      const oddPlayer1 = null;
      const oddPlayer2 = null;

      const probImplicitaPlayer1 = calcularProbImplicita(oddPlayer1);
      const probImplicitaPlayer2 = calcularProbImplicita(oddPlayer2);

      const modelo = estimarProbabilidadeModeloPlaceholder(jogo);

      const evPlayer1 = calcularEV(modelo.probabilityPlayer1, oddPlayer1);
      const evPlayer2 = calcularEV(modelo.probabilityPlayer2, oddPlayer2);

      const classeP1 = classificarApostaPorEV(evPlayer1);
      const classeP2 = classificarApostaPorEV(evPlayer2);

      let melhorLado = null;
      let melhorEV = null;
      let recomendacao = "Sem dados";
      let noBetZone = true;

      if (evPlayer1 != null || evPlayer2 != null) {
        if ((evPlayer1 ?? -999) >= (evPlayer2 ?? -999)) {
          melhorLado = "player1";
          melhorEV = evPlayer1;
          recomendacao = classeP1.label;
          noBetZone = !classeP1.apostar;
        } else {
          melhorLado = "player2";
          melhorEV = evPlayer2;
          recomendacao = classeP2.label;
          noBetZone = !classeP2.apostar;
        }
      }

      const confidence = calcularConfiancaBase(jogo);
      const riskLevel = definirRiskLevel(confidence, melhorEV);

      return {
        id: String(rawId),
        player1,
        player2,
        tournament,
        surface,
        date: jogo?.event_date || dataHoje,
        time: jogo?.event_time || null,
        status,
        score: jogo?.event_final_result || null,
        odds: {
          player1: oddPlayer1,
          player2: oddPlayer2,
          source: null,
          updatedAt: null,
        },
        market: {
          probImplicitaPlayer1,
          probImplicitaPlayer2,
        },
        model: {
          probabilityPlayer1: modelo.probabilityPlayer1,
          probabilityPlayer2: modelo.probabilityPlayer2,
          source: modelo.source,
          confidence,
        },
        ev: {
          player1: evPlayer1,
          player2: evPlayer2,
          bestSide: melhorLado,
          bestEV: melhorEV,
          recommendation: recomendacao,
          noBetZone,
          riskLevel,
        },
        metadata: {
          apiEventKey: jogo?.event_key || null,
          eventType: jogo?.event_type_type || null,
          tournamentRound: jogo?.event_round || null,
        },
      };
    });

    partidas.sort((a, b) => {
      const dataA = `${a.date || ""} ${a.time || "23:59"}`;
      const dataB = `${b.date || ""} ${b.time || "23:59"}`;
      return dataA.localeCompare(dataB);
    });

    return res.status(200).json(partidas);
  } catch (error) {
    console.error(
      "Erro em /partidas-hoje:",
      error?.response?.data || error?.message
    );

    return res.status(500).json({
      erro: "Falha ao buscar partidas do dia",
      detalhe: error?.response?.data || error?.message,
      partidas: [],
    });
  }
});

// ==========================
// VALIDAR APOSTAS
// ==========================

app.get("/validar-apostas", async (_req, res) => {
  try {
    const apiKey = process.env.API_TENNIS_KEY;

    if (!apiKey) {
      return res.status(200).json({
        erro: "API_TENNIS_KEY não configurada",
        atualizadas: 0,
        apostas: [],
      });
    }

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

      const dataBase = aposta.createdAt ? new Date(aposta.createdAt) : new Date();

      const dataInicio = new Date(dataBase);
      dataInicio.setDate(dataInicio.getDate() - 1);

      const dataFim = new Date(dataBase);
      dataFim.setDate(dataFim.getDate() + 7);

      const dateStart = formatarDataLocal(dataInicio);
      const dateStop = formatarDataLocal(dataFim);

      const response = await axios.get("https://api.api-tennis.com/tennis/", {
        params: {
          method: "get_fixtures",
          APIkey: apiKey,
          date_start: dateStart,
          date_stop: dateStop,
        },
        timeout: 15000,
      });

      const jogosApi = Array.isArray(response.data?.result)
        ? response.data.result
        : [];

      const jogo = encontrarJogoDaAposta(jogosApi, aposta);

      if (!jogo) {
        aposta.lucro = calcularLucro(aposta);
        continue;
      }

      if (!isJogoFinalizado(jogo)) {
        aposta.lucro = calcularLucro(aposta);
        continue;
      }

      const vencedor = extrairVencedorDoResultado(jogo);

      aposta.status = "finalizada";
      aposta.score = jogo.event_final_result || null;
      aposta.winner = vencedor || null;
      aposta.eventId = aposta.eventId || String(jogo.event_key || "") || null;

      if (!vencedor) {
        aposta.resultado = "void";
        aposta.lucro = calcularLucro(aposta);
        aposta.updatedAt = new Date().toISOString();
        atualizadas.push({ ...aposta });
        continue;
      }

      aposta.resultado =
        normalizarNome(aposta.escolha) === normalizarNome(vencedor)
          ? "win"
          : "loss";

      aposta.lucro = calcularLucro(aposta);
      aposta.updatedAt = new Date().toISOString();

      atualizadas.push({ ...aposta });
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
      "[VALIDAR-APOSTAS] Erro ao validar apostas:",
      error?.response?.data || error?.message
    );

    return res.status(200).json({
      erro: "Erro ao validar apostas",
      detalhe: error?.response?.data || error?.message,
      atualizadas: 0,
      apostas: [],
    });
  }
});

// ==========================
// ANALYTICS
// ==========================

app.get("/apostas-analytics", (req, res) => {
  try {
    const {
      status,
      resultado,
      market,
      tournament,
      surface,
      dateFrom,
      dateTo,
    } = req.query;

    let apostas = lerApostas().map(atualizarLucroAposta);

    if (status) {
      const statusNorm = normalizarNome(status);
      apostas = apostas.filter((a) => normalizarNome(a.status) === statusNorm);
    }

    if (resultado) {
      const resultadoNorm = normalizarNome(resultado);
      apostas = apostas.filter(
        (a) => normalizarNome(a.resultado) === resultadoNorm
      );
    }

    if (market) {
      const marketNorm = normalizarNome(market);
      apostas = apostas.filter((a) => normalizarNome(a.market) === marketNorm);
    }

    if (tournament) {
      const tournamentNorm = normalizarNome(tournament);
      apostas = apostas.filter(
        (a) => normalizarNome(a.tournament) === tournamentNorm
      );
    }

    if (surface) {
      const surfaceNorm = normalizarNome(surface);
      apostas = apostas.filter((a) => normalizarNome(a.surface) === surfaceNorm);
    }

    if (dateFrom) {
      const inicio = new Date(`${dateFrom}T00:00:00`);
      apostas = apostas.filter((a) => {
        if (!a.createdAt) return false;
        return new Date(a.createdAt) >= inicio;
      });
    }

    if (dateTo) {
      const fim = new Date(`${dateTo}T23:59:59.999`);
      apostas = apostas.filter((a) => {
        if (!a.createdAt) return false;
        return new Date(a.createdAt) <= fim;
      });
    }

    const finalizadas = apostas.filter((a) => a.status === "finalizada");

    function agruparPor(lista, getKey) {
      const mapa = {};

      for (const aposta of lista) {
        const chave = getKey(aposta) || "Sem informação";

        if (!mapa[chave]) {
          mapa[chave] = {
            chave,
            totalApostas: 0,
            finalizadas: 0,
            wins: 0,
            losses: 0,
            voids: 0,
            stakeTotal: 0,
            lucroTotal: 0,
            somaOdds: 0,
            qtdOdds: 0,
          };
        }

        mapa[chave].totalApostas += 1;
        mapa[chave].stakeTotal += Number(aposta.stake || 0);

        if (aposta.odd != null) {
          mapa[chave].somaOdds += Number(aposta.odd || 0);
          mapa[chave].qtdOdds += 1;
        }

        if (aposta.status === "finalizada") {
          mapa[chave].finalizadas += 1;
          mapa[chave].lucroTotal += Number(aposta.lucro || 0);

          if (aposta.resultado === "win") mapa[chave].wins += 1;
          if (aposta.resultado === "loss") mapa[chave].losses += 1;
          if (aposta.resultado === "void") mapa[chave].voids += 1;
        }
      }

      return Object.values(mapa)
        .map((item) => {
          const oddMedia = item.qtdOdds > 0 ? item.somaOdds / item.qtdOdds : 0;
          const roi =
            item.stakeTotal > 0 ? (item.lucroTotal / item.stakeTotal) * 100 : 0;
          const winRate =
            item.finalizadas > 0 ? (item.wins / item.finalizadas) * 100 : 0;

          return {
            chave: item.chave,
            totalApostas: item.totalApostas,
            finalizadas: item.finalizadas,
            wins: item.wins,
            losses: item.losses,
            voids: item.voids,
            stakeTotal: Number(item.stakeTotal.toFixed(2)),
            lucroTotal: Number(item.lucroTotal.toFixed(2)),
            oddMedia: Number(oddMedia.toFixed(2)),
            roi: Number(roi.toFixed(2)),
            winRate: Number(winRate.toFixed(2)),
          };
        })
        .sort((a, b) => b.lucroTotal - a.lucroTotal);
    }

    const porTorneio = agruparPor(apostas, (a) => a.tournament || "Sem torneio");
    const porSuperficie = agruparPor(apostas, (a) => a.surface || "Sem superfície");
    const porMercado = agruparPor(apostas, (a) => a.market || "Sem mercado");
    const porEscolha = agruparPor(apostas, (a) => a.escolha || "Sem escolha");
    const porWinner = agruparPor(finalizadas, (a) => a.winner || "Sem winner");

    const porDiaMap = {};

    for (const aposta of finalizadas) {
      const dataBase = aposta.createdAt || aposta.updatedAt || new Date().toISOString();
      const dia = new Date(dataBase).toISOString().split("T")[0];

      if (!porDiaMap[dia]) {
        porDiaMap[dia] = {
          chave: dia,
          totalApostas: 0,
          finalizadas: 0,
          wins: 0,
          losses: 0,
          voids: 0,
          stakeTotal: 0,
          lucroTotal: 0,
          somaOdds: 0,
          qtdOdds: 0,
        };
      }

      porDiaMap[dia].totalApostas += 1;
      porDiaMap[dia].finalizadas += 1;
      porDiaMap[dia].stakeTotal += Number(aposta.stake || 0);
      porDiaMap[dia].lucroTotal += Number(aposta.lucro || 0);

      if (aposta.odd != null) {
        porDiaMap[dia].somaOdds += Number(aposta.odd || 0);
        porDiaMap[dia].qtdOdds += 1;
      }

      if (aposta.resultado === "win") porDiaMap[dia].wins += 1;
      if (aposta.resultado === "loss") porDiaMap[dia].losses += 1;
      if (aposta.resultado === "void") porDiaMap[dia].voids += 1;
    }

    const porDia = Object.values(porDiaMap)
      .map((item) => {
        const oddMedia = item.qtdOdds > 0 ? item.somaOdds / item.qtdOdds : 0;
        const roi =
          item.stakeTotal > 0 ? (item.lucroTotal / item.stakeTotal) * 100 : 0;
        const winRate =
          item.finalizadas > 0 ? (item.wins / item.finalizadas) * 100 : 0;

        return {
          chave: item.chave,
          totalApostas: item.totalApostas,
          finalizadas: item.finalizadas,
          wins: item.wins,
          losses: item.losses,
          voids: item.voids,
          stakeTotal: Number(item.stakeTotal.toFixed(2)),
          lucroTotal: Number(item.lucroTotal.toFixed(2)),
          oddMedia: Number(oddMedia.toFixed(2)),
          roi: Number(roi.toFixed(2)),
          winRate: Number(winRate.toFixed(2)),
        };
      })
      .sort((a, b) => a.chave.localeCompare(b.chave));

    const visaoGeral = {
      totalApostas: apostas.length,
      totalFinalizadas: finalizadas.length,
      totalPendentes: apostas.filter((a) => a.status !== "finalizada").length,
      totalWins: finalizadas.filter((a) => a.resultado === "win").length,
      totalLosses: finalizadas.filter((a) => a.resultado === "loss").length,
      totalVoids: finalizadas.filter((a) => a.resultado === "void").length,
      stakeTotal: Number(
        apostas.reduce((acc, a) => acc + (Number(a.stake) || 0), 0).toFixed(2)
      ),
      lucroTotal: Number(
        finalizadas.reduce((acc, a) => acc + (Number(a.lucro) || 0), 0).toFixed(2)
      ),
      oddMedia:
        apostas.length > 0
          ? Number(
              (
                apostas.reduce((acc, a) => acc + (Number(a.odd) || 0), 0) /
                apostas.length
              ).toFixed(2)
            )
          : 0,
    };

    const visaoGeralComMetricas = {
      ...visaoGeral,
      roi:
        visaoGeral.stakeTotal > 0
          ? Number(
              ((visaoGeral.lucroTotal / visaoGeral.stakeTotal) * 100).toFixed(2)
            )
          : 0,
      yield:
        visaoGeral.stakeTotal > 0
          ? Number(
              ((visaoGeral.lucroTotal / visaoGeral.stakeTotal) * 100).toFixed(2)
            )
          : 0,
      winRate:
        visaoGeral.totalFinalizadas > 0
          ? Number(
              ((visaoGeral.totalWins / visaoGeral.totalFinalizadas) * 100).toFixed(2)
            )
          : 0,
    };

    return res.status(200).json({
      filtrosAplicados: {
        status: status || null,
        resultado: resultado || null,
        market: market || null,
        tournament: tournament || null,
        surface: surface || null,
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
      },
      visaoGeral: visaoGeralComMetricas,
      breakdowns: {
        porTorneio,
        porSuperficie,
        porMercado,
        porDia,
        porEscolha,
        porWinner,
      },
    });
  } catch (error) {
    console.error("[APOSTAS-ANALYTICS] Erro ao gerar analytics:", error?.message);

    return res.status(200).json({
      erro: "Erro ao gerar analytics das apostas",
      detalhe: error?.message,
    });
  }
});

// ==========================
// START
// ==========================

app.listen(PORT, () => {
  console.log(`Servidor BeTennis rodando na porta ${PORT}`);
});