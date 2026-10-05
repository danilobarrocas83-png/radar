#!/usr/bin/env node
/* le_banco.js — copia o ESTADO das marcações do time (tabela "atividade" do Supabase) para
   pool/atividade.tsv. A rotina da madrugada roda num ambiente que não alcança o banco; é por
   este arquivo que ela sabe quais leads ainda não receberam a primeira mensagem.

   Roda no GitHub Actions (.github/workflows/estado-banco.yml). No banco, só leitura.
   Vão para o arquivo apenas: id do lead, id do vendedor, status e data da última marcação,
   e só dos leads que estão no radar.html. Nada de anotação, telefone ou e-mail.

   Uso: node scripts/le_banco.js [--html radar.html] [--saida pool/atividade.tsv]
   Saída 0 = gravou. Saída 1 = não conseguiu ler (o arquivo anterior fica como estava). */
"use strict";
const fs = require("fs");
const R = require("./radar_fila.js");

const a = { html: "radar.html", saida: "pool/atividade.tsv" };
const v = process.argv.slice(2);
for (let i = 0; i + 1 < v.length; i += 2) a[v[i].replace(/^--/, "")] = v[i + 1];

const html = fs.readFileSync(a.html, "utf8");
const ids = {};
R.extraiVar(html, "LEADS_EMBUTIDOS").valor.forEach((l) => { ids[l.id] = 1; });
const banco = R.bancoDoHtml(html);

R.lerAtividade(fetch, banco.base, banco.chaves).then((linhas) => {
  if (!linhas.length) throw new Error("o banco respondeu sem nenhuma linha; nao vou gravar um estado vazio");
  const agora = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const t = R.tsvAtividade(linhas, ids, agora);
  fs.writeFileSync(a.saida, t.texto);
  console.log("OK: " + t.linhas + " marcacoes de leads que estao no radar (de " + linhas.length + " no banco), gerado em " + agora);
}).catch((e) => {
  console.log("ERRO: nao consegui ler o banco: " + e.message);
  process.exit(1);
});
