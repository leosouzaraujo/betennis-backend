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
    .replace(/-/g, " ")
    .replace(/['`´]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizarTexto(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['`´]/g, "")
    .replace(/[^\w\s/()-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizarTextoBusca(texto) {
  return normalizarNome(texto).replace(/[^a-z0-9\s/]/g, " ").replace(/\s+/g, " ").trim();
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

function montarTimestampSeguro(date, time) {
  if (!date) return 0;

  const iso = `${date}T${time || "00:00"}:00`;
  const ts = new Date(iso).getTime();

  return Number.isFinite(ts) ? ts : 0;
}

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

// ==========================
// LUCRO / APOSTAS
// ==========================

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

// ==========================
// JOGOS / SUPERFÍCIE / STATUS
// ==========================

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

  const nomeTorneio = normalizarNome(jogo?.tournament_name || "");

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
  )
    .trim()
    .toLowerCase();

  const finalResult = String(jogo?.event_final_result || "")
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

  if (finalStatuses.includes(statusOriginal)) {
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
    statusOriginal.includes("postpon")
  ) {
    return "cancelled";
  }

  if (
    finalResult &&
    finalResult !== "-" &&
    finalResult !== "0 - 0" &&
    finalResult !== "0-0"
  ) {
    return "finished";
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

function gerarOddsFallbackEstavel() {
  return null;
}

function normalizarProbabilidadesSemVig(prob1, prob2) {
  const p1 = Number(prob1);
  const p2 = Number(prob2);

  if (!Number.isFinite(p1) || !Number.isFinite(p2) || p1 <= 0 || p2 <= 0) {
    return {
      probabilityPlayer1: null,
      probabilityPlayer2: null,
      overround: null,
    };
  }

  const soma = p1 + p2;

  if (!Number.isFinite(soma) || soma <= 0) {
    return {
      probabilityPlayer1: null,
      probabilityPlayer2: null,
      overround: null,
    };
  }

  return {
    probabilityPlayer1: arredondar(p1 / soma, 4),
    probabilityPlayer2: arredondar(p2 / soma, 4),
    overround: arredondar(soma, 4),
  };
}

function gerarModeloAPartirDasOdds(odds) {
  const probImp1 = calcularProbImplicita(odds?.player1);
  const probImp2 = calcularProbImplicita(odds?.player2);

  const normalizado = normalizarProbabilidadesSemVig(probImp1, probImp2);

  return {
    probabilityPlayer1: normalizado.probabilityPlayer1,
    probabilityPlayer2: normalizado.probabilityPlayer2,
    overround: normalizado.overround,
    source:
      odds?.source && odds?.source !== "fallback-stable"
        ? "market-derived-real"
        : "market-derived",
  };
}

function gerarAnaliseEV(odds, model, confidence) {
  const ev1 = calcularEV(model?.probabilityPlayer1, odds?.player1);
  const ev2 = calcularEV(model?.probabilityPlayer2, odds?.player2);

  let bestSide = null;
  let bestEV = null;

  if (ev1 != null && ev2 != null) {
    if (ev1 >= ev2) {
      bestSide = "player1";
      bestEV = ev1;
    } else {
      bestSide = "player2";
      bestEV = ev2;
    }
  } else if (ev1 != null) {
    bestSide = "player1";
    bestEV = ev1;
  } else if (ev2 != null) {
    bestSide = "player2";
    bestEV = ev2;
  }

  const classificacao = classificarApostaPorEV(bestEV);

  let recommendation = "No Bet";
  if (classificacao.apostar && bestSide === "player1") {
    recommendation = "Apostar Player 1";
  }
  if (classificacao.apostar && bestSide === "player2") {
    recommendation = "Apostar Player 2";
  }

  return {
    player1: ev1,
    player2: ev2,
    bestSide,
    bestEV,
    recommendation,
    noBetZone: !classificacao.apostar,
    label: classificacao.label,
    faixa: classificacao.faixa,
    riskLevel: definirRiskLevel(confidence, bestEV),
  };
}

// ==========================
// BETFAIR
// ==========================

function extrairSobrenome(nome) {
  const limpo = normalizarNome(nome);
  if (!limpo) return "";
  const partes = limpo.split(" ");
  return partes[partes.length - 1] || limpo;
}

function simplificarTokensJogador(nome) {
  const base = normalizarTextoBusca(nome);
  const partes = base.split(" ").filter(Boolean);
  return partes.filter((t) => t.length >= 2);
}

function nomesSaoParecidos(nomeA, nomeB) {
  const a = normalizarNome(nomeA);
  const b = normalizarNome(nomeB);

  if (!a || !b) return false;
  if (a === b) return true;

  const sa = extrairSobrenome(nomeA);
  const sb = extrairSobrenome(nomeB);

  if (sa && sb && sa === sb) {
    const pa = a.split(" ");
    const pb = b.split(" ");
    const inicialA = pa[0]?.[0] || "";
    const inicialB = pb[0]?.[0] || "";
    if (!inicialA || !inicialB || inicialA === inicialB) return true;
  }

  if (a.includes(b) || b.includes(a)) return true;

  return false;
}

function extrairNomesDoEventoBetfair(eventName) {
  const nome = String(eventName || "");
  const separadores = [" v ", " vs ", " @ ", " - "];

  for (const sep of separadores) {
    const regex = new RegExp(sep, "i");
    const partes = nome.split(regex);
    if (partes.length === 2) {
      return {
        player1: partes[0].trim(),
        player2: partes[1].trim(),
      };
    }
  }

  return {
    player1: "",
    player2: "",
  };
}

function matchEventoTenisComBetfair(
  tennisPlayer1,
  tennisPlayer2,
  betfairEventName
) {
  const { player1, player2 } = extrairNomesDoEventoBetfair(betfairEventName);

  if (!player1 || !player2) return false;

  const direto =
    nomesSaoParecidos(tennisPlayer1, player1) &&
    nomesSaoParecidos(tennisPlayer2, player2);

  const invertido =
    nomesSaoParecidos(tennisPlayer1, player2) &&
    nomesSaoParecidos(tennisPlayer2, player1);

  return direto || invertido;
}

async function betfairRpc(method, params) {
  const appKey = process.env.BETFAIR_APP_KEY;
  const sessionToken = process.env.BETFAIR_SESSION_TOKEN;
  const baseUrl =
    process.env.BETFAIR_BASE_URL ||
    "https://api.betfair.bet.br/exchange/betting/json-rpc/v1";

  if (!appKey || !sessionToken) {
    throw new Error("BETFAIR_APP_KEY ou BETFAIR_SESSION_TOKEN não configurados");
  }

  const payload = [
    {
      jsonrpc: "2.0",
      method: `SportsAPING/v1.0/${method}`,
      params,
      id: 1,
    },
  ];

  try {
    const response = await axios.post(baseUrl, payload, {
      headers: {
        "X-Application": appKey,
        "X-Authentication": sessionToken,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    });

    const item = Array.isArray(response.data) ? response.data[0] : response.data;

    if (item?.error) {
      const details = JSON.stringify(item.error);
      throw new Error(`Betfair RPC error: ${details}`);
    }

    return item?.result;
  } catch (error) {
    if (error?.response?.data) {
      console.error(
        "[BETFAIR AXIOS RESPONSE DATA]",
        JSON.stringify(error.response.data, null, 2)
      );
    }
    throw error;
  }
}

async function buscarMercadosTennisBetfairHoje() {
  const agora = new Date();
  const amanha = new Date();
  amanha.setDate(amanha.getDate() + 1);

  const from = agora.toISOString();
  const to = amanha.toISOString();

  const result = await betfairRpc("listMarketCatalogue", {
    filter: {
      eventTypeIds: ["2"],
      marketTypeCodes: ["MATCH_ODDS"],
      marketStartTime: {
        from,
        to,
      },
    },
    marketProjection: ["EVENT", "COMPETITION", "RUNNER_DESCRIPTION", "MARKET_START_TIME"],
    sort: "FIRST_TO_START",
    maxResults: "200",
  });

  return Array.isArray(result) ? result : [];
}

const BETFAIR_BOOK_BATCH_SIZE = 40;

async function betfairListarBooks(marketIds, priceProjection) {
  if (!Array.isArray(marketIds) || marketIds.length === 0) return [];

  const proj = priceProjection || {
    priceData: ["EX_BEST_OFFERS"],
    virtualise: true,
    rolloverStakes: false,
  };

  const resultados = [];

  for (let i = 0; i < marketIds.length; i += BETFAIR_BOOK_BATCH_SIZE) {
    const batch = marketIds.slice(i, i + BETFAIR_BOOK_BATCH_SIZE);
    const batchResult = await betfairRpc("listMarketBook", {
      marketIds: batch,
      priceProjection: proj,
    });
    if (Array.isArray(batchResult)) {
      resultados.push(...batchResult);
    }
  }

  return resultados;
}


// ==========================
// API TENNIS
// ==========================

async function buscarJogosApiTennisHoje() {
  const apiKey = process.env.API_TENNIS_KEY;
  const baseUrl =
    process.env.API_TENNIS_BASE_URL || "https://api.api-tennis.com/tennis/";

  if (!apiKey) {
    throw new Error("API_TENNIS_KEY não configurada");
  }

  const hoje = formatarData(new Date());
  const amanhaDate = new Date();
  amanhaDate.setDate(amanhaDate.getDate() + 1);
  const amanha = formatarData(amanhaDate);

  const response = await axios.get(baseUrl, {
    params: {
      method: "get_fixtures",
      APIkey: apiKey,
      date_start: hoje,
      date_stop: amanha,
    },
    timeout: 20000,
  });

  return Array.isArray(response.data?.result) ? response.data.result : [];
}

// ==========================
// HELPERS - PARTIDAS HOJE
// ==========================

function parseDataHoraPartida(partida) {
  const data = partida?.event_date || partida?.date || null;
  const hora = partida?.event_time || partida?.time || "00:00";

  if (!data) return null;

  const hhmm = /^\d{2}:\d{2}$/.test(hora) ? hora : "00:00";
  const iso = `${data}T${hhmm}:00`;
  const dt = new Date(iso);

  return Number.isNaN(dt.getTime()) ? null : dt;
}

function statusPadronizado(partida) {
  const raw = normalizarTextoBusca(
    partida?.event_status ||
      partida?.status ||
      partida?.match_status ||
      ""
  );

  if (
    raw.includes("finished") ||
    raw.includes("final") ||
    raw.includes("ended") ||
    raw.includes("ft") ||
    raw.includes("retired")
  ) {
    return "finished";
  }

  if (
    raw.includes("live") ||
    raw.includes("in play") ||
    raw.includes("1st set") ||
    raw.includes("2nd set") ||
    raw.includes("3rd set") ||
    raw.includes("set") ||
    raw.includes("interrupted")
  ) {
    return "live";
  }

  if (raw.includes("cancel")) {
    return "cancelled";
  }

  return "scheduled";
}

function scorePadronizado(partida) {
  return (
    partida?.event_final_result ||
    partida?.scores ||
    partida?.score ||
    partida?.ss ||
    ""
  );
}

function obterNomeJogador1(partida) {
  return (
    partida?.event_first_player ||
    partida?.player1 ||
    partida?.home ||
    partida?.home_name ||
    ""
  );
}

function obterNomeJogador2(partida) {
  return (
    partida?.event_second_player ||
    partida?.player2 ||
    partida?.away ||
    partida?.away_name ||
    ""
  );
}

function isDuplas(nome) {
  return String(nome || "").includes("/");
}

function torneiosParecidos(torneioApi, torneioBf) {
  const a = normalizarTextoBusca(torneioApi);
  const b = normalizarTextoBusca(torneioBf);

  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;

  const tokensA = a.split(" ").filter((t) => t.length >= 4);
  const tokensB = b.split(" ").filter((t) => t.length >= 4);

  let comuns = 0;
  for (const t of tokensA) {
    if (tokensB.includes(t)) comuns++;
  }

  return comuns >= 1;
}

function nomesBatem(nomeA, nomeB) {
  const a = normalizarNome(nomeA);
  const b = normalizarNome(nomeB);

  if (!a || !b) return false;
  if (a === b) return true;

  const tokensA = a.split(" ").filter(Boolean);
  const tokensB = b.split(" ").filter(Boolean);

  const sigA = tokensA.filter((t) => t.length >= 3);
  const sigB = tokensB.filter((t) => t.length >= 3);

  if (!sigA.length || !sigB.length) return false;

  const sobrenomeComum = sigA.find((tA) => sigB.includes(tA));
  if (!sobrenomeComum) return false;

  const restA = tokensA.filter((t) => t !== sobrenomeComum);
  const restB = tokensB.filter((t) => t !== sobrenomeComum);

  if (!restA.length || !restB.length) return true;

  const inicialA = (restA.find((t) => t.length === 1) || restA[0])[0];
  const inicialB = (restB.find((t) => t.length === 1) || restB[0])[0];

  return inicialA === inicialB;
}

function nomesEventoParecidos(j1a, j2a, j1b, j2b) {
  const ordemDireta = nomesBatem(j1a, j1b) && nomesBatem(j2a, j2b);
  const ordemInvertida = nomesBatem(j1a, j2b) && nomesBatem(j2a, j1b);
  return ordemDireta || ordemInvertida;
}

function montarIndiceBetfair(mercados, books) {
  return mercados.map((market) => {
    const book = books.find((b) => b.marketId === market.marketId) || null;
    const runners = Array.isArray(market.runners) ? market.runners : [];
    const players = runners.map((runner) => ({
      selectionId: runner.selectionId,
      name: runner.runnerName || "",
    }));

    return {
      marketId: market.marketId || null,
      marketName: market.marketName || null,
      event: market?.event?.name || "",
      competition: market?.competition?.name || "",
      openDate: market?.marketStartTime || market?.event?.openDate || null,
      totalMatched: Number(book?.totalMatched || market?.totalMatched || 0),
      market,
      book,
      players,
    };
  });
}

function encontrarOddsBetfairParaPartida(jogo, indiceBetfair) {
  const player1 = obterNomeJogador1(jogo);
  const player2 = obterNomeJogador2(jogo);
  const torneioJogo = jogo?.tournament_name || "";
  const dataHoraJogo = parseDataHoraPartida(jogo);

  if (!player1 || !player2) return null;

  const jogoEhDuplas = isDuplas(player1) || isDuplas(player2);

  let melhor = null;
  let melhorScore = -1;

  for (const item of indiceBetfair) {
    const eventoBetfair = item.event || "";
    const torneioBetfair = item.competition || "";
    const playersBetfair = item.players || [];
    const book = item.book;
    const market = item.market;

    if (!book || !market || playersBetfair.length < 2) continue;

    const bfP1 = playersBetfair[0]?.name || "";
    const bfP2 = playersBetfair[1]?.name || "";

    const mercadoEhDuplas = isDuplas(bfP1) || isDuplas(bfP2);
    if (jogoEhDuplas !== mercadoEhDuplas) continue;

    const matchDireto = nomesBatem(player1, bfP1) && nomesBatem(player2, bfP2);
    const matchInvertido = nomesBatem(player1, bfP2) && nomesBatem(player2, bfP1);

    if (!matchDireto && !matchInvertido) continue;

    let score = 100;

    if (torneiosParecidos(torneioJogo, torneioBetfair)) {
      score += 20;
    }

    if (dataHoraJogo && item.openDate) {
      const dtBf = new Date(item.openDate);
      if (!Number.isNaN(dtBf.getTime())) {
        const diffMin = Math.abs(dataHoraJogo.getTime() - dtBf.getTime()) / 60000;

        if (diffMin <= 15) score += 20;
        else if (diffMin <= 45) score += 12;
        else if (diffMin <= 90) score += 6;
      }
    }

    const liquidez = Number(item.totalMatched || 0);
    if (liquidez >= 50000) score += 8;
    else if (liquidez >= 10000) score += 5;
    else if (liquidez >= 3000) score += 2;

    let oddPlayer1 = null;
    let oddPlayer2 = null;

    for (const runner of market.runners || []) {
      const bookRunner = book.runners?.find(
        (br) => br.selectionId === runner.selectionId
      );
      const preco = bookRunner?.ex?.availableToBack?.[0]?.price ?? null;
      if (preco == null) continue;

      const runnerNome = runner.runnerName || "";

      if (nomesBatem(player1, runnerNome)) oddPlayer1 = preco;
      else if (nomesBatem(player2, runnerNome)) oddPlayer2 = preco;
    }

    if (oddPlayer1 == null && oddPlayer2 == null) continue;

    if (score > melhorScore) {
      melhorScore = score;
      melhor = {
        player1: oddPlayer1,
        player2: oddPlayer2,
        source: "betfair",
        bookmaker: "Betfair Exchange",
        updatedAt: new Date().toISOString(),
        marketId: market.marketId || null,
        marketName: market.marketName || null,
        eventName: eventoBetfair || null,
        competition: torneioBetfair || null,
        totalMatched: liquidez,
        matchedBy: "betfair-scored-match",
        confidence: score,
      };
    }
  }

  if (!melhor) return null;

  const scoreMinimo = jogoEhDuplas ? 112 : 105;
  if ((melhor.confidence || 0) < scoreMinimo) return null;

  return melhor;
}

function oddsBetfairSaoValidas(match, torneio) {
  if (!match) return false;

  const o1 = Number(match.player1);
  const o2 = Number(match.player2);

  // Ambas as odds devem estar preenchidas e ser válidas
  if (!o1 || !o2 || !Number.isFinite(o1) || !Number.isFinite(o2)) return false;

  // Qualquer lado <= 1.05 — sem valor, mercado fechado ou erro
  if (o1 <= 1.05 || o2 <= 1.05) return false;

  // Desequilíbrio extremo — razão > 6 (ex: 8.6 x 1.12 = 7.7, 15 x 1.05 = 14.3)
  const ratio = Math.max(o1, o2) / Math.min(o1, o2);
  if (ratio > 6) return false;

  const totalMatched = Number(match.totalMatched) || 0;
  const torneioNorm = normalizarNome(torneio || "");

  const ehMinor =
    torneioNorm.includes("itf") ||
    torneioNorm.includes("challenger") ||
    torneioNorm.includes("futures") ||
    torneioNorm.includes("125k") ||
    torneioNorm.includes("75k") ||
    torneioNorm.includes("50k") ||
    torneioNorm.includes("25k");

  const minimoLiquidez = ehMinor ? 1000 : 3000;

  if (totalMatched < minimoLiquidez) return false;

  return true;
}

// ==========================
// ROTA BASE
// ==========================

app.get("/", (_req, res) => {
  res.json({ status: "BeTennis API rodando 🚀" });
});

app.get("/betfair-test", async (_req, res) => {
  try {
    const result = await betfairRpc("listEventTypes", {
      filter: {},
    });

    return res.json({
      ok: true,
      result,
    });
  } catch (err) {
    console.error("[BETFAIR TEST ERROR RAW]", err);

    return res.status(500).json({
      erro: err.message,
      raw: {
        responseData: err?.response?.data || null,
        status: err?.response?.status || null,
      },
    });
  }
});

// ==========================
// BETFAIR - TÊNIS
// ==========================
app.get("/betfair-tennis", async (_req, res) => {
  try {
    const agora = new Date();
    const em7Dias = new Date();
    em7Dias.setDate(em7Dias.getDate() + 7);

    const resultado = await betfairRpc("listMarketCatalogue", {
      filter: {
        eventTypeIds: ["2"],
        marketTypeCodes: ["MATCH_ODDS"],
        marketStartTime: {
          from: agora.toISOString(),
          to: em7Dias.toISOString(),
        },
      },
      marketProjection: [
        "EVENT",
        "EVENT_TYPE",
        "COMPETITION",
        "RUNNER_DESCRIPTION",
        "MARKET_START_TIME",
      ],
      sort: "FIRST_TO_START",
      maxResults: "100",
    });

    const mercados = Array.isArray(resultado) ? resultado : [];

    const jogos = mercados.map((market) => {
      const runners = Array.isArray(market.runners) ? market.runners : [];

      return {
        marketId: market.marketId || null,
        marketName: market.marketName || null,
        totalMatched: market.totalMatched || 0,

        eventType: market.eventType?.name || null,
        competition: market.competition?.name || null,

        event: {
          id: market.event?.id || null,
          name: market.event?.name || null,
          openDate: market.event?.openDate || null,
          venue: market.event?.venue || null,
        },

        players: runners.map((runner) => ({
          selectionId: runner.selectionId || null,
          runnerName: runner.runnerName || null,
          handicap: runner.handicap || 0,
          sortPriority: runner.sortPriority || null,
        })),
      };
    });

    return res.json({
      ok: true,
      total: jogos.length,
      result: jogos,
    });
  } catch (error) {
    console.error("[/betfair-tennis] erro:", error.response?.data || error.message);

    return res.status(500).json({
      ok: false,
      error:
        error.response?.data ||
        error.message ||
        "Erro ao buscar mercados de tênis na Betfair",
    });
  }
});

// ==========================
// BETFAIR - ODDS REAIS
// ==========================
app.get("/betfair-odds", async (_req, res) => {
  try {
    const agora = new Date();
    const em24h = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const mercados = await betfairRpc("listMarketCatalogue", {
      filter: {
        eventTypeIds: ["2"],
        marketTypeCodes: ["MATCH_ODDS"],
        marketStartTime: {
          from: agora.toISOString(),
          to: em24h.toISOString(),
        },
      },
      marketProjection: [
        "EVENT",
        "COMPETITION",
        "RUNNER_DESCRIPTION",
        "MARKET_START_TIME",
      ],
      sort: "FIRST_TO_START",
      maxResults: "200",
    });

    const listaMercados = Array.isArray(mercados) ? mercados : [];

    const marketIds = listaMercados.map((m) => m?.marketId).filter(Boolean);

    if (!marketIds.length) {
      return res.json({
        ok: true,
        total: 0,
        result: [],
      });
    }

    const books = await betfairListarBooks(marketIds, {
      priceData: ["EX_BEST_OFFERS"],
      virtualise: false,
      rolloverStakes: false,
    });

    const listaBooks = Array.isArray(books) ? books : [];

    const resultado = listaMercados
      .filter((market) => marketIds.includes(market.marketId))
      .map((market) => {
        const book = listaBooks.find((b) => b.marketId === market.marketId);

        const runners = Array.isArray(market.runners) ? market.runners : [];
        const bookRunners = Array.isArray(book?.runners) ? book.runners : [];

        const players = runners
          .map((runner) => {
            const bookRunner = bookRunners.find(
              (r) => r.selectionId === runner.selectionId
            );

            const back = bookRunner?.ex?.availableToBack?.[0]?.price ?? null;
            const lay = bookRunner?.ex?.availableToLay?.[0]?.price ?? null;

            if (back == null && lay == null) return null;

            return {
              selectionId: runner.selectionId ?? null,
              name: runner.runnerName || null,
              back,
              lay,
            };
          })
          .filter(Boolean);

        if (players.length < 2) return null;

        return {
          marketId: market.marketId || null,
          marketName: market.marketName || null,
          totalMatched: book?.totalMatched ?? market?.totalMatched ?? 0,
          competition: market.competition?.name || null,
          event: market.event?.name || null,
          openDate: market.marketStartTime || market.event?.openDate || null,
          players,
        };
      })
      .filter(Boolean)
      .filter((m) => {
        if (!m.totalMatched || m.totalMatched < 3000) return false;

        const p1 = m.players?.[0]?.back;
        const p2 = m.players?.[1]?.back;
        const l1 = m.players?.[0]?.lay;
        const l2 = m.players?.[1]?.lay;

        if (!p1 || !p2) return false;
        if (p1 < 1.05 || p2 < 1.05) return false;
        if (p1 > 100 || p2 > 100) return false;
        if (l1 != null && (l1 < 1.01 || l1 > 200)) return false;
        if (l2 != null && (l2 < 1.01 || l2 > 200)) return false;

        return true;
      })
      .sort((a, b) => (b.totalMatched || 0) - (a.totalMatched || 0))
      .slice(0, 15);

    return res.json({
      ok: true,
      total: resultado.length,
      result: resultado,
    });
  } catch (error) {
    console.error(
      "[/betfair-odds] erro:",
      error?.response?.data || error?.message || error
    );

    return res.status(500).json({
      ok: false,
      error:
        error?.response?.data ||
        error?.message ||
        "Erro ao buscar odds reais da Betfair",
    });
  }
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

      if (aposta.probImplicita === undefined) {
        aposta.probImplicita =
          Number(aposta?.odd) > 0
            ? Number((1 / Number(aposta.odd)).toFixed(4))
            : null;
        mudou = true;
      }

      if (aposta.edge === undefined) {
        aposta.edge =
          aposta.probModelo != null && aposta.probImplicita != null
            ? Number(
                (
                  Number(aposta.probModelo) - Number(aposta.probImplicita)
                ).toFixed(4)
              )
            : null;
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
        probImplicita: a.probImplicita,
        edge: a.edge,
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
    modeloVersao = "v1.2.0",
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
// PARTIDAS HOJE (COM BETFAIR AJUSTADO)
// ==========================
app.get("/partidas-hoje", async (_req, res) => {
  try {
    const apiKey = process.env.API_TENNIS_KEY;

    if (!apiKey) {
      return res.status(500).json({
        erro: "API_TENNIS_KEY não configurada",
      });
    }

    const hoje = new Date().toISOString().slice(0, 10);

    const response = await axios.get("https://api.api-tennis.com/tennis/", {
      params: {
        method: "get_fixtures",
        APIkey: apiKey,
        date_start: hoje,
        date_stop: hoje,
      },
      timeout: 20000,
    });

    const jogosApi = Array.isArray(response.data?.result)
      ? response.data.result
      : [];

    // Janela inclui partidas em andamento (2h atrás) e as próximas 30h
    const janelaDe = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const janelaAte = new Date(Date.now() + 30 * 60 * 60 * 1000);

    let indiceBetfair = [];
    try {
      const mercados = await betfairRpc("listMarketCatalogue", {
        filter: {
          eventTypeIds: ["2"],
          marketTypeCodes: ["MATCH_ODDS"],
          marketStartTime: {
            from: janelaDe.toISOString(),
            to: janelaAte.toISOString(),
          },
        },
        marketProjection: [
          "EVENT",
          "COMPETITION",
          "RUNNER_DESCRIPTION",
          "MARKET_START_TIME",
        ],
        sort: "FIRST_TO_START",
        maxResults: "200",
      });

      const listaMercados = Array.isArray(mercados) ? mercados : [];
      const marketIds = listaMercados.map((m) => m.marketId).filter(Boolean);

      let listaBooks = [];
      if (marketIds.length) {
        listaBooks = await betfairListarBooks(marketIds);
      }

      indiceBetfair = montarIndiceBetfair(listaMercados, listaBooks);
    } catch (betfairErr) {
      console.warn("[/partidas-hoje] Betfair indisponível, continuando sem odds:", betfairErr?.message);
    }

    const partidas = jogosApi.map((jogo) => {
      const player1 = obterNomeJogador1(jogo);
      const player2 = obterNomeJogador2(jogo);

      const matchBetfair = encontrarOddsBetfairParaPartida(jogo, indiceBetfair);
      const oddValida = oddsBetfairSaoValidas(matchBetfair, jogo.tournament_name);

      const odds = oddValida
        ? {
            player1: matchBetfair.player1,
            player2: matchBetfair.player2,
            source: "betfair",
            bookmaker: matchBetfair.bookmaker || "Betfair Exchange",
            updatedAt: matchBetfair.updatedAt || null,
            marketId: matchBetfair.marketId || null,
            marketName: matchBetfair.marketName || null,
            eventName: matchBetfair.eventName || null,
            competition: matchBetfair.competition || null,
            totalMatched: matchBetfair.totalMatched || 0,
            confidence: matchBetfair.confidence || 0,
          }
        : {
            player1: null,
            player2: null,
            source: "none",
          };

      const model =
        odds.player1 && odds.player2
          ? gerarModeloAPartirDasOdds(odds)
          : {
              probabilityPlayer1: null,
              probabilityPlayer2: null,
              overround: null,
              source: "none",
            };

      const confidence = odds.source === "betfair"
        ? Math.min(95, (matchBetfair?.confidence || 0))
        : calcularConfiancaBase(jogo);

      const ev =
        odds.player1 && odds.player2
          ? gerarAnaliseEV(odds, model, confidence)
          : {
              player1: null,
              player2: null,
              bestSide: null,
              bestEV: null,
              recommendation: "Sem odds",
              noBetZone: true,
              label: "Sem dados",
              faixa: "indefinida",
              riskLevel: "unknown",
            };

      return {
        id: jogo.event_key,
        player1,
        player2,
        tournament: jogo.tournament_name || null,
        surface: extrairSuperficie(jogo),
        date: jogo.event_date || null,
        time: jogo.event_time || null,
        status: statusPadronizado(jogo),
        statusOriginal: jogo.event_status || "",
        score: scorePadronizado(jogo),
        odds,
        market: {
          name: "MATCH_ODDS",
          source: odds.source,
        },
        model,
        ev,
        metadata: {
          eventId: jogo.event_key || null,
          confidence,
        },
      };
    });

    const aoVivo = [];
    const proximos = [];
    const finalizados = [];

    for (const partida of partidas) {
      if (partida.status === "live") {
        aoVivo.push(partida);
      } else if (partida.status === "finished" || partida.status === "cancelled") {
        finalizados.push(partida);
      } else {
        proximos.push(partida);
      }
    }

    const ordenarPorHorario = (a, b) => {
      const ta = montarTimestampSeguro(a.date, a.time);
      const tb = montarTimestampSeguro(b.date, b.time);
      return ta - tb;
    };

    aoVivo.sort(ordenarPorHorario);
    proximos.sort(ordenarPorHorario);
    finalizados.sort(ordenarPorHorario);

    return res.json({
      resumo: {
        total: partidas.length,
        aoVivo: aoVivo.length,
        proximos: proximos.length,
        finalizados: finalizados.length,
        comOddsBetfair: partidas.filter((p) => p.odds.source === "betfair").length,
      },
      aoVivo,
      proximos,
      finalizados,
      partidas,
    });
  } catch (error) {
    console.error("[/partidas-hoje]", error?.response?.data || error?.message || error);

    return res.status(500).json({
      erro: error?.response?.data || error?.message || "Erro ao buscar partidas de hoje",
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