const axios = require("axios");
const fs = require("fs");

function nivelConfianca(ev) {
  const evPercentual = ev * 100;

  if (evPercentual > 10) return "Alta";
  if (evPercentual > 5) return "Media";
  if (evPercentual > 3) return "Baixa";
  return "Sem confianca";
}

function definirStake(ev, odd) {
  const evPercentual = ev * 100;
  let stake = 0;

  if (evPercentual > 10) stake = 3;
  else if (evPercentual > 5) stake = 2;
  else if (evPercentual > 3) stake = 1;

  if (odd > 4) {
    stake = Math.min(stake, 1);
  } else if (odd > 2) {
    stake = Math.min(stake, 2);
  }

  return stake;
}

function oddValida(odd) {
  return odd >= 1.5 && odd <= 6.0;
}

async function pegarOdds() {
  const response = await axios.get("https://api.the-odds-api.com/v4/sports/tennis/odds", {
    params: {
      apiKey: "7455145cb11dcc1f07e7e30d59f5eca5",
      regions: "eu",
      markets: "h2h"
    }
  });

  const jogos = response.data;

  let entradas = [];

  jogos.forEach(jogo => {
    const betfair = jogo.bookmakers.find(casa => casa.key === "betfair_ex_eu");
    if (!betfair) return;

    const mercado = betfair.markets.find(m => m.key === "h2h");
    if (!mercado || mercado.outcomes.length !== 2) return;

    const jogador1 = mercado.outcomes[0];
    const jogador2 = mercado.outcomes[1];

    const prob1 = 1 / jogador1.price;
    const prob2 = 1 / jogador2.price;
    const soma = prob1 + prob2;

    const prob1Justa = (prob1 / soma) * 100;
    const prob2Justa = (prob2 / soma) * 100;

    let minhaProb1 = prob1Justa;
    let minhaProb2 = prob2Justa;

    if (jogador1.price > jogador2.price) {
      minhaProb1 = prob1Justa + 3;
      minhaProb2 = prob2Justa - 3;
    } else {
      minhaProb1 = prob1Justa - 3;
      minhaProb2 = prob2Justa + 3;
    }

    const ev1 = (minhaProb1 / 100) * jogador1.price - 1;
    const ev2 = (minhaProb2 / 100) * jogador2.price - 1;

    if (ev1 > 0.03 && oddValida(jogador1.price)) {
      entradas.push({
        jogo: jogo.home_team + " vs " + jogo.away_team,
        jogador: jogador1.name,
        odd: jogador1.price,
        prob_modelo: minhaProb1,
        ev: ev1,
        confianca: nivelConfianca(ev1),
        stake: definirStake(ev1, jogador1.price),
        data: new Date().toISOString()
      });
    }

    if (ev2 > 0.03 && oddValida(jogador2.price)) {
      entradas.push({
        jogo: jogo.home_team + " vs " + jogo.away_team,
        jogador: jogador2.name,
        odd: jogador2.price,
        prob_modelo: minhaProb2,
        ev: ev2,
        confianca: nivelConfianca(ev2),
        stake: definirStake(ev2, jogador2.price),
        data: new Date().toISOString()
      });
    }
  });

  fs.writeFileSync("entradas.json", JSON.stringify(entradas, null, 2));

  console.log("Entradas salvas com sucesso 🚀");
}

pegarOdds();