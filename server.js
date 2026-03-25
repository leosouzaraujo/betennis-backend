const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

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

app.get("/", (req, res) => {
  res.json({ status: "BeTennis API rodando 🚀" });
});

app.get("/apostas", (req, res) => {
  const apostas = lerApostas();
  res.json(apostas);
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
    createdAt: new Date().toISOString(),
  };

  apostas.push(novaAposta);
  salvarApostas(apostas);

  res.status(201).json(novaAposta);
});

app.put("/apostas/:id", (req, res) => {
  const { id } = req.params;
  const { status, resultado } = req.body;

  const apostas = lerApostas();
  const index = apostas.findIndex((aposta) => aposta.id === id);

  if (index === -1) {
    return res.status(404).json({ erro: "Aposta não encontrada" });
  }

  if (status) apostas[index].status = status;
  if (resultado) apostas[index].resultado = resultado;

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

app.listen(PORT, () => {
  console.log(`Servidor BeTennis rodando na porta ${PORT}`);
});