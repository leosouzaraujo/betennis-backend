require("dotenv").config();

const axios = require("axios");
const fs = require("fs");
const path = require("path");

const API_KEY = process.env.ODDS_API_KEY;
const BASE_URL = "https://api.the-odds-api.com/v4";

const ARQUIVO_APOSTAS = path.join(__dirname, "apostas.json");
const ARQUIVO_HISTORICO = path.join(__dirname, "historico.json");

if (!API_KEY) {
  throw new Error("API KEY não definida no .env");
}

function lerJson(caminho, valorPadrao = []) {
  if (!fs.existsSync(caminho)) {
    fs.writeFileSync(caminho, JSON.stringify(valorPadrao, null, 2), "utf8");
    return valorPadrao;
  }

  const conteudo = fs.readFileSync(caminho, "utf8").trim();

  if (!conteudo) {
    fs.writeFileSync(caminho, JSON.stringify(valorPadrao, null, 2), "utf8");
    return valorPadrao;
  }

  return JSON.parse(conteudo);
}

function salvarJson(caminho, dados) {
  fs.writeFileSync(caminho, JSON.stringify(dados, null, 2), "utf8");
}

function lerApostas() {
  const apostas = lerJson(ARQUIVO_APOSTAS, []);

  if (!Array.isArray(apostas)) {
    throw new Error("O arquivo apostas.json deve conter um array.");
  }

  return apostas;
}

function lerHistorico() {
  const historico = lerJson(ARQUIVO_HISTORICO, []);

  if (!Array.isArray(historico)) {
    throw new Error("O arquivo historico.json deve conter um array.");
  }

  return historico;
}

function normalizarTexto(valor) {
  if (!valor) return "";

  return String(valor)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sobrenome(nome) {
  const partes = normalizarTexto(nome).split(" ").filter(Boolean);
  return partes.length ? partes[partes.length - 1] : "";
}

function mesmoJogo(aposta, evento) {
  const l1 = sobrenome(aposta.player1);
  const l2 = sobrenome(aposta.player2);

  const a1 = sobrenome(evento.home_team);
  const a2 = sobrenome(evento.away_team);

  if (!l1 || !l2 || !a1 || !a2) return false;

  return (
    (l1 === a1 && l2 === a2) ||
    (l1 === a2 && l2 === a1)
  );
}

function extrairPlacar(evento) {
  if (!Array.isArray(evento.scores)) {
    return {
      scoreHome: null,
      scoreAway: null,
      placarTexto: "N/A"
    };
  }

  const mapa = {};

  for (const item of evento.scores) {
    if (!item?.name) continue;
    mapa[normalizarTexto(item.name)] = item.score;
  }

  const home = evento.home_team || "Home";
  const away = evento.away_team || "Away";

  const scoreHome = mapa[normalizarTexto(home)] ?? null;
  const scoreAway = mapa[normalizarTexto(away)] ?? null;

  return {
    scoreHome,
    scoreAway,
    placarTexto: `${home} ${scoreHome ?? "N/A"} x ${scoreAway ?? "N/A"} ${away}`
  };
}

function descobrirVencedor(evento) {
  const { scoreHome, scoreAway } = extrairPlacar(evento);

  const nHome = Number(scoreHome);
  const nAway = Number(scoreAway);

  if (Number.isNaN(nHome) || Number.isNaN(nAway)) return null;
  if (nHome > nAway) return evento.home_team;
  if (nAway > nHome) return evento.away_team;

  return null;
}

function calcularResultadoAposta(aposta, vencedor) {
  const escolhaNorm = normalizarTexto(aposta.escolha);
  const vencedorNorm = normalizarTexto(vencedor);

  if (!vencedorNorm) {
    return {
      status: "PENDENTE",
      lucro: 0,
      retorno: 0
    };
  }

  if (escolhaNorm === vencedorNorm) {
    const lucro = Number(((aposta.odd - 1) * aposta.stake).toFixed(2));
    const retorno = Number((aposta.odd * aposta.stake).toFixed(2));

    return {
      status: "GREEN",
      lucro,
      retorno
    };
  }

  return {
    status: "RED",
    lucro: Number((-aposta.stake).toFixed(2)),
    retorno: 0
  };
}

function gerarIdAposta(aposta) {
  return [
    normalizarTexto(aposta.player1),
    normalizarTexto(aposta.player2),
    normalizarTexto(aposta.escolha),
    aposta.odd,
    aposta.stake
  ].join("|");
}

async function buscarSportsDeTenis() {
  const response = await axios.get(`${BASE_URL}/sports/?apiKey=${API_KEY}`);
  const sports = response.data;

  if (!Array.isArray(sports)) {
    throw new Error("Resposta inesperada ao buscar esportes.");
  }

  return sports
    .filter((sport) => sport.active && String(sport.key).startsWith("tennis_"))
    .map((sport) => ({
      key: sport.key,
      title: sport.title
    }));
}

async function buscarResultadosPorSport(sportKey, daysFrom = 3) {
  const response = await axios.get(
    `${BASE_URL}/sports/${sportKey}/scores/?apiKey=${API_KEY}&daysFrom=${daysFrom}&dateFormat=iso`
  );

  return Array.isArray(response.data) ? response.data : [];
}

async function validarResultados() {
  try {
    const apostasSalvas = lerApostas();
    const historicoAtual = lerHistorico();
    const sportsTenis = await buscarSportsDeTenis();

    if (!sportsTenis.length) {
      console.log("Nenhum torneio de tênis ativo encontrado.");
      return;
    }

    const todosEventos = [];

    for (const sport of sportsTenis) {
      try {
        const eventos = await buscarResultadosPorSport(sport.key, 3);

        for (const evento of eventos) {
          todosEventos.push({
            ...evento,
            _sport_key: sport.key,
            _sport_title: sport.title
          });
        }
      } catch (error) {
        console.log(`Falha ao consultar ${sport.key}: ${error.response?.data?.message || error.message}`);
      }
    }

    const mapaHistorico = new Map(
      historicoAtual.map((item) => [item.idAposta, item])
    );

    let totalStake = 0;
    let totalLucro = 0;
    let greens = 0;
    let reds = 0;
    let pendentes = 0;

    console.log("RESULTADO DAS APOSTAS");
    console.log("==================================================");

    for (const aposta of apostasSalvas) {
      totalStake += aposta.stake;

      const evento = todosEventos.find((ev) => mesmoJogo(aposta, ev));
      const idAposta = gerarIdAposta(aposta);

      let registro = {
        idAposta,
        player1: aposta.player1,
        player2: aposta.player2,
        escolha: aposta.escolha,
        odd: aposta.odd,
        stake: aposta.stake,
        torneio: null,
        commence_time: null,
        placar: "N/A",
        vencedor: null,
        status: "PENDENTE",
        lucro: 0,
        retorno: 0,
        atualizadoEm: new Date().toISOString()
      };

      if (!evento) {
        pendentes++;

        const anterior = mapaHistorico.get(idAposta);
        if (anterior && anterior.status !== "PENDENTE") {
          registro = anterior;
        }

        mapaHistorico.set(idAposta, registro);

        console.log(`Jogo não encontrado: ${aposta.player1} vs ${aposta.player2}`);
        console.log(`Escolha: ${aposta.escolha} | Odd: ${aposta.odd} | Stake: ${aposta.stake}`);
        console.log(`Status: ${registro.status}`);
        console.log("--------------------------------------------------");
        continue;
      }

      const { placarTexto } = extrairPlacar(evento);

      registro.torneio = evento._sport_title;
      registro.commence_time = evento.commence_time || null;
      registro.placar = placarTexto;

      if (!evento.completed) {
        pendentes++;

        const anterior = mapaHistorico.get(idAposta);
        if (anterior && anterior.status !== "PENDENTE") {
          registro = anterior;
        } else {
          mapaHistorico.set(idAposta, registro);
        }

        console.log(`Jogo: ${aposta.player1} vs ${aposta.player2}`);
        console.log(`Torneio: ${registro.torneio}`);
        console.log(`Escolha: ${aposta.escolha} | Odd: ${aposta.odd} | Stake: ${aposta.stake}`);
        console.log(`Início: ${registro.commence_time || "N/A"}`);
        console.log(`Placar: ${registro.placar}`);
        console.log(`Status: ${registro.status}`);
        console.log("--------------------------------------------------");
        continue;
      }

      const vencedor = descobrirVencedor(evento);
      const resultado = calcularResultadoAposta(aposta, vencedor);

      registro.vencedor = vencedor;
      registro.status = resultado.status;
      registro.lucro = resultado.lucro;
      registro.retorno = resultado.retorno;
      registro.atualizadoEm = new Date().toISOString();

      mapaHistorico.set(idAposta, registro);

      totalLucro += resultado.lucro;

      if (resultado.status === "GREEN") greens++;
      else if (resultado.status === "RED") reds++;
      else pendentes++;

      console.log(`Jogo: ${aposta.player1} vs ${aposta.player2}`);
      console.log(`Torneio: ${registro.torneio}`);
      console.log(`Escolha: ${aposta.escolha} | Odd: ${aposta.odd} | Stake: ${aposta.stake}`);
      console.log(`Placar: ${registro.placar}`);
      console.log(`Vencedor: ${registro.vencedor || "N/A"}`);
      console.log(`Status: ${registro.status}`);
      console.log(`Lucro: ${registro.lucro}`);
      console.log("--------------------------------------------------");
    }

    const historicoFinal = Array.from(mapaHistorico.values());
    salvarJson(ARQUIVO_HISTORICO, historicoFinal);

    const concluidas = historicoFinal.filter((item) => item.status !== "PENDENTE");
    const stakeConcluido = concluidas.reduce((acc, item) => acc + Number(item.stake || 0), 0);
    const lucroConcluido = concluidas.reduce((acc, item) => acc + Number(item.lucro || 0), 0);
    const roi = stakeConcluido > 0
      ? Number(((lucroConcluido / stakeConcluido) * 100).toFixed(2))
      : 0;

    console.log("RESUMO FINAL");
    console.log("==================================================");
    console.log(`Total apostado: ${totalStake}`);
    console.log(`Lucro total realizado: ${lucroConcluido}`);
    console.log(`ROI realizado: ${roi}%`);
    console.log(`Greens: ${greens}`);
    console.log(`Reds: ${reds}`);
    console.log(`Pendentes: ${pendentes}`);
    console.log("Histórico salvo em historico.json");
  } catch (error) {
    console.error("Erro ao validar resultados:");
    console.error(error.message);
  }
}

validarResultados();