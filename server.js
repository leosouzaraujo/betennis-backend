require("dotenv").config();

console.log("API KEY:", process.env.API_TENNIS_KEY);

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

function formatarDataLocal(data = new Date()) {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, "0");
  const dia = String(data.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
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

  if (finalStatuses.includes(status)) {
    return true;
  }

  if (jogo?.event_final_result) {
    return true;
  }

  return false;
}

function encontrarJogoDaAposta(jogosApi, aposta) {
  if (aposta?.eventId) {
    const jogoPorId = jogosApi.find(
      (j) => String(j.event_key || "") === String(aposta.eventId)
    );

    if (jogoPorId) {
      return { jogo: jogoPorId, metodo: "eventId" };
    }
  }

  const jogoPorNome = jogosApi.find((j) => {
    const ordemNormal =
      matchJogador(j.event_first_player, aposta.player1) &&
      matchJogador(j.event_second_player, aposta.player2);

    const ordemInvertida =
      matchJogador(j.event_first_player, aposta.player2) &&
      matchJogador(j.event_second_player, aposta.player1);

    return ordemNormal || ordemInvertida;
  });

  if (jogoPorNome) {
    return { jogo: jogoPorNome, metodo: "nomes" };
  }

  return { jogo: null, metodo: null };
}

function logDebug(...args) {
  console.log("[VALIDAR-APOSTAS]", ...args);
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

  res.status(201).json(novaAposta);
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
  if (modeloVersao !== undefined) apostas[index].modeloVersao = modeloVersao;

  const oddAtual = Number(apostas[index].odd) || 0;
  const probImplicita =
    oddAtual > 0 ? Number((1 / oddAtual).toFixed(4)) : null;
  apostas[index].probImplicita = probImplicita;

  apostas[index].edge =
    apostas[index].probModelo != null && probImplicita != null
      ? Number((Number(apostas[index].probModelo) - probImplicita).toFixed(4))
      : null;

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

    const hoje = formatarDataLocal(new Date());

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
        erro: "API_TENNIS_KEY não configurada",
        atualizadas: 0,
        apostas: [],
      });
    }

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

    let apostas = lerApostas();

    const normalizar = (v) =>
      String(v || "")
        .trim()
        .toLowerCase();

    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    const formatarDia = (dataStr) => {
      const d = new Date(dataStr);
      if (isNaN(d.getTime())) return null;
      return d.toISOString().split("T")[0];
    };

    // -------------------------
    // FILTROS
    // -------------------------
    apostas = apostas.filter((a) => {
      if (status && normalizar(a.status) !== normalizar(status)) return false;
      if (resultado && normalizar(a.resultado) !== normalizar(resultado)) return false;
      if (market && normalizar(a.market) !== normalizar(market)) return false;
      if (tournament && normalizar(a.tournament) !== normalizar(tournament)) return false;
      if (surface && normalizar(a.surface) !== normalizar(surface)) return false;

      if (dateFrom || dateTo) {
        const d = new Date(a.createdAt);
        if (isNaN(d.getTime())) return false;

        if (dateFrom) {
          const inicio = new Date(dateFrom);
          if (!isNaN(inicio.getTime()) && d < inicio) return false;
        }

        if (dateTo) {
          const fim = new Date(dateTo);
          if (!isNaN(fim.getTime())) {
            fim.setHours(23, 59, 59, 999);
            if (d > fim) return false;
          }
        }
      }

      return true;
    });

    // -------------------------
    // BASE
    // -------------------------
    const finalizadas = apostas.filter((a) => a.status === "finalizada");
    const pendentes = apostas.filter((a) => a.status !== "finalizada");

    const wins = finalizadas.filter((a) => a.resultado === "win");
    const losses = finalizadas.filter((a) => a.resultado === "loss");

    const stakeTotal = finalizadas.reduce((acc, a) => acc + num(a.stake), 0);
    const lucroTotal = finalizadas.reduce((acc, a) => acc + num(a.lucro), 0);

    const winRate =
      finalizadas.length > 0 ? (wins.length / finalizadas.length) * 100 : 0;

    const roi =
      stakeTotal > 0 ? (lucroTotal / stakeTotal) * 100 : 0;

    // -------------------------
    // AGRUPADORES
    // -------------------------
    const agrupar = (lista, campo, fallback) => {
      const map = {};

      lista.forEach((a) => {
        const chave = a[campo] || fallback;

        if (!map[chave]) {
          map[chave] = {
            nome: chave,
            totalApostas: 0,
            stakeTotal: 0,
            lucroTotal: 0,
            wins: 0,
            losses: 0,
          };
        }

        map[chave].totalApostas++;
        map[chave].stakeTotal += num(a.stake);
        map[chave].lucroTotal += num(a.lucro);

        if (a.resultado === "win") map[chave].wins++;
        if (a.resultado === "loss") map[chave].losses++;
      });

      return Object.values(map).map((item) => {
        const winRate =
          item.totalApostas > 0
            ? (item.wins / item.totalApostas) * 100
            : 0;

        const roi =
          item.stakeTotal > 0
            ? (item.lucroTotal / item.stakeTotal) * 100
            : 0;

        return {
          ...item,
          winRate: Number(winRate.toFixed(2)),
          roi: Number(roi.toFixed(2)),
        };
      });
    };

    const porMercado = agrupar(finalizadas, "market", "Sem mercado").map(
      (i) => ({
        market: i.nome,
        totalApostas: i.totalApostas,
        wins: i.wins,
        losses: i.losses,
        winRate: i.winRate,
        lucroTotal: Number(i.lucroTotal.toFixed(2)),
        roi: i.roi,
      })
    );

    const porTorneio = agrupar(finalizadas, "tournament", "Sem torneio").map(
      (i) => ({
        tournament: i.nome,
        totalApostas: i.totalApostas,
        lucroTotal: Number(i.lucroTotal.toFixed(2)),
        roi: i.roi,
      })
    );

    const porSuperficie = agrupar(finalizadas, "surface", "Sem superfície").map(
      (i) => ({
        surface: i.nome,
        totalApostas: i.totalApostas,
        lucroTotal: Number(i.lucroTotal.toFixed(2)),
        roi: i.roi,
      })
    );

    // -------------------------
    // PNL POR DATA
    // -------------------------
    const mapa = {};

    finalizadas.forEach((a) => {
      const dia = formatarDia(a.createdAt);
      if (!dia) return;

      if (!mapa[dia]) mapa[dia] = 0;
      mapa[dia] += num(a.lucro);
    });

    const datas = Object.keys(mapa).sort();

    let acumulado = 0;

    const pnlPorData = datas.map((date) => {
      const lucro = Number(mapa[date].toFixed(2));
      acumulado += lucro;

      return {
        date,
        lucro,
        acumulado: Number(acumulado.toFixed(2)),
      };
    });

    // -------------------------
    // RESPONSE
    // -------------------------
    res.json({
      filtrosAplicados: {
        status: status || null,
        resultado: resultado || null,
        market: market || null,
        tournament: tournament || null,
        surface: surface || null,
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
      },
      visaoGeral: {
        totalApostas: apostas.length,
        totalFinalizadas: finalizadas.length,
        totalPendentes: pendentes.length,
        totalWins: wins.length,
        totalLosses: losses.length,
        winRate: Number(winRate.toFixed(2)),
        stakeTotal: Number(stakeTotal.toFixed(2)),
        lucroTotal: Number(lucroTotal.toFixed(2)),
        roi: Number(roi.toFixed(2)),
      },
      porMercado,
      porTorneio,
      porSuperficie,
      pnlPorData,
    });
  } catch (err) {
    console.error("Erro /apostas-analytics:", err.message);

    res.status(500).json({
      erro: "Erro ao gerar analytics",
    });
  }
});

    const apostas = lerApostas();

    logDebug("Iniciando validação...");
    logDebug("Apostas carregadas:", apostas.length);

    const atualizadas = [];
    const naoEncontradas = [];
    const pendentes = [];
    const jaResolvidas = [];

    let totalJogosApi = 0;

    for (const aposta of apostas) {
      logDebug("--------------------------------------------------");
      logDebug("Analisando aposta:", {
        id: aposta.id,
        eventId: aposta.eventId || null,
        player1: aposta.player1,
        player2: aposta.player2,
        escolha: aposta.escolha,
        status: aposta.status,
        resultado: aposta.resultado,
        createdAt: aposta.createdAt || null,
      });

      if (
        aposta.resultado === "win" ||
        aposta.resultado === "loss" ||
        aposta.resultado === "void"
      ) {
        aposta.lucro = calcularLucro(aposta);
        jaResolvidas.push(aposta.id);
        logDebug("Aposta já resolvida. Mantendo resultado:", aposta.resultado);
        continue;
      }

      const dataBase = aposta.createdAt ? new Date(aposta.createdAt) : new Date();

      const dataInicio = new Date(dataBase);
      dataInicio.setDate(dataInicio.getDate() - 1);

      const dataFim = new Date(dataBase);
      dataFim.setDate(dataFim.getDate() + 7);

      const dateStart = formatarDataLocal(dataInicio);
      const dateStop = formatarDataLocal(dataFim);

      logDebug("Janela da aposta:", dateStart, "até", dateStop);

      const response = await axios.get("https://api.api-tennis.com/tennis/", {
        params: {
          method: "get_fixtures",
          APIkey: apiKey,
          date_start: dateStart,
          date_stop: dateStop,
        },
        timeout: 15000,
      });

      const jogosApi = Array.isArray(response.data?.result) ? response.data.result : [];
      totalJogosApi += jogosApi.length;

      logDebug("Jogos retornados nesta janela:", jogosApi.length);

      const { jogo, metodo } = encontrarJogoDaAposta(jogosApi, aposta);

      if (!jogo) {
        const similares = jogosApi
          .filter((j) => {
            const p1 = normalizarNome(aposta.player1);
            const p2 = normalizarNome(aposta.player2);
            const j1 = normalizarNome(j.event_first_player);
            const j2 = normalizarNome(j.event_second_player);

            return (
              j1.includes(p1.split(" ").slice(-1)[0]) ||
              j2.includes(p1.split(" ").slice(-1)[0]) ||
              j1.includes(p2.split(" ").slice(-1)[0]) ||
              j2.includes(p2.split(" ").slice(-1)[0])
            );
          })
          .slice(0, 5)
          .map((j) => ({
            event_key: j.event_key || null,
            player1: j.event_first_player || null,
            player2: j.event_second_player || null,
            status: j.event_status || null,
            score: j.event_final_result || null,
            date: j.event_date || null,
          }));

        aposta.lucro = calcularLucro(aposta);

        naoEncontradas.push({
          id: aposta.id,
          player1: aposta.player1,
          player2: aposta.player2,
          escolha: aposta.escolha,
          janelaBuscada: {
            inicio: dateStart,
            fim: dateStop,
          },
          similares,
        });

        logDebug("Jogo não encontrado para a aposta.");
        logDebug("Possíveis jogos parecidos:", similares);

        continue;
      }

      logDebug("Jogo encontrado via:", metodo);
      logDebug("Dados do jogo:", {
        event_key: jogo.event_key || null,
        jogador1: jogo.event_first_player || null,
        jogador2: jogo.event_second_player || null,
        status: jogo.event_status || null,
        resultadoFinal: jogo.event_final_result || null,
        torneio: jogo.tournament_name || null,
        data: jogo.event_date || null,
        hora: jogo.event_time || null,
      });

      if (!isJogoFinalizado(jogo)) {
        aposta.lucro = calcularLucro(aposta);

        pendentes.push({
          id: aposta.id,
          statusApi: jogo.event_status || null,
          resultadoApi: jogo.event_final_result || null,
          player1: aposta.player1,
          player2: aposta.player2,
          janelaBuscada: {
            inicio: dateStart,
            fim: dateStop,
          },
        });

        logDebug("Jogo encontrado, mas ainda não finalizado.");
        logDebug("Status recebido:", jogo.event_status || "(vazio)");
        logDebug("Placar recebido:", jogo.event_final_result || "(vazio)");
        continue;
      }

      const vencedor = extrairVencedorDoResultado(jogo);

      aposta.status = "finalizada";
      aposta.score = jogo.event_final_result || null;
      aposta.winner = vencedor || null;
      aposta.eventId = aposta.eventId || jogo.event_key || null;

      logDebug("Jogo finalizado.");
      logDebug("Score final:", aposta.score);
      logDebug("Vencedor extraído:", vencedor || "(não identificado)");

      if (!vencedor) {
        aposta.resultado = "void";
        aposta.lucro = calcularLucro(aposta);
        aposta.updatedAt = new Date().toISOString();
        atualizadas.push({ ...aposta });

        logDebug("Não foi possível identificar vencedor. Resultado definido como VOID.");
        continue;
      }

      aposta.resultado =
        normalizarNome(aposta.escolha) === normalizarNome(vencedor)
          ? "win"
          : "loss";

      aposta.lucro = calcularLucro(aposta);
      aposta.updatedAt = new Date().toISOString();

      atualizadas.push({ ...aposta });

      logDebug("Resultado final da aposta:", aposta.resultado);
      logDebug("Lucro calculado:", aposta.lucro);
    }

    const apostasComLucro = apostas.map(atualizarLucroAposta);
    salvarApostas(apostasComLucro);

    const resumo = {
      totalApostas: apostas.length,
      totalJogosApi,
      atualizadas: atualizadas.length,
      jaResolvidas: jaResolvidas.length,
      naoEncontradas: naoEncontradas.length,
      pendentes: pendentes.length,
    };

    logDebug("==================================================");
    logDebug("Resumo final:", resumo);

    return res.status(200).json({
      mensagem: "Validação concluída",
      resumo,
      atualizadas: atualizadas.length,
      apostas: atualizadas.map(atualizarLucroAposta),
      diagnostico: {
        naoEncontradas,
        pendentes,
      },
    });
  } catch (error) {
    console.error(
      "[VALIDAR-APOSTAS] Erro ao validar apostas:",
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

    app.get("/validar-apostas", async (req, res) => {
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

    logDebug("Iniciando validação...");
    logDebug("Apostas carregadas:", apostas.length);

    const atualizadas = [];
    const naoEncontradas = [];
    const pendentes = [];
    const jaResolvidas = [];

    let totalJogosApi = 0;

    for (const aposta of apostas) {
      logDebug("--------------------------------------------------");
      logDebug("Analisando aposta:", {
        id: aposta.id,
        eventId: aposta.eventId || null,
        player1: aposta.player1,
        player2: aposta.player2,
        escolha: aposta.escolha,
        status: aposta.status,
        resultado: aposta.resultado,
        createdAt: aposta.createdAt || null,
      });

      if (
        aposta.resultado === "win" ||
        aposta.resultado === "loss" ||
        aposta.resultado === "void"
      ) {
        aposta.lucro = calcularLucro(aposta);
        jaResolvidas.push(aposta.id);
        logDebug("Aposta já resolvida. Mantendo resultado:", aposta.resultado);
        continue;
      }

      const dataBase = aposta.createdAt ? new Date(aposta.createdAt) : new Date();

      const dataInicio = new Date(dataBase);
      dataInicio.setDate(dataInicio.getDate() - 1);

      const dataFim = new Date(dataBase);
      dataFim.setDate(dataFim.getDate() + 7);

      const dateStart = formatarDataLocal(dataInicio);
      const dateStop = formatarDataLocal(dataFim);

      logDebug("Janela da aposta:", dateStart, "até", dateStop);

      const response = await axios.get("https://api.api-tennis.com/tennis/", {
        params: {
          method: "get_fixtures",
          APIkey: apiKey,
          date_start: dateStart,
          date_stop: dateStop,
        },
        timeout: 15000,
      });

      const jogosApi = Array.isArray(response.data?.result) ? response.data.result : [];
      totalJogosApi += jogosApi.length;

      logDebug("Jogos retornados nesta janela:", jogosApi.length);

      const { jogo, metodo } = encontrarJogoDaAposta(jogosApi, aposta);

      if (!jogo) {
        const similares = jogosApi
          .filter((j) => {
            const p1 = normalizarNome(aposta.player1);
            const p2 = normalizarNome(aposta.player2);
            const j1 = normalizarNome(j.event_first_player);
            const j2 = normalizarNome(j.event_second_player);

            return (
              j1.includes(p1.split(" ").slice(-1)[0]) ||
              j2.includes(p1.split(" ").slice(-1)[0]) ||
              j1.includes(p2.split(" ").slice(-1)[0]) ||
              j2.includes(p2.split(" ").slice(-1)[0])
            );
          })
          .slice(0, 5)
          .map((j) => ({
            event_key: j.event_key || null,
            player1: j.event_first_player || null,
            player2: j.event_second_player || null,
            status: j.event_status || null,
            score: j.event_final_result || null,
            date: j.event_date || null,
          }));

        aposta.lucro = calcularLucro(aposta);

        naoEncontradas.push({
          id: aposta.id,
          player1: aposta.player1,
          player2: aposta.player2,
          escolha: aposta.escolha,
          janelaBuscada: {
            inicio: dateStart,
            fim: dateStop,
          },
          similares,
        });

        logDebug("Jogo não encontrado para a aposta.");
        logDebug("Possíveis jogos parecidos:", similares);

        continue;
      }

      logDebug("Jogo encontrado via:", metodo);
      logDebug("Dados do jogo:", {
        event_key: jogo.event_key || null,
        jogador1: jogo.event_first_player || null,
        jogador2: jogo.event_second_player || null,
        status: jogo.event_status || null,
        resultadoFinal: jogo.event_final_result || null,
        torneio: jogo.tournament_name || null,
        data: jogo.event_date || null,
        hora: jogo.event_time || null,
      });

      if (!isJogoFinalizado(jogo)) {
        aposta.lucro = calcularLucro(aposta);

        pendentes.push({
          id: aposta.id,
          statusApi: jogo.event_status || null,
          resultadoApi: jogo.event_final_result || null,
          player1: aposta.player1,
          player2: aposta.player2,
          janelaBuscada: {
            inicio: dateStart,
            fim: dateStop,
          },
        });

        logDebug("Jogo encontrado, mas ainda não finalizado.");
        logDebug("Status recebido:", jogo.event_status || "(vazio)");
        logDebug("Placar recebido:", jogo.event_final_result || "(vazio)");
        continue;
      }

      const vencedor = extrairVencedorDoResultado(jogo);

      aposta.status = "finalizada";
      aposta.score = jogo.event_final_result || null;
      aposta.winner = vencedor || null;
      aposta.eventId = aposta.eventId || jogo.event_key || null;

      logDebug("Jogo finalizado.");
      logDebug("Score final:", aposta.score);
      logDebug("Vencedor extraído:", vencedor || "(não identificado)");

      if (!vencedor) {
        aposta.resultado = "void";
        aposta.lucro = calcularLucro(aposta);
        aposta.updatedAt = new Date().toISOString();
        atualizadas.push({ ...aposta });

        logDebug("Não foi possível identificar vencedor. Resultado definido como VOID.");
        continue;
      }

      aposta.resultado =
        normalizarNome(aposta.escolha) === normalizarNome(vencedor)
          ? "win"
          : "loss";

      aposta.lucro = calcularLucro(aposta);
      aposta.updatedAt = new Date().toISOString();

      atualizadas.push({ ...aposta });

      logDebug("Resultado final da aposta:", aposta.resultado);
      logDebug("Lucro calculado:", aposta.lucro);
    }

    const apostasComLucro = apostas.map(atualizarLucroAposta);
    salvarApostas(apostasComLucro);

    const resumo = {
      totalApostas: apostas.length,
      totalJogosApi,
      atualizadas: atualizadas.length,
      jaResolvidas: jaResolvidas.length,
      naoEncontradas: naoEncontradas.length,
      pendentes: pendentes.length,
    };

    logDebug("==================================================");
    logDebug("Resumo final:", resumo);

    return res.status(200).json({
      mensagem: "Validação concluída",
      resumo,
      atualizadas: atualizadas.length,
      apostas: atualizadas.map(atualizarLucroAposta),
      diagnostico: {
        naoEncontradas,
        pendentes,
      },
    });
  } catch (error) {
    console.error(
      "[VALIDAR-APOSTAS] Erro ao validar apostas:",
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

app.get("/backfill-apostas", async (req, res) => {
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

    logDebug("Iniciando backfill histórico...");
    logDebug("Apostas carregadas:", apostas.length);

    const atualizadas = [];
    const naoEncontradas = [];
    const ignoradas = [];

    let totalJogosApi = 0;

    for (const aposta of apostas) {
      logDebug("--------------------------------------------------");
      logDebug("Analisando aposta para backfill:", {
        id: aposta.id,
        eventId: aposta.eventId || null,
        player1: aposta.player1,
        player2: aposta.player2,
        escolha: aposta.escolha,
        status: aposta.status,
        resultado: aposta.resultado,
        createdAt: aposta.createdAt || null,
        winner: aposta.winner || null,
        score: aposta.score || null,
      });

      const precisaBackfill =
        (aposta.resultado === "win" ||
          aposta.resultado === "loss" ||
          aposta.resultado === "void") &&
        (!aposta.winner || !aposta.score || !aposta.eventId);

      if (!precisaBackfill) {
        ignoradas.push({
          id: aposta.id,
          motivo: "Aposta já completa ou ainda pendente",
        });
        continue;
      }

      const dataBase = aposta.createdAt ? new Date(aposta.createdAt) : new Date();

      const dataInicio = new Date(dataBase);
      dataInicio.setDate(dataInicio.getDate() - 3);

      const dataFim = new Date(dataBase);
      dataFim.setDate(dataFim.getDate() + 10);

      const dateStart = formatarDataLocal(dataInicio);
      const dateStop = formatarDataLocal(dataFim);

      logDebug("Janela do backfill:", dateStart, "até", dateStop);

      const response = await axios.get("https://api.api-tennis.com/tennis/", {
        params: {
          method: "get_fixtures",
          APIkey: apiKey,
          date_start: dateStart,
          date_stop: dateStop,
        },
        timeout: 15000,
      });

      const jogosApi = Array.isArray(response.data?.result) ? response.data.result : [];
      totalJogosApi += jogosApi.length;

      logDebug("Jogos retornados nesta janela:", jogosApi.length);

      const { jogo, metodo } = encontrarJogoDaAposta(jogosApi, aposta);

      if (!jogo) {
        const similares = jogosApi
          .filter((j) => {
            const p1 = normalizarNome(aposta.player1);
            const p2 = normalizarNome(aposta.player2);
            const j1 = normalizarNome(j.event_first_player);
            const j2 = normalizarNome(j.event_second_player);

            return (
              j1.includes(p1.split(" ").slice(-1)[0]) ||
              j2.includes(p1.split(" ").slice(-1)[0]) ||
              j1.includes(p2.split(" ").slice(-1)[0]) ||
              j2.includes(p2.split(" ").slice(-1)[0])
            );
          })
          .slice(0, 5)
          .map((j) => ({
            event_key: j.event_key || null,
            player1: j.event_first_player || null,
            player2: j.event_second_player || null,
            status: j.event_status || null,
            score: j.event_final_result || null,
            date: j.event_date || null,
          }));

        naoEncontradas.push({
          id: aposta.id,
          player1: aposta.player1,
          player2: aposta.player2,
          escolha: aposta.escolha,
          janelaBuscada: {
            inicio: dateStart,
            fim: dateStop,
          },
          similares,
        });

        logDebug("Jogo não encontrado no backfill.");
        logDebug("Possíveis jogos parecidos:", similares);

        continue;
      }

      logDebug("Jogo encontrado via:", metodo);
      logDebug("Dados do jogo:", {
        event_key: jogo.event_key || null,
        jogador1: jogo.event_first_player || null,
        jogador2: jogo.event_second_player || null,
        status: jogo.event_status || null,
        resultadoFinal: jogo.event_final_result || null,
        torneio: jogo.tournament_name || null,
        data: jogo.event_date || null,
        hora: jogo.event_time || null,
      });

      const vencedor = extrairVencedorDoResultado(jogo);

      if (!aposta.score && jogo.event_final_result) {
        aposta.score = jogo.event_final_result;
      }

      if (!aposta.winner && vencedor) {
        aposta.winner = vencedor;
      }

      if (!aposta.eventId && jogo.event_key) {
        aposta.eventId = jogo.event_key;
      }

      aposta.updatedAt = new Date().toISOString();
      aposta.lucro = calcularLucro(aposta);

      atualizadas.push({ ...aposta });

      logDebug("Backfill aplicado com sucesso:", {
        id: aposta.id,
        eventId: aposta.eventId || null,
        winner: aposta.winner || null,
        score: aposta.score || null,
      });
    }

    salvarApostas(apostas);

    const resumo = {
      totalApostas: apostas.length,
      totalJogosApi,
      atualizadas: atualizadas.length,
      ignoradas: ignoradas.length,
      naoEncontradas: naoEncontradas.length,
    };

    logDebug("==================================================");
    logDebug("Resumo final do backfill:", resumo);

    return res.status(200).json({
      mensagem: "Backfill concluído",
      resumo,
      atualizadas: atualizadas.length,
      apostas: atualizadas,
      diagnostico: {
        naoEncontradas,
        ignoradas,
      },
    });
  } catch (error) {
    console.error(
      "[BACKFILL-APOSTAS] Erro ao executar backfill:",
      error.response?.data || error.message
    );

    return res.status(200).json({
      erro: "Erro ao executar backfill",
      detalhe: error.response?.data || error.message,
      atualizadas: 0,
      apostas: [],
    });
  }
});

app.get("/reconciliar-apostas", (req, res) => {
  try {
    const apostas = lerApostas();
    const atualizadas = [];
    const ignoradas = [];

    for (const aposta of apostas) {
      const temDadosSuficientes =
        aposta &&
        aposta.escolha &&
        aposta.winner &&
        (
          aposta.resultado === "win" ||
          aposta.resultado === "loss" ||
          aposta.resultado === "void" ||
          aposta.status === "finalizada"
        );

      if (!temDadosSuficientes) {
        ignoradas.push({
          id: aposta.id,
          motivo: "Sem dados suficientes para reconciliar",
        });
        continue;
      }

      let novoResultado = "void";

      if (matchJogador(aposta.winner, aposta.escolha)) {
        novoResultado = "win";
      } else {
        novoResultado = "loss";
      }

      const resultadoAnterior = aposta.resultado;
      const lucroAnterior = Number(aposta.lucro || 0);

      aposta.status = "finalizada";
      aposta.resultado = novoResultado;
      aposta.lucro = calcularLucro(aposta);
      aposta.updatedAt = new Date().toISOString();

      if (
        resultadoAnterior !== aposta.resultado ||
        lucroAnterior !== Number(aposta.lucro)
      ) {
        atualizadas.push({
          id: aposta.id,
          escolha: aposta.escolha,
          winner: aposta.winner,
          resultadoAnterior,
          resultadoNovo: aposta.resultado,
          lucroAnterior,
          lucroNovo: aposta.lucro,
        });
      } else {
        ignoradas.push({
          id: aposta.id,
          motivo: "Já estava consistente",
        });
      }
    }

    salvarApostas(apostas);

    return res.status(200).json({
      mensagem: "Reconciliação concluída",
      resumo: {
        totalApostas: apostas.length,
        atualizadas: atualizadas.length,
        ignoradas: ignoradas.length,
      },
      atualizadas,
      ignoradas,
    });
  } catch (error) {
    console.error(
      "[RECONCILIAR-APOSTAS] Erro ao reconciliar apostas:",
      error.message
    );

    return res.status(200).json({
      erro: "Erro ao reconciliar apostas",
      detalhe: error.message,
      atualizadas: [],
      ignoradas: [],
    });
  }
});

app.get("/resumo-apostas", (req, res) => {
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
      apostas = apostas.filter(
        (a) => normalizarNome(a.status) === statusNorm
      );
    }

    if (resultado) {
      const resultadoNorm = normalizarNome(resultado);
      apostas = apostas.filter(
        (a) => normalizarNome(a.resultado) === resultadoNorm
      );
    }

    if (market) {
      const marketNorm = normalizarNome(market);
      apostas = apostas.filter(
        (a) => normalizarNome(a.market) === marketNorm
      );
    }

    if (tournament) {
      const tournamentNorm = normalizarNome(tournament);
      apostas = apostas.filter(
        (a) => normalizarNome(a.tournament) === tournamentNorm
      );
    }

    if (surface) {
      const surfaceNorm = normalizarNome(surface);
      apostas = apostas.filter(
        (a) => normalizarNome(a.surface) === surfaceNorm
      );
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
    const pendentes = apostas.filter((a) => a.status !== "finalizada");

    const wins = finalizadas.filter((a) => a.resultado === "win");
    const losses = finalizadas.filter((a) => a.resultado === "loss");
    const voids = finalizadas.filter((a) => a.resultado === "void");

    const totalApostas = apostas.length;
    const totalFinalizadas = finalizadas.length;
    const totalPendentes = pendentes.length;

    const totalStake = apostas.reduce(
      (acc, a) => acc + (Number(a.stake) || 0),
      0
    );

    const stakeFinalizado = finalizadas.reduce(
      (acc, a) => acc + (Number(a.stake) || 0),
      0
    );

    const lucroTotal = finalizadas.reduce(
      (acc, a) => acc + (Number(a.lucro) || 0),
      0
    );

    const roi =
      stakeFinalizado > 0
        ? Number(((lucroTotal / stakeFinalizado) * 100).toFixed(2))
        : 0;

    const winRate =
      totalFinalizadas > 0
        ? Number(((wins.length / totalFinalizadas) * 100).toFixed(2))
        : 0;

    const oddMedia =
      apostas.length > 0
        ? Number(
            (
              apostas.reduce((acc, a) => acc + (Number(a.odd) || 0), 0) /
              apostas.length
            ).toFixed(2)
          )
        : 0;

    const oddMediaWins =
      wins.length > 0
        ? Number(
            (
              wins.reduce((acc, a) => acc + (Number(a.odd) || 0), 0) /
              wins.length
            ).toFixed(2)
          )
        : 0;

    const lucroMedioPorAposta =
      totalFinalizadas > 0
        ? Number((lucroTotal / totalFinalizadas).toFixed(2))
        : 0;

    const resumo = {
      filtrosAplicados: {
        status: status || null,
        resultado: resultado || null,
        market: market || null,
        tournament: tournament || null,
        surface: surface || null,
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
      },
      totalApostas,
      totalFinalizadas,
      totalPendentes,
      totalWins: wins.length,
      totalLosses: losses.length,
      totalVoids: voids.length,
      totalStake: Number(totalStake.toFixed(2)),
      stakeFinalizado: Number(stakeFinalizado.toFixed(2)),
      lucroTotal: Number(lucroTotal.toFixed(2)),
      roi,
      winRate,
      oddMedia,
      oddMediaWins,
      lucroMedioPorAposta,
    };

    return res.status(200).json(resumo);
  } catch (error) {
    console.error("[RESUMO-APOSTAS] Erro ao gerar resumo:", error.message);

    return res.status(200).json({
      erro: "Erro ao gerar resumo das apostas",
      detalhe: error.message,
    });
  }
});

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
      apostas = apostas.filter(
        (a) => normalizarNome(a.status) === statusNorm
      );
    }

    if (resultado) {
      const resultadoNorm = normalizarNome(resultado);
      apostas = apostas.filter(
        (a) => normalizarNome(a.resultado) === resultadoNorm
      );
    }

    if (market) {
      const marketNorm = normalizarNome(market);
      apostas = apostas.filter(
        (a) => normalizarNome(a.market) === marketNorm
      );
    }

    if (tournament) {
      const tournamentNorm = normalizarNome(tournament);
      apostas = apostas.filter(
        (a) => normalizarNome(a.tournament) === tournamentNorm
      );
    }

    if (surface) {
      const surfaceNorm = normalizarNome(surface);
      apostas = apostas.filter(
        (a) => normalizarNome(a.surface) === surfaceNorm
      );
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
            oddMedia: 0,
            roi: 0,
            winRate: 0,
          };
        }

        mapa[chave].totalApostas += 1;
        mapa[chave].stakeTotal += Number(aposta.stake) || 0;
        mapa[chave].oddMedia += Number(aposta.odd) || 0;

        if (aposta.status === "finalizada") {
          mapa[chave].finalizadas += 1;
          mapa[chave].lucroTotal += Number(aposta.lucro) || 0;

          if (aposta.resultado === "win") mapa[chave].wins += 1;
          if (aposta.resultado === "loss") mapa[chave].losses += 1;
          if (aposta.resultado === "void") mapa[chave].voids += 1;
        }
      }

      return Object.values(mapa)
        .map((item) => {
          item.stakeTotal = Number(item.stakeTotal.toFixed(2));
          item.lucroTotal = Number(item.lucroTotal.toFixed(2));
          item.oddMedia =
            item.totalApostas > 0
              ? Number((item.oddMedia / item.totalApostas).toFixed(2))
              : 0;
          item.roi =
            item.stakeTotal > 0
              ? Number(((item.lucroTotal / item.stakeTotal) * 100).toFixed(2))
              : 0;
          item.winRate =
            item.finalizadas > 0
              ? Number(((item.wins / item.finalizadas) * 100).toFixed(2))
              : 0;

          return item;
        })
        .sort((a, b) => b.lucroTotal - a.lucroTotal);
    }

    const porTorneio = agruparPor(apostas, (a) => a.tournament || "Sem torneio");
    const porSuperficie = agruparPor(apostas, (a) => a.surface || "Sem superfície");
    const porMercado = agruparPor(apostas, (a) => a.market || "Sem mercado");
    const porEscolha = agruparPor(apostas, (a) => a.escolha || "Sem escolha");
    const porWinner = agruparPor(finalizadas, (a) => a.winner || "Sem winner");

    const porDia = agruparPor(apostas, (a) => {
      if (!a.createdAt) return "Sem data";
      return new Date(a.createdAt).toISOString().slice(0, 10);
    });

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
    };

    visaoGeral.roi =
      visaoGeral.stakeTotal > 0
        ? Number(((visaoGeral.lucroTotal / visaoGeral.stakeTotal) * 100).toFixed(2))
        : 0;

    visaoGeral.winRate =
      visaoGeral.totalFinalizadas > 0
        ? Number(((visaoGeral.totalWins / visaoGeral.totalFinalizadas) * 100).toFixed(2))
        : 0;

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
      visaoGeral,
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
    console.error("[APOSTAS-ANALYTICS] Erro ao gerar analytics:", error.message);

    return res.status(200).json({
      erro: "Erro ao gerar analytics das apostas",
      detalhe: error.message,
    });
  }
});

app.get("/backfill-metadados-apostas", async (req, res) => {
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
    const naoEncontradas = [];
    const ignoradas = [];

    for (const aposta of apostas) {
      const precisaBackfill =
        !aposta.tournament || !aposta.surface || !aposta.market;

      if (!precisaBackfill) {
        ignoradas.push({
          id: aposta.id,
          motivo: "Metadados já preenchidos",
        });
        continue;
      }

      const dataBase = aposta.createdAt ? new Date(aposta.createdAt) : new Date();

      const dataInicio = new Date(dataBase);
      dataInicio.setDate(dataInicio.getDate() - 3);

      const dataFim = new Date(dataBase);
      dataFim.setDate(dataFim.getDate() + 10);

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

      const jogosApi = Array.isArray(response.data?.result) ? response.data.result : [];
      const { jogo } = encontrarJogoDaAposta(jogosApi, aposta);

      if (!jogo) {
        naoEncontradas.push({
          id: aposta.id,
          player1: aposta.player1,
          player2: aposta.player2,
          dateStart,
          dateStop,
        });
        continue;
      }

      const tournamentApi =
        jogo.tournament_name ||
        jogo.league_name ||
        aposta.tournament ||
        null;

      const surfaceApi =
        jogo.event_surface ||
        jogo.surface ||
        jogo.tournament_surface ||
        aposta.surface ||
        null;

      const marketPadrao = aposta.market || "match_winner";

      let mudou = false;

      if (!aposta.tournament && tournamentApi) {
        aposta.tournament = tournamentApi;
        mudou = true;
      }

      if (!aposta.surface && surfaceApi) {
        aposta.surface = surfaceApi;
        mudou = true;
      }

      if (!aposta.market && marketPadrao) {
        aposta.market = marketPadrao;
        mudou = true;
      }

      if (mudou) {
        aposta.updatedAt = new Date().toISOString();
        atualizadas.push({
          id: aposta.id,
          tournament: aposta.tournament || null,
          surface: aposta.surface || null,
          market: aposta.market || null,
        });
      } else {
        ignoradas.push({
          id: aposta.id,
          motivo: "Jogo encontrado, mas sem novos metadados",
        });
      }
    }

    salvarApostas(apostas);

    return res.status(200).json({
      mensagem: "Backfill de metadados concluído",
      resumo: {
        totalApostas: apostas.length,
        atualizadas: atualizadas.length,
        ignoradas: ignoradas.length,
        naoEncontradas: naoEncontradas.length,
      },
      apostas: atualizadas,
      diagnostico: {
        ignoradas,
        naoEncontradas,
      },
    });
  } catch (error) {
    console.error(
      "[BACKFILL-METADADOS-APOSTAS] Erro ao executar backfill:",
      error.response?.data || error.message
    );

    return res.status(200).json({
      erro: "Erro ao executar backfill de metadados",
      detalhe: error.response?.data || error.message,
      atualizadas: 0,
      apostas: [],
    });
  }
});

app.get("/normalizar-metadados-apostas", (req, res) => {
  try {
    const apostas = lerApostas();
    const atualizadas = [];

    const mapaTorneios = {
      "miami": "Miami Open",
      "miami open": "Miami Open",
      "indian wells": "Indian Wells",
      "indian wells masters": "Indian Wells",
      "monte carlo": "Monte Carlo Masters",
      "monte carlo masters": "Monte Carlo Masters",
    };

    const mapaSuperficies = {
      "hard": "hard",
      "hardcourt": "hard",
      "clay": "clay",
      "grass": "grass",
      "carpet": "carpet",
    };

    for (const aposta of apostas) {
      let mudou = false;

      if (aposta.tournament) {
        const torneioNorm = normalizarNome(aposta.tournament);
        const torneioPadrao = mapaTorneios[torneioNorm];

        if (torneioPadrao && aposta.tournament !== torneioPadrao) {
          aposta.tournament = torneioPadrao;
          mudou = true;
        }
      }

      if (aposta.surface) {
        const surfaceNorm = normalizarNome(aposta.surface);
        const surfacePadrao = mapaSuperficies[surfaceNorm];

        if (surfacePadrao && aposta.surface !== surfacePadrao) {
          aposta.surface = surfacePadrao;
          mudou = true;
        }
      }

      if (mudou) {
        aposta.updatedAt = new Date().toISOString();
        atualizadas.push({
          id: aposta.id,
          tournament: aposta.tournament || null,
          surface: aposta.surface || null,
        });
      }
    }

    salvarApostas(apostas);

    return res.status(200).json({
      mensagem: "Normalização concluída",
      resumo: {
        totalApostas: apostas.length,
        atualizadas: atualizadas.length,
      },
      apostas: atualizadas,
    });
  } catch (error) {
    console.error(
      "[NORMALIZAR-METADADOS-APOSTAS] Erro ao normalizar:",
      error.message
    );

    return res.status(200).json({
      erro: "Erro ao normalizar metadados",
      detalhe: error.message,
      apostas: [],
    });
  }
});

app.get("/dashboard-apostas", (req, res) => {
  try {
    const {
      status,
      resultado,
      market,
      tournament,
      surface,
      dateFrom,
      dateTo,
      limit = 10,
    } = req.query;

    let apostas = lerApostas().map(atualizarLucroAposta);

    if (status) {
      const statusNorm = normalizarNome(status);
      apostas = apostas.filter(
        (a) => normalizarNome(a.status) === statusNorm
      );
    }

    if (resultado) {
      const resultadoNorm = normalizarNome(resultado);
      apostas = apostas.filter(
        (a) => normalizarNome(a.resultado) === resultadoNorm
      );
    }

    if (market) {
      const marketNorm = normalizarNome(market);
      apostas = apostas.filter(
        (a) => normalizarNome(a.market) === marketNorm
      );
    }

    if (tournament) {
      const tournamentNorm = normalizarNome(tournament);
      apostas = apostas.filter(
        (a) => normalizarNome(a.tournament) === tournamentNorm
      );
    }

    if (surface) {
      const surfaceNorm = normalizarNome(surface);
      apostas = apostas.filter(
        (a) => normalizarNome(a.surface) === surfaceNorm
      );
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
    const pendentes = apostas.filter((a) => a.status !== "finalizada");
    const wins = finalizadas.filter((a) => a.resultado === "win");
    const losses = finalizadas.filter((a) => a.resultado === "loss");
    const voids = finalizadas.filter((a) => a.resultado === "void");

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
            oddMedia: 0,
            roi: 0,
            winRate: 0,
          };
        }

        mapa[chave].totalApostas += 1;
        mapa[chave].stakeTotal += Number(aposta.stake) || 0;
        mapa[chave].oddMedia += Number(aposta.odd) || 0;

        if (aposta.status === "finalizada") {
          mapa[chave].finalizadas += 1;
          mapa[chave].lucroTotal += Number(aposta.lucro) || 0;

          if (aposta.resultado === "win") mapa[chave].wins += 1;
          if (aposta.resultado === "loss") mapa[chave].losses += 1;
          if (aposta.resultado === "void") mapa[chave].voids += 1;
        }
      }

      return Object.values(mapa)
        .map((item) => {
          item.stakeTotal = Number(item.stakeTotal.toFixed(2));
          item.lucroTotal = Number(item.lucroTotal.toFixed(2));
          item.oddMedia =
            item.totalApostas > 0
              ? Number((item.oddMedia / item.totalApostas).toFixed(2))
              : 0;
          item.roi =
            item.stakeTotal > 0
              ? Number(((item.lucroTotal / item.stakeTotal) * 100).toFixed(2))
              : 0;
          item.winRate =
            item.finalizadas > 0
              ? Number(((item.wins / item.finalizadas) * 100).toFixed(2))
              : 0;

          return item;
        })
        .sort((a, b) => b.lucroTotal - a.lucroTotal);
    }

    const totalStake = apostas.reduce(
      (acc, a) => acc + (Number(a.stake) || 0),
      0
    );

    const stakeFinalizado = finalizadas.reduce(
      (acc, a) => acc + (Number(a.stake) || 0),
      0
    );

    const lucroTotal = finalizadas.reduce(
      (acc, a) => acc + (Number(a.lucro) || 0),
      0
    );

    const roi =
      stakeFinalizado > 0
        ? Number(((lucroTotal / stakeFinalizado) * 100).toFixed(2))
        : 0;

    const winRate =
      finalizadas.length > 0
        ? Number(((wins.length / finalizadas.length) * 100).toFixed(2))
        : 0;

    const oddMedia =
      apostas.length > 0
        ? Number(
            (
              apostas.reduce((acc, a) => acc + (Number(a.odd) || 0), 0) /
              apostas.length
            ).toFixed(2)
          )
        : 0;

    const oddMediaWins =
      wins.length > 0
        ? Number(
            (
              wins.reduce((acc, a) => acc + (Number(a.odd) || 0), 0) /
              wins.length
            ).toFixed(2)
          )
        : 0;

    const lucroMedioPorAposta =
      finalizadas.length > 0
        ? Number((lucroTotal / finalizadas.length).toFixed(2))
        : 0;

    const resumo = {
      filtrosAplicados: {
        status: status || null,
        resultado: resultado || null,
        market: market || null,
        tournament: tournament || null,
        surface: surface || null,
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
      },
      totalApostas: apostas.length,
      totalFinalizadas: finalizadas.length,
      totalPendentes: pendentes.length,
      totalWins: wins.length,
      totalLosses: losses.length,
      totalVoids: voids.length,
      totalStake: Number(totalStake.toFixed(2)),
      stakeFinalizado: Number(stakeFinalizado.toFixed(2)),
      lucroTotal: Number(lucroTotal.toFixed(2)),
      roi,
      winRate,
      oddMedia,
      oddMediaWins,
      lucroMedioPorAposta,
    };

    const visaoGeral = {
      totalApostas: apostas.length,
      totalFinalizadas: finalizadas.length,
      totalPendentes: pendentes.length,
      totalWins: wins.length,
      totalLosses: losses.length,
      totalVoids: voids.length,
      stakeTotal: Number(totalStake.toFixed(2)),
      lucroTotal: Number(lucroTotal.toFixed(2)),
      roi,
      winRate,
    };

    const breakdowns = {
      porTorneio: agruparPor(apostas, (a) => a.tournament || "Sem torneio"),
      porSuperficie: agruparPor(apostas, (a) => a.surface || "Sem superfície"),
      porMercado: agruparPor(apostas, (a) => a.market || "Sem mercado"),
      porDia: agruparPor(apostas, (a) => {
        if (!a.createdAt) return "Sem data";
        return new Date(a.createdAt).toISOString().slice(0, 10);
      }),
      porEscolha: agruparPor(apostas, (a) => a.escolha || "Sem escolha"),
      porWinner: agruparPor(finalizadas, (a) => a.winner || "Sem winner"),
    };

    const limite = Math.max(1, Number(limit) || 10);

    const ultimasApostas = [...apostas]
      .sort((a, b) => {
        const dataA = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const dataB = new Date(b.updatedAt || b.createdAt || 0).getTime();
        return dataB - dataA;
      })
      .slice(0, limite);

    const topWinners = [...finalizadas]
      .filter((a) => Number(a.lucro) > 0)
      .sort((a, b) => Number(b.lucro || 0) - Number(a.lucro || 0))
      .slice(0, 5);

    const topLosers = [...finalizadas]
      .filter((a) => Number(a.lucro) < 0)
      .sort((a, b) => Number(a.lucro || 0) - Number(b.lucro || 0))
      .slice(0, 5);

    return res.status(200).json({
      resumo,
      visaoGeral,
      breakdowns,
      ultimasApostas,
      topWinners,
      topLosers,
    });
  } catch (error) {
    console.error("[DASHBOARD-APOSTAS] Erro ao gerar dashboard:", error.message);

    return res.status(200).json({
      erro: "Erro ao gerar dashboard das apostas",
      detalhe: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor BeTennis rodando na porta ${PORT}`);
});

app.listen(PORT, () => {
  console.log(`Servidor BeTennis rodando na porta ${PORT}`);
});