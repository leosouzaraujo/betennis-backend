require("dotenv").config();
const axios = require("axios");

const API_KEY = process.env.API_TENNIS_KEY;

async function pegarJogos() {
  const response = await axios.get("https://api.api-tennis.com/tennis/", {
    params: {
      method: "get_fixtures",
      APIkey: API_KEY,
      date_start: "2026-03-24",
      date_stop: "2026-03-24"
    }
  });

  const jogos = response.data.result || [];

  jogos.forEach(jogo => {
    if (jogo.event_type_type === "Atp Singles") {
      console.log(`${jogo.event_first_player} vs ${jogo.event_second_player}`);
      console.log("Horário:", jogo.event_time);
      console.log("Resultado:", jogo.event_final_result);
      console.log("Torneio:", jogo.tournament_name);
      console.log("------------------------");
    }
  });
}

pegarJogos();